import { Multiplayer } from '../multiplayer';

/**
 * ROUND 95/97 — ITEM-USE INDICATOR.
 *
 * When the LOCAL player uses a consumable (sc.PlayerModel.useItem returns true)
 * we emit `itemUse` to the server, which relays it to every other player in the
 * same map instance.
 *
 * Receivers spawn the SAME entity the single-player item animation uses:
 * sc.FoodIconEntity (the "吃东西" icon above the player's head — HOLD -> BUBBLE
 * -> DONE pop sequence). It is a real game entity attached to the remote
 * player's mirror, so it tracks their head exactly and needs no DOM/GUI overlay
 * or per-frame projection. The item's `foodSprite` drives the icon index, with
 * the vanilla "SANDWICH" fallback — identical to sc.ItemConsumption.getAction.
 */

let getMain: () => Multiplayer | undefined = () => undefined;

interface IIcon {
    player: string;
    entity: any;      // spawned sc.FoodIconEntity
}

let installed = false;
let live: IIcon[] = [];

function killIcon(ic: IIcon): void {
    const idx = live.indexOf(ic);
    if (idx !== -1) live.splice(idx, 1);
    try { if (ic.entity && !ic.entity._killed) ic.entity.kill(); } catch (_) { /* ignore */ }
}

/** A remote player used an item — pop the exact single-player food icon above
 * their head (replaces any icon we already show for that player). */
export function showItemUse(player: string, item: string | number): void {
    try {
        if (!player || item === undefined || item === null) return;
        const main = getMain();
        if (!main || player === main.name) return; // our own use is already visible locally
        const p = main.players[player];
        const ent = p && p.entity;
        if (!ent || !ent.coll || ent._killed) return;
        // FoodIconEntity attaches itself to the target's action-attached list, so
        // the target must be an actor entity (player mirrors / enemies are).
        if (typeof ent.addActionAttached !== 'function') return;

        const FoodIcon: any = (sc as any).FoodIconEntity;
        if (!FoodIcon) return;

        // Icon index comes from the item's foodSprite, exactly like the native
        // consume action (sc.ItemConsumption.getAction).
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

        const fx: any = (ig as any).game.spawnEntity(FoodIcon, 0, 0, 0, { icon, combatant: ent });
        if (!fx) return;
        const ic: IIcon = { player, entity: fx };
        live.push(ic);

        const states: any = (sc as any).FOOD_ICON_STATE || { HOLD: 0, BUBBLE: 1, DONE: 2 };
        // Mirror the native consume action timing: hold briefly, pop into the
        // bubble, then finish (FoodIconEntity kills itself after DONE).
        window.setTimeout(() => {
            try { if (fx && !fx._killed) fx.setState(states.BUBBLE); } catch (_) { /* ignore */ }
        }, 220);
        window.setTimeout(() => {
            try { if (fx && !fx._killed) fx.setState(states.DONE); } catch (_) { /* ignore */ }
        }, 900);
        window.setTimeout(() => killIcon(ic), 1500);
    } catch (_) { /* an indicator must never break the frame */ }
}

/** Drop every live indicator (logout / server loss / map cleanup). */
export function clearItemUseIndicators(): void {
    for (const ic of live.slice()) killIcon(ic);
    live = [];
}

/**
 * Install once per process: wraps sc.PlayerModel.useItem so a SUCCESSFUL local
 * item use is announced to the instance. The remote visual is driven entirely by
 * the spawned FoodIconEntity, so no per-frame update loop is needed here.
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
}
