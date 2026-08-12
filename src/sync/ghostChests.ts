import type { Multiplayer } from '../multiplayer';

// Round 21: GHOST CHESTS (party-aware chest visibility).
//
// Goal (user request): when the LOCAL player has opened a chest but some party
// teammates have NOT, a SEPARATE ghost chest is rendered at 25% opacity in the
// CLOSED, floating/idle pose at the chest's position. The real opened-chest wreck
// is left 100% UNMODIFIED — the engine renders it normally (no alpha fade). The
// ghost cannot be opened; it exists purely to guide teammates to the spot. When
// EVERY party member has opened it, the ghost is killed and the wreck stays as-is.
// Teammates who have not opened it still see their own normal 100% closed chest
// (their save vars are independent per player). Solo play = feature inactive.
//
// Engine facts (verified against game.compiled.js):
//  - ig.ENTITY.Chest is an ig.AnimatedEntity with NO collision and no AI. Its
//    per-player opened state is a save var: this.chestVariable =
//    settings.variable || ("map.chest_" + this.mapId). init(): if
//    ig.vars.get(chestVariable) truthy -> isOpen=true, anim "end", and show()
//    does NOT register an interaction; onInteraction() is a no-op when isOpen.
//    So an opened chest is inherently non-interactive.
//  - The single authoritative open point is Chest.prototype._reallyOpenUp
//    (sets isOpen, spawns drops, ig.vars.add(chestVariable,1), anim "open"->end).
//    We wrap it to learn when WE opened a chest (and cache its info BEFORE any
//    hideCondition can hide/kill the live entity).
//  - Ghost pose: we spawn with a FAKE variable ("__mpGhostVar_" + key) that
//    ig.vars never holds, so init() sees isOpen=false and renders the CLOSED idle
//    pose, floating (coll.float.height=6, variance=2). We then set isOpen=true in
//    the same synchronous turn post-spawn: onInteraction becomes a no-op (blocks
//    opening), _reallyOpenUp's !isOpen guard rejects it, the Detector's FULL_CHEST
//    scan (!a.isOpened()) skips it, and any later show() cannot re-register the
//    interaction. Visually safe because init already picked the idle anim and
//    _initGfx skips its anim-reset branch when isOpen. The prompt/entry show()
//    added is removed via sc.mapInteract.removeEntry so it never reaches a focus
//    pass.
//  - ig.game.spawnEntity('Chest', x, y, z, settings) uses the same path the map
//    loader uses. NOTE: spawnEntity registers `mapEntities[mapId] = entity`, so we
//    deliberately do NOT pass mapId (it stays 0) -> that registration is skipped
//    and the live wreck's mapEntities slot is never clobbered.
//  - animState.alpha is the fade field (init sets it to 1); the ghost's own alpha
//    is set to 0.5 for the ghost look.

export interface IGhostChestsModule {
	/** A party teammate opened a chest (server-relayed chestOpenedBy). */
	onOpenedBy(key: string, by: string): void;
	/** Party opened-chest snapshot for the map we just joined (server chestState). */
	onChestState(opened: { [chestKey: string]: string[] }): void;
	/** Session end (logout / server loss): kill ghosts, restore alphas, drop all
	 * cached state. */
	reset(): void;
}

interface ChestInfo {
	x: number;
	y: number;
	z: number;
	chestType: string;
	variable: string;
	mapId: number;
}

// ---- module-level state (install is once-guarded; a session handle is returned
// for the per-connect wiring in multiplayer.ts) ----

let _installed = false;
/** Current Multiplayer instance (refreshed on every connect). */
let _main: Multiplayer | null = null;

/** Session cache: chestKey -> spawn info, populated whenever a REAL (non-ghost)
 * chest entity is observed. Survives map reloads; entries are only added, so it
 * is naturally bounded by the chests seen this session. Lets us spawn a ghost
 * even after a hideCondition removes the live entity. */
const chestInfo: { [key: string]: ChestInfo } = Object.create(null);
/** chestKey -> Set<username> of party members who have opened it (server-fed). */
const openedBy: { [key: string]: Set<string> } = Object.create(null);
/** Ghost chest entities we spawned (Set so we can kill them all on cleanup). */
const ghosts: Set<any> = new Set();

let lastMap = '';
let lastRosterSize = 0;
let lastReconcileAt = 0;
let reconcilePending = true;
let announcePending = false;
const RECONCILE_MS = 500;

