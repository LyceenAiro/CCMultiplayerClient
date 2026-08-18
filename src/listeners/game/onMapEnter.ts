import { Multiplayer } from '../../multiplayer';
import { SHARED_TOWNS } from '../../util/areaUtil';

export class OnMapEnterListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		const game = ig.game as sc.CrossCode;
		const originalLoad = game.loadLevel;
		game.loadLevel = ((data: sc.MapModel.Map, clearCache?: boolean, reloadCache?: boolean) => {
			this.onMapEnter(data);
			const result = originalLoad.call(game, data, clearCache, reloadCache);
			this.main.loadingMap = false;
			return result;
		}) as typeof game.loadLevel;
	}

	public onMapEnter(data: sc.MapModel.Map): void {
		this.loadEntity('multiplayer');

		// ROUND 83 (item: local map-change mirror cleanup): clearMap() kills the old
		// map's entities, but if the roster reconcile below is ever skipped (a
		// changeMapResponse that lands after loadingComplete, a direct loadLevel, or a
		// same-instance sub-room hop), the stale player records survive and a later
		// playerState can respawn off-map mirrors. The OTHER players' transitions don't
		// need this because the server pushes explicit enters/leaves events for them —
		// which is exactly the asymmetry that was reported. So on OUR OWN real map
		// change, remove every remote-player entry that is not already known to be on
		// the TARGET map BEFORE the level loads.
		this.cleanupStaleMirrorsForMapChange();

		const pending = this.main.pendingChangeMap;
		this.main.pendingChangeMap = undefined;

		// onTeleport now AWAITS changeMapResponse before running the real teleport,
		// so main.host is already the target instance's verdict when loadLevel runs.
		// Members strip their local Enemy/EnemySpawner entities: a member whose save
		// never unlocked the area would otherwise synchronously spawn quest-gated
		// enemies whose EnemyType onload throws inside the map Loader, leaving
		// ig.loading stuck true = infinite black loading (the "never visited this
		// block" wedge). Member-side enemies instead arrive from the host's block as
		// typed puppets, whose types load OUTSIDE the map Loader (async, guarded) —
		// a failed type there skips one puppet, never wedges the game.
		// ONLY strip when actually connected + logged in: at boot / offline the
		// host flag is still its default (false) and stripping would empty a solo
		// world of its enemies.
		const connected = !!(this.main.connection && this.main.connection.isOpen
			&& this.main.connection.isOpen());
		// 1.71.9 (issue 2): shared-town maps (shops included) must never keep a stale
		// combat-mode latch from the previous block. NPC interact entries are
		// `blockedDuringCombat`, so a lingering combatMode=true makes the shop
		// counter appear but refuse to open — exactly the intermittent shop bug.
		try {
			const area = data && data.attributes && (data.attributes.area || '');
			if (connected && area && SHARED_TOWNS.indexOf(area) !== -1) {
				const mdl: any = (sc as any).model;
				if (mdl && typeof mdl.setCombatMode === 'function') mdl.setCombatMode(false);
				const combat: any = (sc as any).combat;
				if (combat && typeof combat.forceEnd === 'function') {
					try { combat.forceEnd(); } catch (_) { /* ignore */ }
				}
				if (this.main.netSync && typeof this.main.netSync.purgeStaleCombatants === 'function') {
					this.main.netSync.purgeStaleCombatants();
				}
			}
		} catch (_) { /* never block a map load */ }
		// mpForceStripNextLoad: a party regroup into a never-visited area is allowed
		// (round 6); if we end up HOST of that instance (leader left meanwhile) the
		// quest-gated spawns are local and can wedge the loader — strip for this one
		// load even as host. Consumed on every load so it never leaks.
		const forceStrip = this.main.consumeForceStrip();
		if (connected && this.main.name && (!this.main.host || forceStrip)) this.stripMemberEnemies(data);

		// Direct loadLevel calls (initial game start, no teleport in flight) carry
		// no pending response; the host flag from the session is used as-is. If a
		// response is still outstanding (legacy path), re-apply it afterwards.
		if (pending) {
			const applyResult = (result: any) => {
				this.main.host = result.isHost;
				// Round 20: remember the NEW instance's host username for the " (Host)"
				// name-tag label (optional field — guarded against older servers).
				if (typeof result.host === 'string') this.main.instanceHost = result.host;
				// Round 21: host tick-rate latch on host-acquire (this load made us the
				// new instance's host) — read once at acquire, never read live.
				if (result.isHost) {
					try { if (this.main.netSync) this.main.netSync.setBlockInterval(this.main.getHostTickInterval()); } catch (_) { /* ignore */ }
				}
				// Round 15: capture the NEW instance's roster (changeMapResponse members)
				// so the load-complete reconcile can drop stale old-map player entries
				// that clearMap() killed but nothing else removed.
				// Main-city refactor: keep each member's SUB-MAP so the load-complete
				// reconcile only mirrors the members actually on our map (a town instance
				// spans a whole area).
				this.main.newInstanceMembers = (result.members || []).map((mm: any) => ({
					name: mm.name,
					map: mm.map,
					// ROUND 84: keep the server's cached member position so loadingComplete
					// can spawn already-present members without waiting for playerState.
					pos: mm.pos && typeof mm.pos.x === 'number' && typeof mm.pos.y === 'number'
						? { x: mm.pos.x, y: mm.pos.y, z: typeof mm.pos.z === 'number' ? mm.pos.z : 0 }
						: undefined,
				}));
			};
			// ROUND 116 (team-wipe revive): the response was already consumed by
			// onTeleport's await, so it is cached on the request promise. Apply it
			// SYNCHRONOUSLY here: a same-map checkpoint "LOAD" is fully cached and
			// the engine can call loadingComplete inside this very loadLevel call —
			// before any `pending.then` microtask could run. The load-complete roster
			// reconcile would otherwise see newInstanceMembers still undefined,
			// stamp playersRosterReady with an empty room (solo mode), and neither
			// client would ever receive the other's post-revive playerState.
			const cached: any = (pending as any)._mpCachedRoster;
			if (cached) {
				applyResult(cached);
			} else {
				pending.then((result) => {
					applyResult(result);
				}).catch(() => { /* keep current flag */ });
			}
		}
	}

	/**
	 * ROUND 83: on OUR OWN real map change, drop remote-player mirrors that are not
	 * known to be on the target sub-map. Known maps come from playerMapByName (kept
	 * fresh by every relayed changeMap + roster reconcile). Same-map reloads are
	 * skipped so checkpoint reloads keep their live mirrors; the follow-up
	 * loadingComplete reconcile remains authoritative when the roster is available.
	 */
	private cleanupStaleMirrorsForMapChange(): void {
		try {
			this.main.playersRosterReady = false;
			// A late changeMapResponse from the PREVIOUS transition must never be
			// consumed as this load's roster — onMapEnter's pending.then below repopulates
			// it for the in-flight transition.
			this.main.newInstanceMembers = undefined;
			const g: any = ig.game;
			const targetMap = g && (g.mapName || '');
			const prevMap = g && (g.previousMap || '');
			if (typeof prevMap !== 'string' || !prevMap || prevMap === targetMap) return;
			const pmap = this.main.playerMapByName || {};
			let removed = 0;
			for (const name in this.main.players) {
				const p = this.main.players[name];
				if (!p) continue;
				const knownMap = pmap[name];
				if (knownMap && knownMap === targetMap) continue;
				if (p.entity && !(p.entity as any)._killed) {
					try { (p.entity as any).kill(true); } catch (_) { /* ignore */ }
				}
				try { delete this.main.pendingFadeIn[name]; } catch (_) { /* ignore */ }
				delete this.main.players[name];
				this.main.players[name] = undefined;
				removed++;
			}
			if (removed > 0) {
				console.log('[multiplayer] map-change cleanup removed ' + removed + ' off-map mirror record(s) for ' + targetMap);
				try { this.main.wipeTags(); } catch (_) { /* ignore */ }
			}
		} catch (_) { /* never break a map load */ }
	}

	/** MEMBER-side: remove Enemy + EnemySpawner entities from the level data BEFORE
	 * loadLevel spawns them. Player mirrors are spawned at runtime (never part of
	 * data.entities), so they are unaffected. */
	private stripMemberEnemies(data: sc.MapModel.Map): void {
		try {
			const anyData = data as any;
			if (!anyData || !Array.isArray(anyData.entities)) return;
			const before = anyData.entities.length;
			anyData.entities = anyData.entities.filter((e: any) =>
				e && e.type !== 'Enemy' && e.type !== 'EnemySpawner');
			console.log('[multiplayer] member: stripped ' + (before - anyData.entities.length)
				+ ' local enemies/spawners from the level (host block drives puppets)');
		} catch (e) { /* never block a map load */ }
	}

	private loadEntity(name: string): void {
		new sc.EnemyType(name).load();
	}
}
