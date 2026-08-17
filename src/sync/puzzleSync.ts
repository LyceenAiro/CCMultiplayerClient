import { Multiplayer } from '../multiplayer';

/**
 * 1.71.0 — dungeon interaction-mechanism sync.
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
 * Every client sends CHANGES immediately; the instance host additionally sends
 * a full snapshot once per second so late joiners and silent drift self-heal.
 * Removal of an entity (an ice pillar breaks) is relayed as a `gone` entry and
 * the receiver kills its matching copy.
 */

const PUZZLE_SCAN_INTERVAL = 0.1;  // seconds — change scan
const PUZZLE_FULL_INTERVAL = 1000; // ms — host full snapshot

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

	constructor(private getMain: () => Multiplayer | undefined) {
		(window as any).__mppuzzle = () => this.dump();
	}

	public install(): void {
		const m = this.getMain();
		if (!m || !m.connection) return;
		try { m.connection.onPuzzleState((data) => this.apply(data)); } catch (_) { /* ignore */ }
		if (updateRegistered) return;
		updateRegistered = true;
		simplify.registerUpdate(() => {
			try { if (shared) shared.tick(); } catch (_) { /* never break the frame */ }
		});
		console.log('[puzzlesync] installed');
	}

	public tick(): void {
		const m = this.getMain();
		if (!m || !m.connection || !m.connection.isOpen()) return;
		const g: any = ig.game;
		if (!g || !g.playerEntity || g.isTeleporting()) return;
		if (!this.inDungeon()) {
			if (this.seen.size || this.lastSig.size) {
				this.seen.clear();
				this.lastSig.clear();
				this.lastMap = '';
			}
			return;
		}
		const map = g.mapName || '';
		if (map !== this.lastMap) {
			this.lastMap = map;
			this.seen.clear();
			this.lastSig.clear();
			this.lastFullAt = 0;
		}
		this.scanTimer -= ig.system.tick;
		const hostFull = m.host && Date.now() - this.lastFullAt >= PUZZLE_FULL_INTERVAL;
		if (hostFull) this.lastFullAt = Date.now();
		if (this.scanTimer > 0 && !hostFull) return;
		this.scanTimer = PUZZLE_SCAN_INTERVAL;
		const entries: IPuzzleEntry[] = [];
		const nowSeen = new Set<number>();
		for (const e of (g.entities as any[]) || []) {
			const mi = e && e.mapId;
			if (!e || e._killed || typeof mi !== 'number' || !mi) continue;
			if (!this.isPuzzleEntity(e)) continue;
			nowSeen.add(mi);
			const entry = this.encode(e);
			const sig = this.signature(entry);
			if (!hostFull && this.lastSig.get(mi) === sig) continue;
			this.lastSig.set(mi, sig);
			entries.push(entry);
		}
		// Gone entries: an entity the peer has must be killed.
		for (const mi of this.seen) {
			if (nowSeen.has(mi)) continue;
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
			const byId = new Map<number, any>();
			for (const e of (g.entities as any[]) || []) {
				if (e && typeof e.mapId === 'number' && e.mapId && !e._killed) byId.set(e.mapId, e);
			}
			for (const s of data.entries) {
				if (!s || typeof s.mi !== 'number') continue;
				const e = byId.get(s.mi);
				if (!e) continue;
				if (s.gone) {
					try { if (typeof e.kill === 'function') e.kill(true); } catch (_) { /* ignore */ }
					continue;
				}
				this.applyEntry(e, s);
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
				console.log('[puzzlesync] ' + (e.constructor && e.constructor.name || e.type || '?')
					+ ' mapId=' + e.mapId + ' dist=' + d + ' sig=' + this.signature(s));
			}
			console.log('[puzzlesync] ' + n + ' puzzle entities nearby, dungeon=' + this.inDungeon());
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------------ internals

	private inDungeon(): boolean {
		try {
			const map: any = (sc as any).map;
			return !!(map && typeof map.isDungeon === 'function' && map.isDungeon());
		} catch (_) { return false; }
	}

	private isPuzzleEntity(e: any): boolean {
		const E: any = (ig.ENTITY as any);
		if (!E) return false;
		const kinds = [E.PushPullBlock, E.WavePushPullBlock, E.SlidingBlock, E.WaterBlock,
			E.OLPlatform, E.DynamicPlatform, E.ExtractPlatform, E.OneTimeSwitch,
			E.MultiHitSwitch, E.FloorSwitch, E.Switch, E.BounceSwitch, E.BounceBlock,
			E.GroupSwitch, E.RotateBlocker, E.Blocker];
		for (const k of kinds) {
			if (k && e instanceof k) return true;
		}
		return false;
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

	private applyEntry(e: any, s: IPuzzleEntry): void {
		if (s.p && e.coll) {
			try {
				if (typeof e.coll.setPos === 'function') e.coll.setPos(s.p[0], s.p[1], s.p[2]);
				else { e.coll.pos.x = s.p[0]; e.coll.pos.y = s.p[1]; e.coll.pos.z = s.p[2]; }
			} catch (_) { /* ignore */ }
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
		} else {
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
		if (typeof s.act === 'number' && e.pushPullable && typeof e.pushPullable.setActive === 'function') {
			try { e.pushPullable.setActive(s.act === 1); } catch (_) { /* ignore */ }
		}
		if (typeof s.mv === 'number' && typeof e.moving === 'boolean') e.moving = s.mv === 1;
		if (typeof s.anim === 'string' && s.anim && typeof e.setCurrentAnim === 'function') {
			try { e.setCurrentAnim(s.anim, true, null, true); } catch (_) { /* ignore */ }
		}
		if (typeof s.hd === 'number') {
			try {
				if (s.hd === 1 && typeof e.hide === 'function') e.hide();
				else if (s.hd === 0 && typeof e.show === 'function') e.show();
			} catch (_) { /* ignore */ }
		}
	}

	private signature(s: IPuzzleEntry): string {
		return JSON.stringify(s);
	}
}
