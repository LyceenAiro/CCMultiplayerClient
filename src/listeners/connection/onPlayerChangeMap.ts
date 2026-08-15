import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { IPlayer } from '../../player';
import { dropNameTag, wipeAllNameTags } from '../../ui/mpOptions';

export class OnPlayerChangeMapListener {
	/** Pending load-complete waiters. A queue (not a single slot) so two players
	 * entering during the same map load both get their mirror spawned — a single
	 * shared `cb` would be overwritten by the second, silently dropping the first. */
	private cbs: Array<() => void> = [];
	/** Players who entered while we were mid-map-change; spawned on loadingComplete.
	 * Each entry carries the relayed sub-map so the flush/reconcile can skip members
	 * whose sub-map doesn't match ours (a town instance spans a whole area). */
	private pendingSpawn: { [name: string]: { position: Vec3, map?: string } } = {};

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onPlayerChangeMap(this.onPlayerChangeMap.bind(this));
		this.registerLoadCompleteHandler();
	}

	public onPlayerChangeMap(player: string,
		enters: boolean,
		position: Vec3,
		map: string,
		marker: string | null): void {
		if (enters) {
			// ROUND 82 (door transition visuals): if the same player's mirror is still
			// mid-leave-fade (quick door round-trip), finish it NOW so the fresh entry
			// spawns cleanly instead of leaving two mirrors.
			const prev = this.main.players[player];
			if (prev && prev.entity && (prev.entity as any)._mpFadeOutUntil) {
				try { (prev.entity as any).kill(true); } catch (_) { /* ignore */ }
				try { delete this.main.players[player]; } catch (_) { /* ignore */ }
			}
			// Main-city refactor: a town instance spans a whole AREA, so an entering
			// player may be on a DIFFERENT sub-map. Track their sub-map and only treat
			// them as "on this map" (and mirror them) when it matches OUR map.
			const myMap = ig.game ? (ig.game as any).mapName : '';
			if (this.main.playerMapByName) this.main.playerMapByName[player] = map || '';
			// Deferral window (changeMap sent, awaiting the response): ig.game.mapName
			// is still the OLD map and we are about to load a new one. Spawn NOW on the
			// old map (the upcoming load clears it) — spawning later at this stale
			// position on the NEW map is what left the host invisible when a member
			// follows immediately. No sameMap decision here (the map is stale).
			if (this.main.loadingMap && !ig.game.isTeleporting()) {
				if (this.main.playersOnThisMap) this.main.playersOnThisMap[player] = true;
				// Also queue them for the load-complete reconcile. The old-map spawn below
				// is cleared by the upcoming load, and the reconcile would otherwise rebuild
				// an EMPTY playerMapByName (our own changeMapResponse roster was empty
				// because the other client's changeMap landed a moment later — the
				// wipe+revive race), dropping this member and leaving isSoloInstance()
				// stuck true. Queueing keeps them in playerMapByName so the full sync resumes
				// and their mirror self-heals from their playerState.
				this.pendingSpawn[player] = { position, map: map || '' };
				this.spawnMirror(player, position);
				return;
			}
			// Actual level load: queue for loadingComplete (spawning mid-load hangs/errs).
			if (ig.game.isTeleporting() || ig.game.entities.length === 0) {
				this.pendingSpawn[player] = { position, map: map || '' };
				this.ensurePlayerRecord(player, position);
				// ROUND 82: the load-complete spawn is a door/teleport arrival — fade it in.
				this.main.pendingFadeIn[player] = true;
				return;
			}
			// Idle: a sameMap decision is reliable (a town instance spans a whole area).
			const sameMap = !map || map === myMap;
			if (this.main.playersOnThisMap) {
				if (sameMap) this.main.playersOnThisMap[player] = true;
				else delete this.main.playersOnThisMap[player];
			}
			if (!sameMap) {
				// Off-map member: never mirror them; clear any stale mirror/tag first.
				delete this.pendingSpawn[player];
				this.despawnMirror(player);
				return;
			}
			// ROUND 82: DON'T spawn at the relayed position — it is the SENDER'S OLD-MAP
			// position (the spot in front of the door they are leaving), not their real
			// destination. Record the player and let the first playerState from the new
			// map spawn the mirror at the REAL marker position (applyPlayerState's
			// no-mirror self-heal), with a fade-in so it doesn't pop.
			this.ensurePlayerRecord(player, position);
			const rec: any = this.main.players[player];
			if (rec && !rec.entity) {
				rec._mpWaitForStateUntil = Date.now() + 2500;
				this.main.pendingFadeIn[player] = true;
			}
		} else {
			// Round 15: drop them from the on-this-map roster (see enters branch).
			if (this.main.playersOnThisMap) delete this.main.playersOnThisMap[player];
			if (this.main.playerMapByName) delete this.main.playerMapByName[player];
			// Round 16: the party LEADER left our instance — they teleported to a NEW
			// instance on the other map, so we stop receiving botState blocks (we're on
			// the same map, so the map-mismatch cull never fires) and their puppets
			// freeze. Cull our local bot copies NOW; the 3s staleness timeout in
			// interpolateBotPuppets stays as backstop (covers leader disconnect, where
			// no leave event fires).
			if (player === this.main.partyLeader) {
				try { this.main.cullLocalBotEntities((sc as any).party); } catch (_) { /* ignore */ }
			}
			// A player LEFT our instance: despawn their mirror and drop any pending
			// spawn / tracked record for them.
			delete this.pendingSpawn[player];
			this.despawnMirror(player);
			// Round 22: belt-and-braces tag wipe — a stale cached tag can be re-shown
			// by addTagAt if a later name collides; mirrors the loadingComplete wipe.
			try { wipeAllNameTags(); } catch (_) { /* ignore */ }
		}
	}

	/** Spawn (or respawn) a player's mirror entity now. */
	private spawnMirror(player: string, position: Vec3): void {
		this.main.spawnMirrorAt(player, position);
	}

	/** Track a player with no live entity yet (they're mid-load); network updates
	 * will keep their last position so the eventual spawn is correctly placed. */
	private ensurePlayerRecord(player: string, position: Vec3): void {
		const existing = this.main.players[player];
		if (existing && existing.entity) return; // already have a live mirror
		this.main.players[player] = { name: player,
			position: { x: position.x, y: position.y, z: position.z },
			entity: undefined } as unknown as IPlayer;
	}

	private despawnMirror(player: string): void {
		try { delete this.main.pendingFadeIn[player]; } catch (_) { /* ignore */ }
		const mirror = this.main.players[player];
		if (mirror && mirror.entity) {
			const e: any = mirror.entity;
			// ROUND 82 (door transition visuals): fade the mirror out at the door for
			// ~450ms before killing it — an instant kill reads as a teleport. The record
			// stays in this.main.players during the fade so netSync's per-frame fade pass
			// still drives the alpha; the timeout then removes the entity + record.
			if (!e._mpFadeOutUntil) {
				e._mpFadeOutUntil = Date.now() + 450;
				e._mpFadeOutDur = 450;
				// A faded-out mirror must not keep drawing its under-feet HP bar.
				try { if (e.statusGui && e.statusGui.hook) e.statusGui.hook._visible = false; } catch (_) { /* ignore */ }
				setTimeout(() => {
					try {
						const cur = this.main.players[player];
						if (cur && cur.entity === e) {
							try { e.kill(true); } catch (_) { /* ignore */ }
							this.main.players[player] = undefined;
							delete this.main.players[player];
						} else if (e && !e._killed) {
							try { e.kill(true); } catch (_) { /* ignore */ }
						}
						try { if (this.main.netSync) this.main.netSync.forgetMirrorFade(e); } catch (_) { /* ignore */ }
					} catch (_) { /* ignore */ }
				}, 500);
			}
		} else {
			this.main.players[player] = undefined;
			delete this.main.players[player];
		}
		// Round 22: drop the cached name tag when a teammate leaves the map so it can't
		// linger at the last projected position (the per-frame loop only hides, never clears).
		try { dropNameTag(player); } catch (_) { /* ignore */ }
	}

	private registerLoadCompleteHandler(): void {
		// ig.Game.inject has NO deregistration and this register() runs on every
		// reconnect, so install the inject exactly once per process — otherwise each
		// reconnect stacks another loadingComplete layer (an ever-growing chain that
		// flushes a stale listener's empty queue; harmless but a leak). The per-
		// connection state (pendingSpawn/cbs) is read off `main`, which persists.
		if ((this.main as any)._loadCompleteInjectInstalled) return;
		(this.main as any)._loadCompleteInjectInstalled = true;
		const instance = this;
		ig.Game.inject({
			loadingComplete(this: any): void {
				this.parent();
				// Flush any deferred spawns (players who entered during the load), but
				// only for members whose relayed sub-map matches ours (town spans an area).
				const pending = instance.pendingSpawn;
				instance.pendingSpawn = {};
				const flushMap = ig.game ? (ig.game as any).mapName : '';
				for (const name in pending) {
					const rec = pending[name];
					if (rec && (!rec.map || rec.map === flushMap)) {
						instance.spawnMirror(name, rec.position);
					}
				}
				// Round 15: reconcile this instance's roster after the load. clearMap()
				// killed every old-map mirror, so drop stale player entries that are not
				// in the NEW instance roster (changeMapResponse members ∪ pendingSpawn
				// names); otherwise a stale playerState after the load respawns a LIVE
				// mirror at stale coords whose tag projects forever. Gate on the roster
				// being defined so a same-map checkpoint reload (no changeMap this load)
				// keeps its current mirrors. Rebuild playersOnThisMap from the keep set
				// (or from currently-live mirrors when there's no roster).
				try {
					const roster = instance.main.newInstanceMembers;
					const keep = new Set<string>();
					const myMap = ig.game ? (ig.game as any).mapName : '';
					const prevMap = (ig.game && (ig.game as any).previousMap) || '';
					const realChange = typeof prevMap === 'string' && !!prevMap && prevMap !== myMap;
					const prevPmap = instance.main.playerMapByName || {};
					const pmap: { [k: string]: string } = {};
					if (roster !== undefined) {
						// Main-city refactor: a town instance spans a whole area. Keep only
						// the members on OUR sub-map as mirrors, but remember EVERY member's
						// sub-map in playerMapByName so a stray playerState from an off-map
						// member is dropped by netSync's gate instead of spawning a wrong mirror.
						for (const m of roster) {
							if (!m || !m.name) continue;
							const map = m.map || myMap;
							pmap[m.name] = map;
							if (map === myMap) keep.add(m.name);
						}
						for (const n in pending) {
							const rec = pending[n];
							if (!rec) continue;
							// A player who entered WHILE we were loading (pendingSpawn) is not
							// in the changeMapResponse roster when their join landed after our
							// changeMap was answered (common on a full-party wipe where each
							// client reloads at a slightly different time). Remember their
							// sub-map in playerMapByName too, or isSoloInstance() would think we
							// are alone and collapse the whole sync to the ~1Hz solo beacon.
							const pm = rec.map || myMap;
							pmap[n] = pm;
							if (pm === myMap) keep.add(n);
						}
						instance.main.reconcilePlayerMirrorsAfterMapChange(keep);
						instance.main.newInstanceMembers = undefined;
					} else if (realChange) {
						// ROUND 83: the roster never arrived (response raced/failed or a
						// direct loadLevel), but this IS a real map change — clean stale
						// off-map records instead of the old "keep live mirrors" fallback,
						// which silently re-admitted departed players through the empty-
						// roster fail-open gate. playerMapByName entries for OFF-map members
						// are preserved so their late stale playerState is still dropped by
						// the map gate.
						for (const n in instance.main.players) {
							const p = instance.main.players[n];
							if (!p) { delete instance.main.players[n]; continue; }
							const known = prevPmap[n];
							if (known && known === myMap) {
								// Known on OUR target sub-map: keep the roster slot even when
								// its entity was killed by clearMap — the first playerState is
								// what respawns the mirror.
								keep.add(n);
								pmap[n] = myMap;
								continue;
							}
							if (p.entity && !(p.entity as any)._killed) {
								try { (p.entity as any).kill(true); } catch (_) { /* ignore */ }
							}
							try { dropNameTag(n); } catch (_) { /* ignore */ }
							try { delete instance.main.pendingFadeIn[n]; } catch (_) { /* ignore */ }
							delete instance.main.players[n];
							instance.main.players[n] = undefined;
						}
						for (const n in prevPmap) {
							if (pmap[n] === undefined) pmap[n] = prevPmap[n];
						}
						for (const n in pending) {
							const rec = pending[n];
							if (!rec) continue;
							const pm = rec.map || myMap;
							pmap[n] = pm;
							if (pm === myMap) keep.add(n);
						}
					} else {
						// No roster (same-map checkpoint reload): keep live mirrors.
						for (const n in instance.main.players) {
							const p = instance.main.players[n];
							if (p && p.entity && !(p.entity as any)._killed) { keep.add(n); pmap[n] = myMap; }
						}
					}
					const onMap: { [k: string]: boolean } = {};
					keep.forEach((n: string) => { onMap[n] = true; });
					instance.main.playersOnThisMap = onMap;
					instance.main.playerMapByName = pmap;
					// ROUND 83: the roster decision is final now — until the NEXT map load,
					// names not in playersOnThisMap are stale (even when the roster is empty).
					instance.main.playersRosterReady = true;
				} catch (_) { /* never break a map load */ }
				// Round 16: old-map name tags must never survive into the new map.
				// The reconcile block above killed stale mirrors + dropped their tags,
				// but cached tags can be re-shown by addTagAt (a name colliding with a
				// live player/bot) or resurrected before reconciliation — wipe EVERY
				// tag and let the per-frame applyNameTagsNow rebuild fresh from the
				// reconciled roster on the next frame.
				try { wipeAllNameTags(); } catch (_) { /* never break a map load */ }
				// Flush any load-complete waiters (legacy path).
				const cbs = instance.cbs;
				instance.cbs = [];
				for (const cb of cbs) cb.call(instance);
			},
		});
	}
}
