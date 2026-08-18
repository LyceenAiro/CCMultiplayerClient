import { Multiplayer } from '../multiplayer';

/**
 * 1.71.0 — dungeon interaction-mechanism sync.
 * 1.71.2 — box push/pull ownership + interpolation.
 * 1.71.3 — PushPullDest progress is personal save state.
 *
 * CrossCode dungeon puzzles are mostly var-driven, but each client owns its own
 * ig.vars, so the ENGINE never shares puzzle state across machines. This module
 * scans the live puzzle entities on dungeon maps and relays their compact state:
 *   - push/pull boxes, wave boxes, sliding blocks (position + anim + phased),
 *   - water blocks / ice pillars (state + remaining hits),
 *   - OL/dynamic/extract platforms (position),
 *   - one-time / multi-hit / floor / bounce / group switches (on/off + hits),
 *   - bounce blocks and blockers (state/active).
 *
 * Push/pull boxes are special: only ONE player may grab a box at a time. The
 * gripping client stamps its entries with `own` (its username + a local claim
 * timestamp), every other client drops its own stale box packets while that
 * owner is alive, and the local map-interact entry is disabled for everyone
 * else. Remote positions are lerped per-frame so 10Hz snapshots glide instead
 * of stuttering. The instance host still sends a 1Hz full snapshot for late
 * joiners / silent drift, but skips boxes that are currently owned remotely.
 *
 * 1.71.3: "box already pushed onto the switch / plate half-lowered" is saved
 * per player (vanilla var `map.entity<destMapId>_placed`). Cross-syncing it
 * made an already-solved box fight an unsolved player's copy until the box
 * vanished. PushPullDest entities are therefore NEVER networked, and a box
 * whose own destination is already placed in THIS save neither sends nor
 * receives position — every player solves that particular box themselves.
 */

const PUZZLE_SCAN_INTERVAL = 0.1;   // seconds — change scan
const PUZZLE_FULL_INTERVAL = 1000;  // ms — host full snapshot
const PUZZLE_OWN_TTL = 700;         // ms without an owner heartbeat -> release
const PUZZLE_OWN_HEARTBEAT = 400;   // ms — owner re-asserts even when stationary
const PUZZLE_LERP_RATE = 16;        // ~16% of the remaining distance per frame

interface IPuzzleEntry {
	mi: number;
	p?: [number, number, number];
	on?: number;
	hits?: number;
	st?: number;
	anim?: string;
	ph?: number;
	act?: number;
	mv?: number;
	hd?: number;
	gone?: number;
	/** 1.71.2: username currently gripping this push/pull box ('' = release). */
	own?: string;
	/** 1.71.2: local claim timestamp for same-time grab arbitration. */
	ot?: number;
}

interface IPuzzlePacket {
	map: string;
	entries: IPuzzleEntry[];
}

export interface IPuzzleSync {
	install(): void;
	tick(): void;
	apply(data: IPuzzlePacket): void;
	/** Diagnostic: list scanned puzzle entities near the player. */
	dump(): void;
}

let updateRegistered = false;
let pushHooksInstalled = false;
let shared: PuzzleSync | null = null;

export function installPuzzleSync(getMain: () => Multiplayer | undefined): IPuzzleSync {
	if (!shared) shared = new PuzzleSync(getMain);
	return shared;
}

class PuzzleSync implements IPuzzleSync {
	private scanTimer = 0;
	private lastFullAt = 0;
	private lastMap = '';
	private seen = new Set<number>();
	private lastSig = new Map<number, string>();
	private applying = false;
	private remoteOwners = new Map<number, { name: string, claim: number, at: number }>();
	private ownedLast = new Map<number, boolean>();
	private ownHeartbeat = new Map<number, number>();
	private interp = new Map<number, { e: any, tx: number, ty: number, tz: number }>();
	/** 1.71.3: mapIds of push/pull boxes whose PushPullDest is ALREADY PLACED in
	 * THIS client's save. That progress is per-player save state — solved boxes
	 * neither send nor receive network position (a solved player's lowered
	 * plate/box must never overwrite an unsolved player's still-raised puzzle). */
	private placedBoxIds = new Set<number>();

	constructor(private getMain: () => Multiplayer | undefined) {
		(window as any).__mppuzzle = () => this.dump();
	}

