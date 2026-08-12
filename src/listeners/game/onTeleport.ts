import { Multiplayer } from '../../multiplayer';

export class OnTeleportListener {

	/** Generation token for deferred teleports: latest intent wins. A second
	 * teleport inside the ≤3s deferral window (server regroup, map edge, event)
	 * supersedes the first — without this both originals would fire and the
	 * overlap corrupts the teleport state (the exact black-screen wedge the
	 * watchdog exists to clean up). */
	private _teleportGen = 0;

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		const instance = this;
		// `ig.game` is the concrete `sc.CrossCode` instance at runtime; the
		// static type of the global is the broader `ig.Game`, so we bind through
		// a cast when wrapping `teleport`.
		const game = ig.game as sc.CrossCode;
		const original = game.teleport;
		game.teleport = function(this: sc.CrossCode, map: string, teleportPosition: any, hint?: any) {
			// A teleport while dead ends the death immediately (silent respawn —
			// the teleport places the player; the death pin must not keep writing
			// stale death-map coordinates afterwards).
			try {
				const m: any = (window as any).__mpMain;
				if (m && m.netSync && m.netSync.isLocalDead()) m.netSync.abortDeathForTeleport();
			} catch (_) { /* ignore */ }
			const gen = ++instance._teleportGen;
			// DEFER the real teleport until changeMapResponse arrives. Members must
			// know they are members BEFORE loadLevel runs, because a member whose
			// save never unlocked the target area would otherwise synchronously
			// spawn quest-gated enemies whose EnemyType onload wedges the map
			// Loader (infinite black loading). onMapEnter strips those entities
			// for members; host determination has to be synchronous by then.
			//
			// ROUND 10 (regroup leaves the player entity missing): the death-abort
			// above runs at teleport INTENT, but the real teleport fires up to 3s
			// later. netSync.tick early-returns once isTeleporting(), so that defer
			// window is the ONLY gap where checkOwnDeath can still re-enter death
			// (hide() the player) — loadLevel then completes with the player entity
			// hidden, i.e. "invisible until the next teleport". Re-run the abort at
			// the very last instant before the engine teleport actually starts.
			const fireTeleport = () => {
				try {
					const m: any = (window as any).__mpMain;
					if (m && m.netSync && m.netSync.isLocalDead()) m.netSync.abortDeathForTeleport();
				} catch (_) { /* ignore */ }
				// Round 21 (issue 1): 1s no-collision grace for ALL mirrors once the real
				// teleport actually starts — the new map's mirrors may overlap the local
				// player mid-load. The per-frame coll decision-maker
				// (netSync.updateRemoteMirrorFade) forces them to IGNORE until this deadline.
				try { if (instance.main.netSync) instance.main.netSync._mpMirrorGraceUntil = Date.now() + 1000; } catch (_) { /* ignore */ }
				if (gen === instance._teleportGen) original.call(this, map, teleportPosition, hint);
			};
			instance.onTeleport(map, teleportPosition, gen)
				.then(() => { fireTeleport(); })
				.catch(() => { fireTeleport(); });
			return undefined as any;
		} as typeof game.teleport;