// ---- install ----

export function installGhostChests(main: Multiplayer): IGhostChestsModule {
	_main = main;
	if (_installed) return handle;
	_installed = true;
	wrapReallyOpenUp();
	if (typeof simplify !== 'undefined' && simplify && typeof simplify.registerUpdate === 'function') {
		simplify.registerUpdate(pump);
	}
	return handle;
}

const handle: IGhostChestsModule = { onOpenedBy, onChestState, reset };

// ---- server-fed events ----

function onOpenedBy(key: string, by: string): void {
	try {
		if (!key || !by) return;
		let set = openedBy[key];
		if (!set) { set = new Set(); openedBy[key] = set; }
		set.add(by);
		reconcilePending = true;
	} catch (_) { /* never break the frame */ }
}

function onChestState(opened: { [chestKey: string]: string[] }): void {
	try {
		// chestState is the server's authoritative per-PARTY snapshot for the map we
		// just joined — REPLACE (not merge) so stale entries from a previous party or
		// a departed member can't linger in the opened-by sets.
		const next: { [key: string]: Set<string> } = Object.create(null);
		if (opened && typeof opened === 'object') {
			for (const key in opened) {
				const names = opened[key];
				if (!Array.isArray(names)) continue;
				const set = new Set<string>();
				for (const n of names) { if (typeof n === 'string' && n) set.add(n); }
				next[key] = set;
			}
		}
		for (const k in openedBy) delete openedBy[k];
		for (const k in next) openedBy[k] = next[k];
		reconcilePending = true;
	} catch (_) { /* never break the frame */ }
}

function reset(): void {
	try { cleanupLocalVisuals(); } catch (_) { /* ignore */ }
	for (const k in openedBy) delete openedBy[k];
	for (const k in chestInfo) delete chestInfo[k];
	lastMap = '';
	lastRosterSize = 0;
	lastReconcileAt = 0;
	reconcilePending = false;
	announcePending = false;
}

// ---- Chest.prototype._reallyOpenUp wrap ----

/** Wrap the engine's single authoritative open point. After the chest really
 * opens (our save var set), cache its info and announce the open to the party.
 * Duplicate emits per entity are guarded by _mpAnnouncedOpen. */
function wrapReallyOpenUp(): void {
	try {
		const Chest: any = (ig as any).ENTITY && (ig as any).ENTITY.Chest;
		if (!Chest || !Chest.prototype) return;
		const proto = Chest.prototype;
		if (proto._mpReallyOpenUpWrapped) return;
		const orig = proto._reallyOpenUp;
		if (typeof orig !== 'function') return;
		proto._mpReallyOpenUpWrapped = true;
		proto._reallyOpenUp = function (this: any) {
			const res = orig.apply(this, arguments as any);
			try {
				const chest = this;
				if (chest._mpAnnouncedOpen) return res;
				chest._mpAnnouncedOpen = true;
				observeOpened(chest);
			} catch (_) { /* never break chest opening */ }
			return res;
		};
	} catch (_) { /* ghost sync must never break the game */ }
}

/** Cache the opened chest's spawn info (so a ghost can be re-created later even
 * if a hideCondition hides/kills the live entity) + announce the open. */
function observeOpened(chest: any): void {
	const m = _main;
	const game: any = ig.game;
	if (!m || !m.connection || !game || !game.mapName) return;
	const id = chest && chest.mapId;
	if (!id) return;
	const map = String(game.mapName || '');
	const key = map + ':' + id;
	cacheFromChest(chest, key);
	reconcilePending = true;
	announcePending = true;
}

// ---- per-frame reconcile pump ----

function pump(): void {
	try {
		const m = _main;
		if (!m) return;
		const conn = m.connection;
		if (!conn || !conn.isOpen()) return;
		const game: any = ig.game;
		if (!game || !game.playerEntity || !game.mapName) return;
		if (game.isTeleporting && game.isTeleporting()) return;
		const map = String(game.mapName || '');
		const roster = m.partyMembers || [];
		const partied = roster.length > 1;

		if (map !== lastMap) {
			lastMap = map;
			// loadLevel killed the old map's entities; drop stale refs and restart.
			ghosts.clear();
			lastReconcileAt = 0;
			reconcilePending = true;
			announcePending = true;
		}
		if (roster.length !== lastRosterSize) {
			lastRosterSize = roster.length;
			if (partied) {
				// A party formed/sized-up mid-map: re-announce (covers party forming
				// after we already opened chests) and reconcile.
				lastReconcileAt = 0;
				reconcilePending = true;
				announcePending = true;
			}
		}

		if (!partied) {
			// Solo (or party of one) -> feature inactive; drop any leftover visuals.
			cleanupLocalVisuals();
			return;
		}

		// Throttle to ~0.5s, but flush immediately on events (reconcilePending).
		const now = Date.now();
		if (!reconcilePending && now - lastReconcileAt < RECONCILE_MS) return;
		lastReconcileAt = now;
		reconcilePending = false;
		reconcile(map);

		if (announcePending) {
			announcePending = false;
			announce(map);
		}
	} catch (_) { /* never break the frame */ }
}

