import { Multiplayer } from '../multiplayer';

/**
 * ROUND 95/97/98/99 — ITEM-USE INDICATOR (DOM overlay).
 *
 * When the LOCAL player uses a consumable we emit `itemUse`; every other client
 * shows the single-player "吃东西" visual above that player's head. The native
 * sc.FoodIconEntity proved unreliable inside the heavily-injected multiplayer
 * entity pipeline (it spawned, but its sprite scale/timer/render path never made
 * it visible). This module now draws the EXACT SAME two textures as a DOM
 * overlay — the food sprite sheet (`media/entity/player/item-hold.png`) and the
 * bubble sprite (`media/entity/map-gui/hit-numbers.png`, src 0,288) — positioned
 * every frame via the same map->screen projection the name tags use. HOLD ->
 * BUBBLE -> DONE timing mirrors the native consume action.
 */

let getMain: () => Multiplayer | undefined = () => undefined;

interface IPop {
    player: string;
    root: HTMLElement;
    food: HTMLElement;
    bubble: HTMLElement;
    coll: any;          // target mirror's coll
    until: number;
    bubbleAt: number;
    doneAt: number;
}

interface IPending {
    player: string;
    item: string | number;
    until: number;
}

let installed = false;
let live: IPop[] = [];
let pending: IPending[] = [];
let lastLogAt = 0;

const POP_MS = 1400;    // total lifetime
const BUBBLE_AT = 200;  // bubble pops in after 200ms
const DONE_AT = 850;    // icon shrinks/fades out from 850ms

const scratch: { x: number, y: number } = { x: 0, y: 0 };

function log(msg: string): void {
    try {
        const now = Date.now();
        if (now - lastLogAt > 1000) {
            lastLogAt = now;
            console.log('[multiplayer][itemUse] ' + msg);
        }
    } catch (_) { /* never break from logging */ }
}

function ensureStyle(): void {
    if (document.getElementById('mpFoodIconStyle')) return;
    const style = document.createElement('style');
    style.id = 'mpFoodIconStyle';
    style.textContent = `
.mpFoodIconPop {
    position: fixed; left: 0; top: 0;
    width: 24px; height: 48px;
    z-index: 1200; pointer-events: none;
    will-change: transform, opacity;
}
.mpFoodIconBubble {
    position: absolute; left: 0; bottom: 0;
    width: 24px; height: 32px;
    background-image: url('media/entity/map-gui/hit-numbers.png');
    background-repeat: no-repeat;
    background-position: 0 -288px;
    opacity: 0;
    transform: scale(0);
    transition: transform 0.12s ease-out, opacity 0.08s ease-out;
}
.mpFoodIconFood {
    position: absolute; left: 4px; bottom: 14px;
    width: 16px; height: 16px;
    background-image: url('media/entity/player/item-hold.png');
    background-repeat: no-repeat;
    transform: scale(0);
    transition: transform 0.12s ease-out, opacity 0.2s ease-out;
}
.mpFoodIconPop.show .mpFoodIconFood { transform: scale(1); }
.mpFoodIconPop.bubble .mpFoodIconFood { bottom: 24px; }
.mpFoodIconPop.bubble .mpFoodIconBubble { opacity: 0.8; transform: scale(1); }
.mpFoodIconPop.done .mpFoodIconBubble { opacity: 0; transform: scale(0.6); }
.mpFoodIconPop.done .mpFoodIconFood { opacity: 0; transform: scale(0.6); }
`;
    document.head.appendChild(style);
}

function removePop(pop: IPop): void {
    const idx = live.indexOf(pop);
    if (idx !== -1) live.splice(idx, 1);
    try { if (pop.root && pop.root.parentNode) pop.root.parentNode.removeChild(pop.root); } catch (_) { /* ignore */ }
}

