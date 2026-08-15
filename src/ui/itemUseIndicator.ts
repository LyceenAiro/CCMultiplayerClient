import { Multiplayer } from '../multiplayer';

/**
 * ROUND 95 — ITEM-USE INDICATOR.
 *
 * When the LOCAL player uses a consumable (sc.PlayerModel.useItem returns true)
 * we emit `itemUse` to the server, which relays it to every other player in the
 * same map instance. Each receiver pops a real in-game item icon
 * (sc.ItemContent) above that player's head for ~2.5s, positioned via the same
 * map->screen projection the name tags use.
 *
 * The indicators are normal ig.gui children, so they render inside the game
 * canvas exactly like the native item HUD icons; no DOM overlay is involved.
 */

let getMain: () => Multiplayer | undefined = () => undefined;

interface IIcon {
    player: string;
    item: string | number;
    el: any;         // sc.ItemContent (an ig.GuiElementBase)
    until: number;
}

let installed = false;
let container: any = null;      // persistent ig.gui parent for all icons
let icons: IIcon[] = [];
const INDICATOR_MS = 2500;      // icon lifetime
const HEAD_OFFSET = 30;         // px above the projected head point

function ensureContainer(): any {
    if (container) return container;
    try {
        container = new (ig as any).GuiElementBase();
        try { container.hook.zIndex = 6; } catch (_) { /* ignore */ }
        try { container.hook._visible = true; } catch (_) { /* ignore */ }
        (ig as any).gui.addGuiElement(container);
    } catch (_) { container = null; }
    return container;
}

function positionIcon(ic: IIcon, scr: { x: number, y: number }): void {
    try {
        const size = ic.el.hook && ic.el.hook.size;
        const w = (size && size.x) || 32;
        const h = (size && size.y) || 32;
        ic.el.setPos(Math.round(scr.x - w / 2), Math.round(scr.y - h - HEAD_OFFSET));
        try { ic.el.hook._visible = true; } catch (_) { /* ignore */ }
    } catch (_) { /* never break the frame */ }
}

function removeIcon(ic: IIcon): void {
    const idx = icons.indexOf(ic);
    if (idx !== -1) icons.splice(idx, 1);
    try { if (container && ic.el) container.removeChildGui(ic.el); } catch (_) { /* ignore */ }
}

/** Project one remote player's head and position their icon there. */
function updateIcon(ic: IIcon): void {
    try {
        const main = getMain();
        if (!main) return;
        const p = main.players[ic.player];
        const ent = p && p.entity;
        const coll = ent && ent.coll;
        if (!coll) return;
        const cx = coll.pos.x + coll.size.x / 2;
        const cy = coll.pos.y - coll.pos.z - coll.size.z + coll.size.y / 2;
        const scr: { x: number, y: number } = { x: 0, y: 0 };
        (ig as any).system.getScreenFromMapPos(scr, Math.round(cx), Math.round(cy));
        positionIcon(ic, scr);
    } catch (_) { /* ignore */ }
}

/** A remote player used an item — replace any icon we already show for them and
 * pop a fresh one above their head. */
export function showItemUse(player: string, item: string | number): void {
    try {
        if (!player || item === undefined || item === null) return;
        const main = getMain();
        if (!main || player === main.name) return; // our own use is already visible locally
        const parent = ensureContainer();
        if (!parent) return;
        // One icon per player at a time.
        for (const old of icons.slice()) {
            if (old.player === player) removeIcon(old);
        }
        const ItemContent: any = (sc as any).ItemContent;
        if (!ItemContent) return;
        const el = new ItemContent(item, 1);
        // We only want the ICON, not the "x1" amount text.
        try { if (el.amountGui && el.amountGui.hook) el.amountGui.hook._visible = false; } catch (_) { /* ignore */ }
        try { el.hook._visible = false; } catch (_) { /* ignore */ }
        parent.addChildGui(el);
        const ic: IIcon = { player, item, el, until: Date.now() + INDICATOR_MS };
        icons.push(ic);
        updateIcon(ic);
    } catch (_) { /* an indicator must never break the frame */ }
}

/** Drop every live indicator (logout / server loss / map cleanup). */
export function clearItemUseIndicators(): void {
    for (const ic of icons.slice()) removeIcon(ic);
    icons = [];
    try { if (container && (ig as any).gui && typeof (ig as any).gui.removeGuiElement === 'function') (ig as any).gui.removeGuiElement(container); } catch (_) { /* ignore */ }
    container = null;
}

/**
 * Install once per process: wraps sc.PlayerModel.useItem so a SUCCESSFUL local
 * item use is announced to the instance, and starts the per-frame position loop
 * that keeps remote indicators glued to their player's head.
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
                if (!icons.length) return;
                const now = Date.now();
                for (let i = icons.length - 1; i >= 0; i--) {
                    if (now >= icons[i].until) {
                        removeIcon(icons[i]);
                    } else {
                        updateIcon(icons[i]);
                    }
                }
            });
        }
    } catch (_) { /* ignore */ }
}
