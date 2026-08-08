interface IIdentifyResult {
    success: boolean;
    host: boolean;
    mapName: string | null;
    /** Server-side save to restore on login, or null if none. */
    save?: { slot: string, data: string } | null;
    /** Round 16 (issue 4): server-provided per-extra-party-member enemy max-HP
     * fraction (config.json monsterHpPerPlayer, default 0.5 = +50% HP per extra
     * member). The HOST client applies it using its own party roster size. */
    hpScale?: number;
}