/** Decide the per-chest visibility for the current map. */
function reconcile(map: string): void {
	const m = _main;
	if (!m) return;
	const self = m.name;
	if (!self) return;
	const roster = m.partyMembers || [];
	const teammates = roster.filter((t) => t && t !== self);
	if (!teammates.length) return;

	const liveChests = enumerateLiveChests();
	const liveByKey: { [key: string]: any } = Object.create(null);
	for (const c of liveChests) {
		const id = c && c.mapId;
		if (!id) continue;
		const key = map + ':' + id;
		liveByKey[key] = c;
		cacheFromChest(c, key);
	}

	// Chest keys relevant to the CURRENT map: live entities + cached-for-this-map.
	const keys = new Set<string>();
	for (const key in liveByKey) keys.add(key);
	for (const key in chestInfo) { if (key.indexOf(map + ':') === 0) keys.add(key); }

	for (const key of keys) {
		let info = chestInfo[key];
		const live = liveByKey[key];
		const variable = info ? info.variable : (live ? live.chestVariable : '');
		if (!variable) continue;

		let openedByMe = false;
		try { openedByMe = !!((ig.vars as any).get(variable)); } catch (_) { /* ignore */ }

		if (!openedByMe) {
			// We have not opened it -> the normal 100% closed chest is ours to show.
			// The real wreck is never touched; just clear any stray ghost for the key.
			killGhostForKey(key);
			continue;
		}

		// We opened it. Ghost it (as a separate closed-pose chest at 0.5) while ANY
		// teammate still lacks it; kill the ghost once all have it. The real wreck is
		// always left 100% UNMODIFIED.
		const teammateMissing = teammates.some((t) => {
			const set = openedBy[key];
			return !set || !set.has(t);
		});

		if (teammateMissing) {
			// Cache info from the live wreck if we don't have it yet, then spawn the
			// ghost REGARDLESS of whether a live wreck still exists.
			if (!info && live) {
				cacheFromChest(live, key);
				info = chestInfo[key];
			}
			if (info) spawnGhost(info, key);
		} else {
			killGhostForKey(key);
		}
	}
}

// ---- helpers ----

/** The REAL (non-ghost, non-killed) chest entities on the current map. */
function enumerateLiveChests(): any[] {
	try {
		const game: any = ig.game;
		const Chest: any = (ig as any).ENTITY && (ig as any).ENTITY.Chest;
		if (!game || !Chest || !Array.isArray(game.entities)) return [];
		const out: any[] = [];
		for (const e of game.entities) {
			if (!e || e._killed || e._mpGhost) continue;
			if (e instanceof Chest) out.push(e);
		}
		return out;
	} catch (_) { return []; }
}

/** Cache spawn info from a real chest entity (keyed once; entries never removed
 * mid-session). */
function cacheFromChest(chest: any, key: string): void {
	try {
		if (!chest || chest._mpGhost) return;
		if (chestInfo[key]) return;
		const id = chest.mapId;
		if (!id) return;
		const cp = chest.coll && chest.coll.pos;
		if (!cp) return;
		chestInfo[key] = {
			x: cp.x,
			y: cp.y,
			z: cp.z,
			chestType: chestTypeName(chest),
			variable: chest.chestVariable || ('map.chest_' + id),
			mapId: id,
		};
	} catch (_) { /* ignore */ }
}

/** Reverse-lookup the chestType SETTING name (the resolved chestType object has
 * no name; sc.CHEST_TYPE maps name -> object). */
function chestTypeName(chest: any): string {
	try {
		const CT: any = (sc as any).CHEST_TYPE;
		if (CT) for (const name in CT) { if (CT[name] === chest.chestType) return name; }
	} catch (_) { /* ignore */ }
	return 'default';
}

