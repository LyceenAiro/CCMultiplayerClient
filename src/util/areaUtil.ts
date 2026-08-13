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

/**
 * The numeric sc.AREA_TYPE (0=TOWN, 1=PATH, 2=DUNGEON) of an AREA by its path.
 * The game's `areas` table stores `areaType` as a STRING key ("TOWN" / "PATH" /
 * "DUNGEON") — the old `typeof area.areaType === 'number'` check therefore never
 * matched, so every area (towns included) fell back to PATH and shared-town
 * matchmaking never fired. Prefer the engine's own converter, then fall back to
 * reading the record directly (handling both the string key and the number).
 */
function areaTypeOfPath(areaPath: string): number {
	try {
		const sm = (sc.map as any);
		// Preferred: the engine's own converter (returns the numeric sc.AREA_TYPE).
		if (sm && typeof sm.getAreaType === 'function') {
			const t = sm.getAreaType(areaPath);
			if (typeof t === 'number' && t >= 0 && t <= 2) return t;
		}
		const area = sm && sm.areas && sm.areas[areaPath];
		if (area) {
			if (typeof area.areaType === 'number') return area.areaType;
			if (typeof area.areaType === 'string') {
				const en = (sc as any).AREA_TYPE;
				if (en && typeof en[area.areaType] === 'number') return en[area.areaType];
			}
		}
	} catch (_) { /* fall through */ }
	return AREA_TYPE.PATH;
}

/** The sc.AREA_TYPE of the current area, defaulting to PATH when unknown. */
export function currentAreaType(): number {
	return areaTypeOfPath(currentAreaPath());
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
	return areaTypeOfPath(areaPathOfMap(mapName));
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

/**
 * True when the LOCAL player has unlocked/visited the *area* (block) a map belongs
 * to — i.e. the save's `ig.vars.storage.maps` table has ANY entry whose key starts
 * with the area's camelCase prefix. The engine keys that table by
 * `mapName.toCamel()` (only `-x` -> `X`; dots are kept), so every map of area
 * "autumn-rise" is stored under a key like "autumnRise.path-1".
 *
 * Area granularity is deliberate: a member can have unlocked the block ("上升之路")
 * without ever standing on the leader's exact sub-map, and the old per-map check
 * wrongly blocked that regroup with "未解锁". Area-level matches what the player
 * perceives as unlocked; the loader-hang safety net (force-finish + watchdog unstick)
 * still protects against the rare quest-gated-enemy wedge.
 *
 * WHY THIS MATTERS: teleporting a member into an area their story hasn't reached can
 * wedge the map loader (quest-gated enemy types fail to finish loading, leaving
 * `ig.loading` stuck true and freezing the game in a black screen).
 */
export function hasUnlockedArea(mapName: string): boolean {
	try {
		const storage = (ig.vars as any) && (ig.vars as any).storage;
		if (!storage || !storage.maps) return true; // can't tell -> don't block
		const camelArea = areaPathOfMap(mapName)
			.replace(/(\-[a-z])/g, (m) => m.toUpperCase().replace('-', ''));
		for (const key in storage.maps) {
			if (key === camelArea || key.indexOf(camelArea + '.') === 0) return true;
		}
		return false;
	} catch (_) {
		return true; // on any error, don't block the teleport
	}
}