	public install(): void {
		const m = this.getMain();
		if (!m || !m.connection) return;
		try { m.connection.onPuzzleState((data) => this.apply(data)); } catch (_) { /* ignore */ }
		if (!updateRegistered) {
			updateRegistered = true;
			simplify.registerUpdate(() => {
				if (!shared) return;
				try { shared.tick(); } catch (_) { /* never break the frame */ }
				try { shared.interpolate(); } catch (_) { /* never break the frame */ }
			});
			console.log('[puzzlesync] installed');
		}
		this.installPushPullHooks();
	}

	public tick(): void {
		const m = this.getMain();
		if (!m || !m.connection || !m.connection.isOpen()) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		if (!this.inDungeon()) {
			if (this.seen.size || this.lastSig.size || this.interp.size || this.remoteOwners.size || this.placedBoxIds.size) {
				this.seen.clear();
				this.lastSig.clear();
				this.lastMap = '';
				this.interp.clear();
				this.remoteOwners.clear();
				this.ownedLast.clear();
				this.ownHeartbeat.clear();
				this.placedBoxIds.clear();
			}
			return;
		}
		const map = g.mapName || '';
		if (map !== this.lastMap) {
			this.lastMap = map;
			this.seen.clear();
			this.lastSig.clear();
			this.lastFullAt = 0;
			this.interp.clear();
			this.remoteOwners.clear();
			this.ownedLast.clear();
			this.ownHeartbeat.clear();
			this.placedBoxIds.clear();
		}
		this.expireRemoteOwners((g.entities as any[]) || []);
		this.scanTimer -= ig.system.tick;
		const hostFull = m.host && Date.now() - this.lastFullAt >= PUZZLE_FULL_INTERVAL;
		if (hostFull) this.lastFullAt = Date.now();
		if (this.scanTimer > 0 && !hostFull) return;
		this.scanTimer = PUZZLE_SCAN_INTERVAL;
		const entities = (g.entities as any[]) || [];
		this.refreshPlacedBoxIds(entities);
		const myName = (m.name || '').trim();
		const entries: IPuzzleEntry[] = [];
		const nowSeen = new Set<number>();
		for (const e of entities) {
			const mi = e && e.mapId;
			if (!e || e._killed || typeof mi !== 'number' || !mi) continue;
			if (!this.isPuzzleEntity(e)) continue;
			nowSeen.add(mi);
			const push = this.isPushPull(e);
			// Solved-in-this-save boxes are personal save state: never ship them,
			// but keep them in `seen` so they don't turn into a `gone` packet.
			if (push && this.placedBoxIds.has(mi)) continue;
			// A box that belongs to someone else right now is a FOLLOWER copy:
			// never ship its stale position (that is exactly the rollback the
			// gripping player complained about), and never ship `gone` for it.
			if (push && this.remoteOwners.has(mi)) {
				if (this.ownedLast.has(mi)) this.ownedLast.delete(mi);
				continue;
			}
			const entry = this.encode(e);
			let force = false;
			if (push) {
				if (this.isLocalGripping(e)) {
					this.interp.delete(mi);
					if (typeof (e as any)._mpPuzzleGripAt !== 'number') (e as any)._mpPuzzleGripAt = Date.now();
					entry.own = myName || 'unknown';
					entry.ot = (e as any)._mpPuzzleGripAt;
					this.ownedLast.set(mi, true);
					const lastHb = this.ownHeartbeat.get(mi) || 0;
					if (!hostFull && Date.now() - lastHb >= PUZZLE_OWN_HEARTBEAT) {
						this.ownHeartbeat.set(mi, Date.now());
						force = true;
					}
				} else {
					delete (e as any)._mpPuzzleGripAt;
					if (this.ownedLast.get(mi)) {
						entry.own = '';
						this.ownedLast.delete(mi);
						this.ownHeartbeat.delete(mi);
						force = true;
					}
				}
			}
			const sig = this.signature(entry);
			if (!force && !hostFull && this.lastSig.get(mi) === sig) continue;
			this.lastSig.set(mi, sig);
			entries.push(entry);
		}
		// Gone entries: an entity the peer has must be killed. Remote-owned boxes
		// are in nowSeen (the follower-copy branch above), so they never go out;
		// belt-and-braces: never `gone` a box that still has a live remote owner.
		for (const mi of this.seen) {
			if (nowSeen.has(mi)) continue;
			if (this.remoteOwners.has(mi)) continue;
			if (this.placedBoxIds.has(mi)) continue;
			this.lastSig.delete(mi);
			entries.push({ mi, gone: 1 });
		}
		this.seen = nowSeen;
		if (!entries.length) return;
		try {
			m.connection.puzzleState(map, entries);
		} catch (_) { /* ignore */ }
	}

