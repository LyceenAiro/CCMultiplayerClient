import { Multiplayer } from '../multiplayer';

/**
 * ROUND 95/97/98/99/101/102 — ITEM-USE INDICATOR (native FoodIconEntity).
 *
 * The previous versions all fired too late or drove the visual manually. This
 * version hooks ig.ENTITY.Player.prototype.useItem — the START of the native
 * consume action (before SHOW_FOOD_ICON runs on the EATING client) — and emits
 * `itemUse` immediately. Every observing client then spawns the OFFICIAL
 * sc.FoodIconEntity attached to that player's mirror. Its own deferredUpdate
 * follows the mirror's coll and its own timer/updateSprites produce the native
 * grow-in animation, so the icon moves fluidly with the remote player's eating
 * action instead of popping in after it ends.
 *
 * BUBBLE/DONE timing is driven by the mirror's actual animation stream:
 *   - HOLD while the eater enters itemFetch/itemHold
 *   - BUBBLE when the mirror reaches itemEatFast / itemEatSlow / itemEatFastest
 *   - DONE when the mirror reaches itemEffect
 * Wall-clock fallbacks (700ms / 1200ms) cover any missed animation edge.
 *
 * The one multiplayer-specific patch: for REMOTE icons we replace the spawned
 * FoodIconEntity's own `onActionEndDetach` with a no-op. The mirror's
 * `setAction` (used by the network animation sync) calls clearActionAttached(),
 * which would otherwise kill the food icon as soon as the next animation sync
 * arrived. Its self-cleanup at DONE is untouched (deferredUpdate calls kill()
 * directly), so no leak.
 */

let getMain: () => Multiplayer | undefined = () => undefined;

interface ILiveIcon {
    player: string;
    fx: any;          // spawned sc.FoodIconEntity
    spawnedAt: number;
    bubbleFallbackAt: number;
    doneFallbackAt: number;
    killAt: number;
}

interface IPending {
    player: string;
    item: string | number;
    until: number;
}

let installed = false;
let live: ILiveIcon[] = [];
let pending: IPending[] = [];
let lastLogAt = 0;

const EAT_ANIMS: { [anim: string]: boolean } = {
    itemEatFast: true,
    itemEatSlow: true,
    itemEatFastest: true,
};

function log(msg: string): void {
    try {
        const now = Date.now();
        if (now - lastLogAt > 1000) {
            lastLogAt = now;
            console.log('[multiplayer][itemUse] ' + msg);
        }
    } catch (_) { /* ignore */ }
}

function foodNameOf(item: string | number): string {
    try {
        const inv: any = (sc as any).inventory;
        if (inv && typeof inv.getItem === 'function') {
            const def = inv.getItem(item);
            return (def && def.foodSprite) || 'SANDWICH';
        }
    } catch (_) { /* fall through */ }
    return 'SANDWICH';
}