function findMirrorColl(player: string): any {
    const main = getMain();
    if (main) {
        const p = main.players[player];
        const ent = p && p.entity;
        if (ent && ent.coll && !ent._killed) return ent.coll;
    }
    try {
        const g: any = (ig as any).game;
        if (g && Array.isArray(g.entities)) {
            for (const e of g.entities) {
                if (e && !e._killed && e.coll && e._mpMirror && e.name === player) return e.coll;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
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

/** Returns the pixel src offset in the food sheet for the given FOOD_SPRITE icon. */
function foodTile(icon: number): { x: number, y: number } {
    try {
        const C: any = (sc as any).FoodIconEntity;
        const sheet = C && C.prototype && C.prototype.foodSheet;
        if (sheet && typeof sheet.getTileSrc === 'function') {
            const out: any = { x: 0, y: 0 };
            sheet.getTileSrc(out, icon);
            if (typeof out.x === 'number' && typeof out.y === 'number') return { x: out.x, y: out.y };
        }
    } catch (_) { /* fall through */ }
    return { x: 0, y: 0 };
}

function positionPop(pop: IPop): void {
    try {
        const c = pop.coll;
        if (!c) return;
        const cx = c.pos.x + c.size.x / 2;
        const cy = c.pos.y - c.pos.z - c.size.z + c.size.y / 2;
        (ig as any).system.getScreenFromMapPos(scratch, Math.round(cx), Math.round(cy));
        pop.root.style.left = Math.round(scratch.x - 12) + 'px';
        pop.root.style.top = Math.round(scratch.y - 44) + 'px';
    } catch (_) { /* ignore */ }
}

/** Spawn the DOM HOLD icon. Returns true when shown, false when the mirror isn't
 * available yet (the caller queues a short retry). */
function tryShowItemUse(player: string, item: string | number): boolean {
    const main = getMain();
    if (!player || item === undefined || item === null) return true;
    if (!main || player === main.name) return true;

    const coll = findMirrorColl(player);
    if (!coll) {
        log('no mirror coll yet for ' + player + ' — queued');
        return false;
    }

    const foodName = foodNameOf(item);
    const table: any = (sc as any).FOOD_SPRITE;
    const icon = table && typeof table[foodName] === 'number' ? table[foodName] : 0;
    const src = foodTile(icon);

    // One pop per player at a time.
    for (const old of live.slice()) {
        if (old.player === player) removePop(old);
    }

    ensureStyle();
    const root = document.createElement('div');
    root.className = 'mpFoodIconPop show';

    const bubble = document.createElement('div');
    bubble.className = 'mpFoodIconBubble';
    const food = document.createElement('div');
    food.className = 'mpFoodIconFood';
    food.style.backgroundPosition = (-src.x) + 'px ' + (-src.y) + 'px';

    root.appendChild(bubble);
    root.appendChild(food);
    document.body.appendChild(root);

    const now = Date.now();
    const pop: IPop = {
        player,
        root,
        food,
        bubble,
        coll,
        until: now + POP_MS,
        bubbleAt: now + BUBBLE_AT,
        doneAt: now + DONE_AT,
    };
    live.push(pop);
    positionPop(pop);
    log('created DOM food icon for ' + player + ' item=' + item + ' sprite=' + foodName);
    return true;
}

function updatePops(now: number): void {
    for (let i = live.length - 1; i >= 0; i--) {
        const pop = live[i];
        if (!pop || now >= pop.until) {
            if (pop) removePop(pop);
            continue;
        }
        if (!pop.bubble.classList.contains('bubble') && now >= pop.bubbleAt) {
            pop.bubble.classList.add('bubble');
        }
        if (now >= pop.doneAt) {
            pop.root.classList.add('done');
        }
        positionPop(pop);
    }
}

/** A remote player used an item — pop the single-player food icon above their
 * head (DOM overlay with the SAME texture now). */
export function showItemUse(player: string, item: string | number): void {
    try {
        if (!tryShowItemUse(player, item)) {
            pending.push({ player, item, until: Date.now() + 1500 });
        }
    } catch (_) { /* an indicator must never break the frame */ }
}

/** Drop every live indicator + pending spawn (logout / server loss / map cleanup). */
export function clearItemUseIndicators(): void {
    for (const pop of live.slice()) removePop(pop);
    live = [];
    pending = [];
}

/**
 * Install once per process: wraps sc.PlayerModel.useItem so a SUCCESSFUL local
 * item use is announced to the instance, and runs a tiny per-frame pump that
 * keeps the DOM icons glued to the remote player's head.
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

                for (let i = pending.length - 1; i >= 0; i--) {
                    const p = pending[i];
                    if (now >= p.until || tryShowItemUse(p.player, p.item)) pending.splice(i, 1);
                }

                updatePops(now);
            });
        }
    } catch (_) { /* ignore */ }
}