	public apply(data: IPuzzlePacket): void {
		if (!data || typeof data.map !== 'string' || !Array.isArray(data.entries)) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || (g.mapName || '') !== data.map) return;
		this.applying = true;
		try {
			const m = this.getMain();
			this.updateMyName(m);
			const entities = (g.entities as any[]) || [];
			this.refreshPlacedBoxIds(entities);
			const byId = new Map<number, any>();
			for (const e of entities) {
				if (e && typeof e.mapId === 'number' && e.mapId && !e._killed) byId.set(e.mapId, e);
			}
			for (const s of data.entries) {
				if (!s || typeof s.mi !== 'number') continue;
				const e = byId.get(s.mi);
				if (!e) continue;
				const push = this.isPushPull(e);
				// Personal save progress wins: a solved-in-this-save box must keep
				// its lowered plate position and must never follow another client's
				// still-unsolved copy (and vice versa).
				if (push && this.placedBoxIds.has(s.mi)) continue;
				if (s.gone) {
					try { if (typeof e.kill === 'function') e.kill(true); } catch (_) { /* ignore */ }
					continue;
				}
				if (push) this.applyOwnership(e, s);
				this.applyEntry(e, s, push);
			}
		} catch (_) { /* never break the frame */ }
		finally {
			this.applying = false;
		}
	}

	public dump(): void {
		try {
			const g: any = ig.game;
			const player = g && g.playerEntity;
			const list: any[] = (g && g.entities) || [];
			let n = 0;
			for (const e of list) {
				if (!e || e._killed || !this.isPuzzleEntity(e)) continue;
				const d = player && player.coll && e.coll ? Math.round(Math.sqrt(
					Math.pow(e.coll.pos.x - player.coll.pos.x, 2) + Math.pow(e.coll.pos.y - player.coll.pos.y, 2))) : -1;
				if (d > 600) continue;
				n++;
				const s = this.encode(e);
				const owner = this.remoteOwners.get(e.mapId || 0);
				console.log('[puzzlesync] ' + (e.constructor && e.constructor.name || e.type || '?')
					+ ' mapId=' + e.mapId + ' dist=' + d + ' sig=' + this.signature(s)
					+ (owner ? ' remoteOwner=' + owner.name : '')
					+ (this.isLocalGripping(e) ? ' localGrip' : ''));
			}
			console.log('[puzzlesync] ' + n + ' puzzle entities nearby, dungeon=' + this.inDungeon()
				+ ', remoteOwners=' + this.remoteOwners.size + ', interp=' + this.interp.size);
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------------ internals

	private updateMyName(m?: Multiplayer | undefined): void {
		try { (this as any)._mpMyName = (m && m.name) || ((this as any)._mpMyName || ''); } catch (_) { /* ignore */ }
	}

	private myName(): string {
		const m = this.getMain();
		return (m && m.name) || (this as any)._mpMyName || '';
	}

	private inDungeon(): boolean {
		try {
			const map: any = (sc as any).map;
			return !!(map && typeof map.isDungeon === 'function' && map.isDungeon());
		} catch (_) { return false; }
	}

	private isPuzzleEntity(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		if (!E) return false;
		// NOTE (1.71.3): PushPullDest is deliberately NOT listed here — its
		// raised/lowered height is a per-player SAVE mechanism. A solved player's
		// lowered plate must never be broadcast over an unsolved player's raised
		// one, and the box that belongs to it is excluded via placedBoxIds.
		const kinds = [E.PushPullBlock, E.WavePushPullBlock, E.SlidingBlock,
			E.WaterBlock, E.OLPlatform, E.DynamicPlatform, E.ExtractPlatform, E.OneTimeSwitch,
			E.MultiHitSwitch, E.FloorSwitch, E.Switch, E.BounceSwitch, E.BounceBlock,
			E.GroupSwitch, E.RotateBlocker, E.Blocker];
		for (const k of kinds) {
			if (k && e instanceof k) return true;
		}
		return false;
	}

	/** Which push/pull boxes are already PLACED in this client's own save? The
	 * PushPullDest keeps `placedData.id` = the box mapId it saved (vanilla var
	 * `map.entity<mapId>_placed`). Those boxes are local-only from now on. */
	private refreshPlacedBoxIds(entities: any[]): void {
		const E: any = (ig.ENTITY as any);
		const next = new Set<number>();
		try {
			if (E && E.PushPullDest) {
				for (const e of entities) {
					if (!e || e._killed || !(e instanceof E.PushPullDest)) continue;
					const id = e.placedData && e.placedData.id;
					if (typeof id === 'number' && id) next.add(id);
				}
			}
		} catch (_) { /* keep the previous set */ }
		this.placedBoxIds = next;
	}

	private isPushPull(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		if (!E) return false;
		return (E.PushPullBlock && e instanceof E.PushPullBlock)
			|| (E.WavePushPullBlock && e instanceof E.WavePushPullBlock);
	}

	private isLocalGripping(e: any): boolean {
		try {
			const p = e && e.pushPullable;
			if (!p) return false;
			return !!(p.gripDir || p.dragState === 2 || p.dragState === 3 || p.dragState === 4);
		} catch (_) { return false; }
	}

	/** True when someone ELSE currently owns this box (with heartbeat expiry). */
	public isRemoteOwned(e: any): boolean {
		const mi = e && e.mapId;
		if (!mi) return false;
		const rec = this.remoteOwners.get(mi);
		if (!rec) return false;
		if (Date.now() - rec.at > PUZZLE_OWN_TTL) {
			this.remoteOwners.delete(mi);
			this.restoreRemoteState(e);
			return false;
		}
		return rec.name !== this.myName();
	}

	private applyOwnership(e: any, s: IPuzzleEntry): void {
		const mi = e.mapId || 0;
		const my = this.myName();
		const localGrip = this.isLocalGripping(e);
		const localAt = (e as any)._mpPuzzleGripAt;
		if (typeof s.own === 'string' && s.own.length > 0) {
			if (s.own === my) {
				// An echo of our own claim (server normally excludes the sender).
				this.remoteOwners.delete(mi);
				return;
			}
			const claim = typeof s.ot === 'number' && isFinite(s.ot) ? s.ot : Date.now();
			// Same-time grab arbitration: the client whose grip started FIRST wins.
			// If we are the later gripper, drop our grip and follow the winner.
			const weWin = localGrip && typeof localAt === 'number' && localAt < claim;
			if (weWin) {
				// Keep our grip; the other client will see OUR claim next packet and
				// release. Do NOT record them as a remote owner — tick() would then
				// stop shipping our own authoritative claim and the box would freeze.
				return;
			}
			this.remoteOwners.set(mi, { name: s.own, claim, at: Date.now() });
			if (localGrip) this.cancelLocalGrip(e);
			if (!e._mpPuzzleRemote) {
				e._mpPuzzleRemote = true;
				e._mpPuzzleWasActive = !!(e.pushPullable && e.pushPullable.active);
				try { if (e.pushPullable && typeof e.pushPullable.setActive === 'function') e.pushPullable.setActive(false); } catch (_) { /* ignore */ }
			}
		} else if (s.own === '') {
			if (this.remoteOwners.delete(mi)) this.restoreRemoteState(e);
		}
	}

	private cancelLocalGrip(e: any): void {
		try {
			if (e && e.pushPullable && typeof e.pushPullable.cancelGrip === 'function') e.pushPullable.cancelGrip();
		} catch (_) { /* ignore */ }
		try { delete (e as any)._mpPuzzleGripAt; } catch (_) { /* ignore */ }
	}

	private dropInterp(e: any): void {
		try {
			if (e && typeof e.mapId === 'number' && e.mapId) this.interp.delete(e.mapId);
		} catch (_) { /* ignore */ }
	}

	private restoreRemoteState(e: any): void {
		if (!e || e._killed) return;
		if (!e._mpPuzzleRemote) return;
		e._mpPuzzleRemote = false;
		try {
			if (e.pushPullable && typeof e.pushPullable.setActive === 'function' && e._mpPuzzleWasActive && !e._hidden) {
				e.pushPullable.setActive(true);
			}
		} catch (_) { /* ignore */ }
	}

	private expireRemoteOwners(entities: any[]): void {
		if (!this.remoteOwners.size) return;
		const now = Date.now();
		const byId = new Map<number, any>();
		for (const rec of this.remoteOwners) {
			if (now - rec[1].at <= PUZZLE_OWN_TTL) continue;
			this.remoteOwners.delete(rec[0]);
			if (!byId.size) {
				for (const e of entities) {
					if (e && typeof e.mapId === 'number' && e.mapId) byId.set(e.mapId, e);
				}
			}
			this.restoreRemoteState(byId.get(rec[0]));
		}
	}

	private encode(e: any): IPuzzleEntry {
		const s: IPuzzleEntry = { mi: e.mapId || 0 };
		if (e.coll && e.coll.pos) {
			s.p = [Math.round(e.coll.pos.x), Math.round(e.coll.pos.y), Math.round(e.coll.pos.z)];
		}
		if (typeof e.isOn === 'boolean') s.on = e.isOn ? 1 : 0;
		if (typeof e.currentHits === 'number') s.hits = e.currentHits;
		if (typeof e.remainingHits === 'number') s.hits = e.remainingHits;
		if (typeof e.state === 'number') s.st = e.state;
		if (typeof e.blockState === 'number') s.st = e.blockState;
		if (typeof e.currentAnim === 'string' && e.currentAnim) s.anim = e.currentAnim;
		if (typeof e.phased === 'boolean') s.ph = e.phased ? 1 : 0;
		if (e.pushPullable && typeof e.pushPullable.active === 'boolean') s.act = e.pushPullable.active ? 1 : 0;
		if (typeof e.moving === 'boolean') s.mv = e.moving ? 1 : 0;
		if (e._hidden) s.hd = 1;
		return s;
	}

	private applyEntry(e: any, s: IPuzzleEntry, push: boolean): void {
		// Box authority: the gripping client never accepts box echoes (server
		// already excludes the sender, but a different client's 1Hz host snapshot
		// or a stale non-owner packet can still arrive), and follower copies only
		// accept the CURRENT owner's packets.
		const localOwner = push && this.isLocalGripping(e);
		const ownerRec = push ? this.remoteOwners.get(e.mapId || 0) : undefined;
		const ownerSpeaks = typeof s.own === 'string' && ownerRec && (s.own === ownerRec.name || s.own === '');
		const staleBoxState = push && !localOwner && ownerRec && !ownerSpeaks;
		const skipBoxPos = push && (localOwner || staleBoxState);
		// While a remote player owns this box its interact entry must stay OFF
		// locally; the owner's own `act` field says "still grabbable on THEIR
		// client", which must not re-enable grabbing here.
		const followerLocked = push && !localOwner && !!ownerRec;

		if (s.p && e.coll && !skipBoxPos) {
			this.setInterpTarget(e, s.p[0], s.p[1], s.p[2]);
		}
		// WaterBlock: state transitions have real effects (freeze/break).
		const WB: any = (ig.ENTITY as any).WaterBlock;
		if (WB && e instanceof WB && typeof s.st === 'number') {
			try {
				if (s.st === 2 && e.state !== 2 && typeof e.turnIce === 'function') e.turnIce();
				else if (s.st !== 2 && e.state === 2 && typeof e.iceBreak === 'function') e.iceBreak();
				else e.state = s.st;
				if (typeof s.hits === 'number') e.remainingHits = s.hits;
			} catch (_) { /* ignore */ }
		} else if (!staleBoxState) {
			if (typeof s.st === 'number') {
				try {
					if (typeof e.blockState === 'number') e.blockState = s.st;
					else if (typeof e.state === 'number' && typeof e.turnIce !== 'function') e.state = s.st;
				} catch (_) { /* ignore */ }
			}
		}
		if (typeof s.on === 'number' && typeof e.isOn === 'boolean') {
			try {
				const want = s.on === 1;
				if (e.isOn !== want) e.isOn = want;
				// Keep the entity's backing var coherent too (linked platforms /
				// blockers on this client re-evaluate via varsChanged).
				if (typeof e.variable === 'string' && e.variable) {
					try { (ig as any).vars.set(e.variable, want); } catch (_) { /* ignore */ }
				}
				if (!s.anim && typeof e.setCurrentAnim === 'function') {
					try { e.setCurrentAnim(want ? 'on' : 'off', true, null, true); } catch (_) { /* ignore */ }
				}
			} catch (_) { /* ignore */ }
		}
		if (typeof s.hits === 'number' && typeof e.currentHits === 'number') e.currentHits = s.hits;
		if (typeof s.ph === 'number' && typeof e.phased === 'boolean') {
			const want = s.ph === 1;
			if (e.phased !== want) {
				try {
					e.phased = want;
					if (typeof e.setCurrentAnim === 'function') e.setCurrentAnim(want ? 'phasing' : 'default', true, null, true);
				} catch (_) { /* ignore */ }
			}
		}
		if (!staleBoxState) {
			if (typeof s.act === 'number' && e.pushPullable && typeof e.pushPullable.setActive === 'function' && !followerLocked) {
				try { e.pushPullable.setActive(s.act === 1); } catch (_) { /* ignore */ }
			}
			if (typeof s.mv === 'number' && typeof e.moving === 'boolean') e.moving = s.mv === 1;
			if (typeof s.anim === 'string' && s.anim && typeof e.setCurrentAnim === 'function') {
				try { e.setCurrentAnim(s.anim, true, null, true); } catch (_) { /* ignore */ }
			}
		}
		if (typeof s.hd === 'number') {
			try {
				if (s.hd === 1 && typeof e.hide === 'function') e.hide();
				else if (s.hd === 0 && typeof e.show === 'function') e.show();
			} catch (_) { /* ignore */ }
		}
	}

	/** Store a network position as a per-frame interpolation target. Big jumps
	 * (teleport/load/reset) snap instantly instead of gliding across the map. */
	private setInterpTarget(e: any, x: number, y: number, z: number): void {
		const mi = e.mapId || 0;
		const c: any = e.coll;
		const dx = x - c.pos.x, dy = y - c.pos.y, dz = z - c.pos.z;
		if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
			try { c.setPos(x, y, z); } catch (_) { /* ignore */ }
			this.interp.delete(mi);
			return;
		}
		(e as any)._mpPuzzleToX = x;
		(e as any)._mpPuzzleToY = y;
		(e as any)._mpPuzzleToZ = z;
		this.interp.set(mi, { e, tx: x, ty: y, tz: z });
	}

	/** Per-frame glide toward the latest network position (runs every frame via
	 * simplify.registerUpdate, unlike the 10Hz scan). */
	private interpolate(): void {
		if (!this.interp.size) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		const t = Math.min(1, (ig.system.tick || 0) * PUZZLE_LERP_RATE);
		for (const [mi, rec] of this.interp) {
			const e = rec.e;
			if (!e || e._killed || !e.coll) { this.interp.delete(mi); continue; }
			// The local gripping player's box is engine-driven; never fight it.
			if (this.isPushPull(e) && this.isLocalGripping(e)) continue;
			const c: any = e.coll;
			const dx = rec.tx - c.pos.x;
			const dy = rec.ty - c.pos.y;
			const dz = rec.tz - c.pos.z;
			if (dx === 0 && dy === 0 && dz === 0) { this.interp.delete(mi); continue; }
			if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
				try { c.setPos(rec.tx, rec.ty, rec.tz); } catch (_) { /* ignore */ }
				this.interp.delete(mi);
				continue;
			}
			try { c.setPos(c.pos.x + dx * t, c.pos.y + dy * t, c.pos.z + dz * t); } catch (_) { /* ignore */ }
			if (Math.abs(dx) < 0.1 && Math.abs(dy) < 0.1 && Math.abs(dz) < 0.1) this.interp.delete(mi);
		}
	}

	private installPushPullHooks(): void {
		if (pushHooksInstalled) return;
		pushHooksInstalled = true;
		try {
			const P: any = (sc as any).PushPullable;
			if (!P || !P.prototype) return;
			const self = this;
			const origBlocked = P.prototype.isInteractionBlocked;
			P.prototype.isInteractionBlocked = function (this: any) {
				try {
					if (self.isRemoteOwned(this.entity)) return true;
				} catch (_) { /* fall through to vanilla */ }
				return origBlocked.apply(this, arguments as any);
			};
			const origInteraction = P.prototype.onInteraction;
			P.prototype.onInteraction = function (this: any) {
				try {
					if (self.isRemoteOwned(this.entity)) return;
					self.dropInterp(this.entity);
					if (this.entity && typeof this.entity._mpPuzzleGripAt !== 'number') {
						this.entity._mpPuzzleGripAt = Date.now();
					}
				} catch (_) { /* ignore */ }
				return origInteraction.apply(this, arguments as any);
			};
			console.log('[puzzlesync] push/pull ownership hooks installed');
		} catch (_) { /* ignore */ }
	}

	private signature(s: IPuzzleEntry): string {
		return JSON.stringify(s);
	}
}
