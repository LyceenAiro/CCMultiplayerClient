import { Multiplayer } from '../multiplayer';

/**
 * ROUND 95/97/98 — ITEM-USE INDICATOR.
 *
 * When the LOCAL player uses a consumable (sc.PlayerModel.useItem returns true)
 * we emit `itemUse` to the server, which relays it to every other player in the
 * same map instance.
 *
 * Receivers spawn the SAME entity the single-player item animation uses:
 * sc.FoodIconEntity (the "吃东西" icon above the player's head — HOLD -> BUBBLE
 * -> DONE pop sequence). It is a real game entity attached to the remote
 * player's mirror, so it tracks their head exactly and needs no DOM/GUI overlay.
 * The item's `foodSprite` drives the icon index, with the vanilla "SANDWICH"
 * fallback — identical to sc.ItemConsumption.getAction.
 *
 * A small pending queue retries for 1.5s when the remote mirror hasn't been
 * spawned yet at event time (item-come-in-while-entering race), and a throttled
 * console log tells the session window when an indicator spawns/skips so the
 * event path can be verified in the field.
 */

let getMain: () => Multiplayer | undefined = () => undefined;

interface IIcon {
    player: string;
    entity: any;      // spawned sc.FoodIconEntity
    coll: any;        // target mirror's coll (the stand-in follows this too)
    until: number;
}

interface IPending {
    player: string;
    item: string | number;
    until: number;
}

let installed = false;
let live: IIcon[] = [];
let pending: IPending[] = [];
let lastLogAt = 0;

function killIcon(ic: IIcon): void {
    const idx = live.indexOf(ic);
    if (idx !== -1) live.splice(idx, 1);
    try { if (ic.entity && !ic.entity._killed) ic.entity.kill(); } catch (_) { /* ignore */ }
}

/** Find the live mirror entity for a remote player (main.players first, then a
 * fallback scan over the entity list for a tagged mirror). */
