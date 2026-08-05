interface IIdentifyResult {
    success: boolean;
    host: boolean;
    mapName: string | null;
    /** Server-side save to restore on login, or null if none. */
    save?: { slot: string, data: string } | null;
}
