// Area-type helpers for the lobby architecture. CrossCode classifies areas as
// TOWN / PATH / DUNGEON (sc.AREA_TYPE); the server keys map *instances* off this
// (towns are shared matchmaking spaces, paths/dungeons are party/solo-scoped).

export const AREA_TYPE = {
	TOWN: 0,
	PATH: 1,
	DUNGEON: 2,
} as const;

/** The dot-name of the area the player is currently in (e.g. "rookie-harbor"). */
export function currentAreaPath(): string {
	try {
		return (sc.map.currentPlayerArea && sc.map.currentPlayerArea.path) || 'fallback';
	} catch (_) {
		return 'fallback';
	}
}

/** The sc.AREA_TYPE of the current area, defaulting to PATH when unknown. */
export function currentAreaType(): number {
	try {
		const area = (sc.map as any).areas[currentAreaPath()];
		if (area && typeof area.areaType === 'number') {
			return area.areaType;
		}
	} catch (_) { /* fall through */ }
	return AREA_TYPE.PATH;
}

/** True when the current area is a town (shared matchmaking space). */
export function isTown(): boolean {
	return currentAreaType() === AREA_TYPE.TOWN;
}

/**
 * The area path of a *target* map (dot-name), e.g. "rookie-harbor.teleporter"
 * -> "rookie-harbor". Used at teleport time, when sc.map.currentPlayerArea still
 * refers to the map we're leaving, so we must derive the area from the map name.
 */
export function areaPathOfMap(mapName: string): string {
	const idx = mapName.indexOf('.');
	return idx === -1 ? mapName : mapName.substring(0, idx);
}

/** The sc.AREA_TYPE of the area a target map belongs to (defaults to PATH). */
export function areaTypeOfMap(mapName: string): number {
	try {
		const area = (sc.map as any).areas[areaPathOfMap(mapName)];
		if (area && typeof area.areaType === 'number') {
			return area.areaType;
		}
	} catch (_) { /* fall through */ }
	return AREA_TYPE.PATH;
}

/**
 * Areas that are *shared* towns (open matchmaking where remote players meet and
 * walk through each other). Kept in sync with the server's SHARED_TOWNS list —
 * Rookie Harbor (新手港) and Rhombus Square (罗姆布斯广场, incl. 迎新桥).
 */
export const SHARED_TOWNS = ['rookie-harbor', 'rhombus-sqr'];

/** True when the player is currently standing in a shared town. */
export function isSharedTownNow(): boolean {
	return SHARED_TOWNS.indexOf(currentAreaPath()) !== -1;
}