function findMirror(player: string): any {
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

function log(msg: string): void {
    try {
        const now = Date.now();
        if (now - lastLogAt > 1000) {
            lastLogAt = now;
            console.log('[multiplayer][itemUse] ' + msg);
        }
    } catch (_) { /* never break from logging */ }
}

/** Spawn the FoodIconEntity above `player`'s mirror. Returns true when the
 * indicator was spawned (or an existing one was replaced); false when the
 * mirror/entity isn't available yet and the caller should retry shortly. */
function tryShowItemUse(player: string, item: string | number): boolean {
    if (!player || item === undefined || item === null) return true; // drop invalid, no retry
    const main = getMain();
    if (!main || player === main.name) return true; // own use is already visible locally

    const ent = findMirror(player);
    if (!ent) {
        log('no mirror yet for ' + player + ' — queued');
        return false;
    }

    // FoodIconEntity attaches itself to the target's action-attached list and
    // kills itself when the target's current action is cleared. That is correct
    // for the EATING player (the food icon lives inside the consume action), but
    // on an observer the remote MIRROR's action is replaced every time the
    // playerState animation changes (playAnim -> setAction -> clearActionAttached),
    // so a directly-attached FoodIcon was killed before it could be seen.
    // Give FoodIcon a lightweight stand-in that still points at the mirror's coll
    // (so it follows the head) but has no action-attached lifecycle.
    const standIn: any = {
        coll: ent.coll,
        addActionAttached: (): void => { /* intentionally unattached */ },
        removeActionAttached: (): boolean => true,
    };

    const FoodIcon: any = (sc as any).FoodIconEntity;
    if (!FoodIcon) {
        log('sc.FoodIconEntity missing');
        return true;
    }

    let foodName = 'SANDWICH';
    try {
        const inv: any = (sc as any).inventory;
        if (inv && typeof inv.getItem === 'function') {
            const def = inv.getItem(item);
            foodName = (def && def.foodSprite) || 'SANDWICH';
        }
    } catch (_) { /* fall back to the default sandwich sprite */ }
    const table: any = (sc as any).FOOD_SPRITE;
    const icon = table && typeof table[foodName] === 'number' ? table[foodName] : 0;

    // One icon per player at a time (rapid item spam replaces, never stacks).
    for (const old of live.slice()) {
        if (old.player === player) killIcon(old);
    }

    const fx: any = (ig as any).game.spawnEntity(FoodIcon, 0, 0, 0, { icon, combatant: standIn });
    if (!fx) {
        log('spawn failed for ' + player);
        return false; // retry — a null spawn is usually a one-frame fluke
    }
    // Force the renderer to never cull the icon (its coll starts at 0,0,0 until
    // the first deferredUpdate / our manual per-frame position below).
    try { fx.coll.alwaysRender = true; } catch (_) { /* ignore */ }
    // Full scale from the very first frame (see the per-frame pump below).
    try { fx.timer = 0; } catch (_) { /* ignore */ }
    // Belt-and-braces: make sure the freshly spawned icon is actually shown.
    try { (fx as any).show(); } catch (_) { /* ignore */ }

    const ic: IIcon = { player, entity: fx, coll: ent.coll, until: Date.now() + 1500 };
    live.push(ic);
    log('spawned food icon for ' + player + ' item=' + item + ' sprite=' + foodName);

    const states: any = (sc as any).FOOD_ICON_STATE || { HOLD: 0, BUBBLE: 1, DONE: 2 };
    window.setTimeout(() => {
        try { if (fx && !fx._killed) fx.setState(states.BUBBLE); } catch (_) { /* ignore */ }
    }, 220);
    window.setTimeout(() => {
        try { if (fx && !fx._killed) fx.setState(states.DONE); } catch (_) { /* ignore */ }
    }, 900);
    window.setTimeout(() => killIcon(ic), 1500);
    return true;
}

/** A remote player used an item — pop the exact single-player food icon above
 * their head. Queues the spawn briefly when the mirror isn't there yet. */
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
 * Install once per process: wraps sc.PlayerModel.useItem so a SUCCESSFUL local
 * item use is announced to the instance. Also runs a tiny per-frame pump that
 * retries queued remote indicators until the remote mirror exists.
 */
export function installItemUseIndicators(gm: () => Multiplayer | undefined): void {
    getMain = gm;
    if (installed) return;
    installed = true;

    try {
        const PM: any = (sc as any).PlayerModel;
        if (PM && PM.prototype && typeof PM.prototype.useItem === 'function' && !PM.prototype._mpItemUseWrapped) {
            PM.prototype._mpItemUseWrapped = true;
            const orig = PM.prototype.useItem;
            PM.prototype.useItem = function (this: any, id: number): boolean {
                const ok = orig.apply(this, arguments);
                try {
                    if (ok) {
                        const m = getMain();
                        const conn = m && m.connection;
                        if (conn && typeof conn.isOpen === 'function' && conn.isOpen()
                            && typeof conn.itemUse === 'function') {
                            conn.itemUse(id);
                            log('emitted itemUse for local item ' + id);
                        } else {
                            log('itemUse NOT emitted (conn missing/closed/method absent)');
                        }
                    }
                } catch (_) { /* a sync failure must never break item use */ }
                return ok;
            };
        }
    } catch (_) { /* the hook must never break the model */ }

    try {
        const s: any = (window as any).simplify;
        if (s && typeof s.registerUpdate === 'function') {
            s.registerUpdate(() => {
                const now = Date.now();

                // Retry queued spawns until the mirror exists.
                for (let i = pending.length - 1; i >= 0; i--) {
                    const p = pending[i];
                    if (now >= p.until || tryShowItemUse(p.player, p.item)) pending.splice(i, 1);
                }

                // Keep live icons glued to their mirror + expire them. This manual
                // per-frame setPos makes the icon independent of FoodIconEntity's
                // own deferredUpdate pipeline (culling/deferred ordering can differ
                // in the modded engine; alwaysRender is set at spawn too).
                for (let i = live.length - 1; i >= 0; i--) {
                    const ic = live[i];
                    if (!ic || !ic.entity) { live.splice(i, 1); continue; }
                    if (ic.entity._killed || now >= ic.until) { killIcon(ic); continue; }
                    try {
                        if (ic.coll) {
                            const x = ic.coll.pos.x + ic.coll.size.x / 2;
                            const y = ic.coll.pos.y + ic.coll.size.y;
                            const z = ic.coll.pos.z;
                            ic.entity.setPos(x, y, z);
                        }
                        // FoodIconEntity's sprite scale derives from `timer` (0 => full
                        // scale for HOLD/BUBBLE). Force it to 0 every frame so the icon
                        // is ALWAYS fully visible, even if the entity's deferredUpdate
                        // (which normally decrements it) didn't run for any reason.
                        try { if (ic.entity.timer > 0 && ic.entity.state !== 2) ic.entity.timer = 0; } catch (_) { /* ignore */ }
                    } catch (_) { /* ignore */ }
                }
            });
        }
    } catch (_) { /* ignore */ }
}