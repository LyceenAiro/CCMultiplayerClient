import { Multiplayer } from '../multiplayer';

/**
 * ROUND 99 — HEALING JUMP-NUMBER RELAY.
 *
 * The engine already draws the local player's heal as a green +N jump-number
 * (Combatant.heal -> ig.ENTITY.HitNumber.spawnHealingNumber). We sit on
 * ig.ENTITY.Player.prototype.heal, read the exact healed amount the engine is
 * about to apply (`params.getHealAmount`), let the native heal run, then emit
 * `playerHeal` to the server. Every other same-instance client spawns the same
 * native HitNumber above that player's mirror.
 */

let getMain: () => Multiplayer | undefined = () => undefined;
let installed = false;

function findMirrorEntity(player: string): any {
    try {
        const main = getMain();
        if (main) {
            const p = main.players[player];
            const ent = p && p.entity;
            if (ent && ent.coll && !ent._killed) return ent;
        }
        const g: any = (ig as any).game;
        if (g && Array.isArray(g.entities)) {
            for (const e of g.entities) {
                if (e && !e._killed && e.coll && e._mpMirror && e.name === player) return e;
            }
        }
    } catch (_) { /* ignore */ }
    return null;
}

/** A remote player healed: spawn the same native green +N above their mirror. */
export function showRemoteHeal(player: string, amount: number): void {
    try {
        if (!player || !isFinite(amount) || amount <= 0) return;
        const main = getMain();
        if (!main || player === main.name) return;
        const ent = findMirrorEntity(player);
        if (!ent) return;
        const HitNumber: any = (ig as any).ENTITY && (ig as any).ENTITY.HitNumber;
        if (!HitNumber || typeof HitNumber.spawnHealingNumber !== 'function') return;
        const pos = ent.getAlignedPos
            ? ent.getAlignedPos((ig as any).ENTITY_ALIGN.CENTER, { x: 0, y: 0, z: 0 })
            : { x: ent.coll.pos.x + ent.coll.size.x / 2, y: ent.coll.pos.y + ent.coll.size.y / 2, z: ent.coll.pos.z + ent.coll.size.z / 2 };
        HitNumber.spawnHealingNumber(pos, ent, Math.round(amount));
    } catch (_) { /* a healing number must never break the frame */ }
}

/**
 * Install once per process: wraps ig.ENTITY.Player.prototype.heal so a
 * successful LOCAL heal is announced to the instance. Only the local
 * player (not mirrors/puppets, which are Enemy-typed) passes the guard.
 */
export function installHealSync(gm: () => Multiplayer | undefined): void {
    getMain = gm;
    if (installed) return;
    installed = true;
    try {
        const P: any = (ig as any).ENTITY && (ig as any).ENTITY.Player;
        if (!P || !P.prototype || typeof P.prototype.heal !== 'function' || P.prototype._mpHealWrapped) return;
        const orig = P.prototype.heal;
        P.prototype._mpHealWrapped = true;
        P.prototype.heal = function (this: any, healInfo: any, noNumber?: boolean): void {
            const isLocalPlayer = this === (ig as any).game.playerEntity;
            let amount = 0;
            try {
                if (isLocalPlayer && this.params && typeof this.params.getHealAmount === 'function'
                    && typeof this.params.isDefeated === 'function' && !this.params.isDefeated()) {
                    amount = Math.round(this.params.getHealAmount(healInfo));
                }
            } catch (_) { /* a sync failure must never break healing */ }
            orig.apply(this, arguments as any);
            try {
                if (isLocalPlayer && amount > 0) {
                    const m = getMain();
                    const conn = m && m.connection;
                    if (conn && typeof conn.isOpen === 'function' && conn.isOpen()
                        && typeof conn.playerHeal === 'function') {
                        conn.playerHeal(amount);
                    }
                }
            } catch (_) { /* ignore */ }
        };
    } catch (_) { /* the hook must never break the player */ }
}