function findMirrorEntity(player: string): any {
    const main = getMain();
    if (main) {
        const p = main.players[player];
        const ent = p && p.entity;
        if (ent && ent.coll && !ent._killed) return ent;
    }
    try {
        const g: any = (ig as any).game;
        if (g && Array.isArray(g.entities)) {
            for (const e of g.entities) {
                if (e && !e._killed && e.coll && e._mpMirror && e.name === player) return e;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

function killIcon(ic: ILiveIcon): void {
    const idx = live.indexOf(ic);
    if (idx !== -1) live.splice(idx, 1);
    try { if (ic.fx && !ic.fx._killed) ic.fx.kill(); } catch (_) { /* ignore */ }
}

/** Spawn the OFFICIAL FoodIconEntity attached to the remote mirror. */
function tryShowItemUse(player: string, item: string | number): boolean {
    const main = getMain();
    if (!player || item === undefined || item === null) return true;
    if (!main || player === main.name) return true;

    const ent = findMirrorEntity(player);
    if (!ent) {
        log('no mirror yet for ' + player + ' — queued');
        return false;
    }

    const FoodIcon: any = (sc as any).FoodIconEntity;
    if (!FoodIcon) {
        log('sc.FoodIconEntity missing');
        return true;
    }
    const foodName = foodNameOf(item);
    const table: any = (sc as any).FOOD_SPRITE;
    const icon = table && typeof table[foodName] === 'number' ? table[foodName] : 0;

    // One native food icon per player at a time.
    for (const old of live.slice()) {
        if (old.player === player) killIcon(old);
    }

    const fx: any = (ig as any).game.spawnEntity(FoodIcon, 0, 0, 0, { icon, combatant: ent });
    if (!fx) {
        log('spawn failed for ' + player);
        return false;
    }

    // Network animation sync replaces the mirror's action frequently; for a
    // LOCAL food icon that action is the consume action itself and the icon is
    // allowed to die with it. For this REMOTE replay, clearActionAttached must
    // not take the icon with it — its DONE state still kills it directly.
    try { fx.onActionEndDetach = function (): void { /* remote replay: never die on action swaps */ }; } catch (_) { /* ignore */ }

    const now = Date.now();
    live.push({ player, fx, spawnedAt: now, bubbleFallbackAt: now + 700, doneFallbackAt: now + 1200, killAt: now + 1800 });
    log('spawned native FoodIconEntity for ' + player + ' item=' + item + ' sprite=' + foodName);
    return true;
}

function updateLive(now: number): void {
    for (let i = live.length - 1; i >= 0; i--) {
        const ic = live[i];
        if (!ic || !ic.fx || ic.fx._killed || now >= ic.killAt) {
            killIcon(ic);
            continue;
        }
        try {
            const fx = ic.fx;
            const ent = fx.combatant;
            const states: any = (sc as any).FOOD_ICON_STATE || { HOLD: 0, BUBBLE: 1, DONE: 2 };
            if (ent && typeof ent.currentAnim === 'string') {
                if (fx.state === states.HOLD && EAT_ANIMS[ent.currentAnim]) {
                    fx.setState(states.BUBBLE);
                } else if (fx.state === states.BUBBLE && ent.currentAnim === 'itemEffect') {
                    fx.setState(states.DONE);
                }
            }
            // Wall-clock fallbacks for missed animation edges.
            if (fx.state === states.HOLD && now >= ic.bubbleFallbackAt) {
                fx.setState(states.BUBBLE);
            } else if (fx.state === states.BUBBLE && now >= ic.doneFallbackAt) {
                fx.setState(states.DONE);
            }
        } catch (_) { /* ignore */ }
    }
}

/** A remote player STARTED the consume action — pop their native food icon. */
export function showItemUse(player: string, item: string | number): void {
    try {
        if (!tryShowItemUse(player, item)) {
            pending.push({ player, item, until: Date.now() + 1500 });
        }
    } catch (_) { /* an indicator must never break the frame */ }
}

/** Drop every live indicator + pending spawn (logout / server loss / map cleanup). */
export function clearItemUseIndicators(): void {
    for (const ic of live.slice()) killIcon(ic);
    live = [];
    pending = [];
}

/**
 * Install once per process. We hook the START of the item-use action
 * (ig.ENTITY.Player.prototype.useItem — the quick-menu / menu entry point)
 * instead of the END (PlayerModel.useItem fires after the consume animation),
 * which was why the previous builds popped the icon after eating finished.
 */
export function installItemUseIndicators(gm: () => Multiplayer | undefined): void {
    getMain = gm;
    if (installed) return;
    installed = true;

    try {
        const P: any = (ig as any).ENTITY && (ig as any).ENTITY.Player;
        if (P && P.prototype && typeof P.prototype.useItem === 'function' && !P.prototype._mpUseItemWrapped) {
            P.prototype._mpUseItemWrapped = true;
            const orig = P.prototype.useItem;
            P.prototype.useItem = function (this: any, itemId: any): void {
                try {
                    if (this === (ig as any).game.playerEntity) {
                        const m = getMain();
                        const conn = m && m.connection;
                        if (conn && typeof conn.isOpen === 'function' && conn.isOpen()
                            && typeof conn.itemUse === 'function') {
                            conn.itemUse(itemId);
                            log('emitted itemUse (action start) for local item ' + itemId);
                        }
                    }
                } catch (_) { /* a sync failure must never break item use */ }
                return orig.apply(this, arguments as any);
            };
        }
    } catch (_) { /* the hook must never break the player */ }

    try {
        const s: any = (window as any).simplify;
        if (s && typeof s.registerUpdate === 'function') {
            s.registerUpdate(() => {
                const now = Date.now();
                for (let i = pending.length - 1; i >= 0; i--) {
                    const p = pending[i];
                    if (now >= p.until || tryShowItemUse(p.player, p.item)) pending.splice(i, 1);
                }
                updateLive(now);
            });
        }
    } catch (_) { /* ignore */ }
}