/** Spawn a ghost chest at a cached position. The ghost is a SEPARATE chest in the
 * CLOSED idle/float pose at 25% opacity — the real wreck is never touched. A FAKE
 * variable ("__mpGhostVar_" + key) that ig.vars never holds makes init() see
 * isOpen=false and render the closed idle pose with the float (coll.float.height=6,
 * variance=2). mapId is deliberately NOT passed (stays 0) so spawnEntity's
 * mapEntities registration is skipped and the live wreck's mapEntities slot is never
 * clobbered. Idempotent per key: a live ghost for the same key is never duplicated
 * (the pump re-runs every ~0.5s). */
function spawnGhost(info: ChestInfo, key: string): any {
	try {
		for (const g of ghosts) {
			if (g && g._mpGhostKey === key && !g._killed) return g; // already there
		}
		const game: any = ig.game;
		if (!game || typeof game.spawnEntity !== 'function') return null;
		const ghost = game.spawnEntity('Chest', info.x, info.y, info.z, {
			chestType: info.chestType,
			variable: '__mpGhostVar_' + key,
			noTrack: true,
		});
		if (!ghost) return null;
		// Post-spawn, in the SAME synchronous turn (engine has not updated yet):
		//  a) mark the entity as ours.
		ghost._mpGhost = true;
		ghost._mpGhostKey = key;
		//  b) isOpen=true blocks onInteraction (returns true), _reallyOpenUp
		//     (if(!this.isOpen) guard), the Detector FULL_CHEST scan (!a.isOpened()),
		//     and any later show() re-registering the interaction. Visually safe: init
		//     already set the closed idle anim, and _initGfx skips its anim-reset
		//     branch when isOpen.
		ghost.isOpen = true;
		//  c) drop the interaction prompt/entry show() added during spawn (it never
		//     survives to the next frame's focus pass -> no prompt race).
		if (ghost.interactEntry) {
			try { sc.mapInteract.removeEntry(ghost.interactEntry); } catch (_) { /* ignore */ }
		}
		//  d) 50% opacity ghost look (round 22: raised from 0.25 per user request).
		if (ghost.animState) ghost.animState.alpha = 0.5;
		//  e) track it for cleanup/dedupe.
		ghosts.add(ghost);
		return ghost;
	} catch (_) { return null; }
}

function killGhostForKey(key: string): void {
	try {
		for (const g of ghosts) {
			if (g && g._mpGhostKey === key && !g._killed) {
				try { g.kill(); } catch (_) { /* ignore */ }
			}
		}
		for (const g of Array.from(ghosts)) {
			if (g && g._mpGhostKey === key) ghosts.delete(g);
		}
	} catch (_) { /* ignore */ }
}

/** Kill every ghost. (Real wrecks are never touched, so there is nothing to
 * restore.) */
function cleanupLocalVisuals(): void {
	try {
		for (const g of ghosts) {
			try { if (g && !g._killed && typeof g.kill === 'function') g.kill(); } catch (_) { /* ignore */ }
		}
		ghosts.clear();
	} catch (_) { /* ignore */ }
}

/** Build + send the list of chests on the current map that WE have opened, so the
 * server can tell the party (covers teammates who joined after we opened, or a
 * party that formed mid-map). Capped at 128 entries server-side too. */
function announce(map: string): void {
	try {
		const m = _main;
		if (!m || !m.connection || !m.connection.isOpen()) return;
		const roster = m.partyMembers || [];
		if (roster.length <= 1) return;

		const list: Array<{ map: string, id: number }> = [];
		const seenIds = new Set<number>();
		for (const c of enumerateLiveChests()) {
			const id = c && c.mapId;
			if (!id) continue;
			if (isOpenedVar(c.chestVariable || ('map.chest_' + id))) {
				list.push({ map, id });
				seenIds.add(id);
			}
		}
		for (const key in chestInfo) {
			if (key.indexOf(map + ':') !== 0) continue;
			const info = chestInfo[key];
			if (seenIds.has(info.mapId)) continue;
			if (isOpenedVar(info.variable)) list.push({ map, id: info.mapId });
		}
		if (list.length) m.connection.emitChestOpened(list.slice(0, 128));
	} catch (_) { /* ignore */ }
}

function isOpenedVar(variable: string): boolean {
	try { return !!((ig.vars as any).get(variable)); } catch (_) { return false; }
}