		// Watchdog: if a teleport ever gets stuck (black screen — teleporting.active
		// never clears because the load wedged), force-reset the teleport state and
		// bounce to a known-good town instead of leaving the player staring at a
		// black screen forever. PAUSE-AWARE (round 6): ig.Game.update only consumes
		// teleporting.levelData while !paused, so a teleport queued with the
		// pause/main menu open is a LEGITIMATE wait, not a wedge — counting it made
		// the watchdog bounce menu-initiated teleports (the regroup black screen).
		let stuckTimer = 0;
		simplify.registerUpdate(() => {
			try {
				if (ig.game.isTeleporting()) {
					const g: any = ig.game;
					const mdl: any = (sc as any).model;
					const held = !!(g.paused
						|| (mdl && ((mdl.isMenu && mdl.isMenu()) || (mdl.isPaused && mdl.isPaused()))));
					if (!held) stuckTimer += ig.system.tick;
					if (stuckTimer > 15) {
						stuckTimer = 0;
						instance.recoverFromStuckTeleport();
					}
				} else {
					stuckTimer = 0;
				}
			} catch (e) { stuckTimer = 0; }
		});
	}

	/** Force-clear a wedged teleport and send the player to a safe town. */
	private recoverFromStuckTeleport(): void {
		try {
			console.warn('[multiplayer] teleport stuck >15s; forcing recovery to Rhombus Square');
			this.dumpLoaderState();
			// Engine-verified wedge: a resource requested during loadLevel whose onload
			// throws never finishes -> the map Loader's `_unloaded` never drains ->
			// `ig.loading` stays true -> ig.Game.update is gated -> the teleport never
			// completes AND no follow-up teleport's levelData is ever consumed. Unstick the
			// loader FIRST (force its end() so ig.loading flips false), or the recovery
			// teleport below would just queue its levelData behind the same stuck flag.
			this.forceUnstickLoader();
			const g: any = ig.game;
			if (g.teleporting) {
				g.teleporting.active = false;
				g.teleporting.timer = 0;
				g.teleporting.levelData = null;
			}
			ig.interact && (ig.interact as any).setBlockDelay && (ig.interact as any).setBlockDelay(0.1);
			// A clean landmark teleport to a shared town re-boots the map pipeline.
			g.teleport('rhombus-sqr.central');
		} catch (e) {
			console.error('[multiplayer] teleport recovery failed', e);
		}
	}

	/** If the current map Loader is wedged (ig.loading true, _unloaded non-empty), force it
	 * to finish so `ig.loading` flips false and the game loop un-gates. Each stuck resource
	 * key is force-erased; end() then runs finalize() -> ig.loading=false -> loadingComplete.
	 * Without this the recovery teleport is dead on arrival. */
	private forceUnstickLoader(): void {
		try {
			const res: any = (ig.game as any).currentLoadingResource;
			if (!(ig as any).loading) return; // not stuck in the loader
			if (res && typeof res === 'object' && Array.isArray(res._unloaded) && res._unloaded.length) {
				console.warn('[multiplayer] force-finishing wedged loader; dropping stuck resources: '
					+ JSON.stringify(res._unloaded));
				res._unloaded.length = 0;
				if (typeof res.end === 'function' && !res.done) {
					try { res.end(); } catch (e) { console.warn('[multiplayer] loader end() failed', e); }
				}
			}
			// Belt-and-braces: if loading is STILL true (end() threw), clear it directly.
			if ((ig as any).loading) { (ig as any).loading = false; }
		} catch (e) { /* ignore */ }
	}

	/** Dump the loader state so a black-screen wedge tells us EXACTLY which resource
	 * never finished. Engine facts (verified against game.compiled.js): a teleport
	 * wedges permanently when a resource requested during loadLevel never completes,
	 * because `ig.loading` stays true and gates `ig.Game.update` (so the next
	 * teleport's levelData is never consumed). The per-Loader `_unloaded` array lists
	 * `cacheType+path` for every unfinished resource. */
	private dumpLoaderState(): void {
		try {
			const g: any = ig.game;
			const res: any = g.currentLoadingResource;
			let info = '(no loader)';
			if (res && typeof res === 'object') {
				const unloaded = res._unloaded ? JSON.stringify(res._unloaded) : '?';
				// Are the "stuck" enemies actually loaded? (They may be loaded but the
				// loader never got their callback — a very different failure than a hang.)
				let enemyFlags = '';
				try {
					const cache = (ig as any).cacheList && (ig as any).cacheList.Enemy;
					if (cache) {
						for (const k of ['buffalo-alt', 'hedgehog-alt']) {
							const inst = cache[k];
							if (inst) enemyFlags += k + ':loaded=' + inst.loaded + ' failed=' + inst.failed + ' ';
						}
					}
				} catch (_) { /* ignore */ }
				info = '_unloaded=' + unloaded + ' done=' + res.done + ' resources=' + (res.resources ? res.resources.length : '?')
					+ ' _loadIndex=' + res._loadIndex + ' | ' + enemyFlags;
			} else if (typeof res === 'string') {
				info = '"' + res + '"';
			}
			console.warn('[multiplayer] LOADER STATE: ig.loading=' + (ig as any).loading
				+ ' crashed=' + (ig.system as any).crashed
				+ ' teleporting.levelData=' + (g.teleporting && g.teleporting.levelData ? 'set' : 'null')
				+ ' resourcesPending=' + ((ig as any).resources ? (ig as any).resources.length : '?')
				+ ' ' + info);
		} catch (e) { /* ignore */ }
	}
	public onTeleport(map: string, teleportPosition: any, gen?: number): Promise<void> {
		this.main.loadingMap = true;

		let marker: string | null = null;
		for (const key in teleportPosition) {
			const value = teleportPosition[key];
			if (value && typeof value === 'string') {
				marker = value;
				break;
			}
		}

		// Fire the changeMap request and stash the response promise. The wrapped
		// teleport WAITS for this (bounded by a 3s race) so onMapEnter knows the
		// host verdict synchronously when loadLevel runs. Derive the area from the
		// TARGET map name: at teleport time sc.map.currentPlayerArea still points
		// at the map we're leaving, so reading it would mis-classify towns and
		// split matchmaking instances.
		const conn = this.main.connection;
		if (!conn || !conn.isOpen()) {
			this.main.pendingChangeMap = undefined;
			return Promise.resolve();
		}
		const areaPath = this.main.getAreaPathOfMap(map);
		const areaType = this.main.getAreaTypeOfMap(map);
		const req = conn.changeMap(map, marker, areaPath, areaType);
		this.main.pendingChangeMap = req;
		const settled = req.then((result) => {
			// A newer teleport superseded this one: its response must NOT overwrite
			// the host flag (stale verdict for the wrong map).
			if (gen !== undefined && gen !== this._teleportGen) return;
			this.main.host = result.isHost;
			// Round 20: remember the NEW instance's host username for the " (Host)"
			// name-tag label (optional field — guarded against older servers).
			if (typeof result.host === 'string') this.main.instanceHost = result.host;
			// Round 21: host tick-rate latch on host-acquire (the response just told us
			// this client owns the new instance's enemies) — read once, not live.
			if (result.isHost) {
				try { if (this.main.netSync) this.main.netSync.setBlockInterval(this.main.getHostTickInterval()); } catch (e) { /* ignore */ }
			}
			console.log('[multiplayer] changeMapResponse: instance=' + result.instanceId + ' isHost=' + result.isHost);
		}).catch((e) => {
			console.warn('[multiplayer] changeMapResponse failed; teleport proceeds with previous host flag', e);
		});
		// Never soft-lock the player on a hung server: proceed after 3s either way
		// (the 15s stuck-teleport watchdog remains the last-resort safety net).
		const timeout = new Promise<void>((resolve) => setTimeout(resolve, 3000));
		return Promise.race([settled, timeout]);
	}
}
