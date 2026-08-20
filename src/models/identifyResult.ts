interface IIdentifyResult {
    success: boolean;
    host: boolean;
    mapName: string | null;
    /** ROUND 103: first-ever login for this account (no server save yet). */
    isNew?: boolean;
    /** Server-side save to restore on login, or null if none. */
    save?: { slot: string, data: string } | null;
    /** Round 16 (issue 4): server-provided per-extra-party-member enemy max-HP
     * fraction (config.json monsterHpPerPlayer, default 0.7 = +70% HP per extra
     * member). The HOST client applies it using its own party roster size. */
    hpScale?: number;
    /** Same scheme for the attack/defense/focus stats (defaults 0.1 = +10% per
     * extra party member). */
    attackScale?: number;
    defenseScale?: number;
    focusScale?: number;
    /** Elemental-resistance adjustments per extra member: FLAT points (as a
     * fraction, 0.1 = +10pt) and a PERCENTAGE boost that only applies to
     * positive resistance (never weaknesses). Both default 0 = no adjustment. */
    resistFlat?: number;
    resistPercent?: number;
    /** 1.71.0: save-mirror metadata in mirror-rollback mode (newest first). */
    mirrors?: Array<{ index: number, at: string, slot: string, bytes: number }>;
}
