import { Multiplayer } from '../multiplayer';

/**
 * ROUND 95/97/98/99/101 — ITEM-USE INDICATOR (in-engine GUI).
 *
 * The DOM/canvas-entity attempts proved unreliable in the multiplayer-injected
 * game (the bubble never became visible for observers). This version renders
 * the EXACT single-player food/bubble sprites through ig.gui overlays — the
 * same rendering path the mod's name tags use, so it is visible wherever a name
 * tag is visible. `ig.ImageGui` draws the same two textures:
 *   food   — media/entity/player/item-hold.png  (tile from sc.FOOD_SPRITE)
 *   bubble — media/entity/map-gui/hit-numbers.png (src 0,288)
 * A persistent ig.GuiElementBase per pop is projected every frame via the
 * translate/zoom-aware getScreenFromMapPos, with HOLD -> BUBBLE -> DONE timing.
 */

let getMain: () => Multiplayer | undefined = () => undefined;

interface IPop {
    player: string;
    root: any;      // ig.GuiElementBase
    food: any;      // ig.ImageGui (food sprite)
    bubble: any;    // ig.ImageGui (speech bubble)
    coll: any;      // target mirror's coll
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

let foodImage: any = null;
let bubbleImage: any = null;

const POP_MS = 1400;
const BUBBLE_AT = 200;
const DONE_AT = 850;

const scratch: { x: number, y: number } = { x: 0, y: 0 };

function log(msg: string): void {
    try {
        const now = Date.now();
        if (now - lastLogAt > 1000) {
            lastLogAt = now;
            console.log('[multiplayer][itemUse] ' + msg);
        }
    } catch (_) { /* ignore */ }
}

function ensureImages(): void {
    try {
        if (!foodImage) {
            foodImage = new (ig as any).Image('media/entity/player/item-hold.png');
        }
        if (!bubbleImage) {
            bubbleImage = new (ig as any).Image('media/entity/map-gui/hit-numbers.png');
        }
    } catch (_) { /* an image failure must never break the frame */ }
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

function makeImageGui(image: any, ox: number, oy: number, w: number, h: number): any {
    try {
        const C: any = (ig as any).ImageGui;
        if (!C) return null;
        const gui = new C(image, ox, oy, w, h);
        try {
            gui.hook.pivotOverride = true;
            gui.hook.pivot.x = 0;
            gui.hook.pivot.y = 0;
        } catch (_) { /* ignore */ }
        return gui;
    } catch (_) {
        return null;
    }
}

function removePop(pop: IPop): void {
    const idx = live.indexOf(pop);
    if (idx !== -1) live.splice(idx, 1);
    try { if (pop.root && (ig as any).gui && typeof (ig as any).gui.removeGuiElement === 'function') (ig as any).gui.removeGuiElement(pop.root); } catch (_) { /* ignore */ }
}

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
    ensureImages();
    if (!foodImage || !bubbleImage) {
        log('food/bubble images unavailable');
        return true;
    }

    // One pop per player at a time.
    for (const old of live.slice()) {
        if (old.player === player) removePop(old);
    }

    const root: any = new (ig as any).GuiElementBase();
    try {
        root.hook.zIndex = 10003;
        root.hook._visible = true;
        root.setSize(24, 64);
    } catch (_) { /* ignore */ }

    const food = makeImageGui(foodImage, src.x, src.y, 16, 16);
    const bubble = makeImageGui(bubbleImage, 0, 288, 24, 32);
    if (!food || !bubble) return true;

    // Children are top-left-anchored inside the 24x64 root.
    food.setPos(4, 32);
    bubble.setPos(0, 32);
    root.addChildGui(bubble);
    root.addChildGui(food);
    try { (ig as any).gui.addGuiElement(root); } catch (e) { log('ig.gui add failed: ' + e); return true; }

    const now = Date.now();
    const pop: IPop = {
        player,
        root,
        food: food as any,
        bubble: bubble as any,
        coll,
        until: now + POP_MS,
        bubbleAt: now + BUBBLE_AT,
        doneAt: now + DONE_AT,
    };
    live.push(pop);
    log('created in-game food icon for ' + player + ' item=' + item + ' sprite=' + foodName);
    return true;
}

function updatePops(now: number): void {
    for (let i = live.length - 1; i >= 0; i--) {
        const pop = live[i];
        if (!pop || now >= pop.until) {
            if (pop) removePop(pop);
            continue;
        }

        // Project the mirror's head to screen space (same math the name tags use).
        try {
            const c = pop.coll;
            if (c) {
                const cx = c.pos.x + c.size.x / 2;
                const cy = c.pos.y - c.pos.z - c.size.z + c.size.y / 2;
                (ig as any).system.getScreenFromMapPos(scratch, Math.round(cx), Math.round(cy));
                pop.root.setPos(Math.round(scratch.x - 12), Math.round(scratch.y - 60));
            }
        } catch (_) { /* ignore */ }

        try {
            const showBubble = now >= pop.bubbleAt && now < pop.doneAt;
            pop.bubble.hook._visible = showBubble;
            pop.food.hook._visible = now < pop.doneAt;
            // Native BUBBLE layout puts the food higher than the talking bubble.
            pop.food.setPos(4, showBubble ? 0 : 32);
            pop.bubble.setPos(0, 32);
        } catch (_) { /* ignore */ }
    }
}

/** A remote player used an item — pop the single-player food icon above their
 * head. Queues the spawn briefly when the mirror isn't there yet. */
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
 * item use is announced to the instance, and runs a per-frame pump that keeps
 * the in-game GUI icons glued to the remote player's head.
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