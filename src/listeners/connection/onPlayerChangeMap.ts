import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { IPlayer } from '../../player';
import { wipeAllNameTags } from '../../ui/mpOptions';

export class OnPlayerChangeMapListener {
	/** Pending load-complete waiters. A queue (not a single slot) so two players
	 * entering during the same map load both get their mirror spawned — a single
	 * shared `cb` would be overwritten by the second, silently dropping the first. */
	private cbs: Array<() => void> = [];
	/** Players who entered while we were mid-teleport; spawned on loadingComplete. */
	private pendingSpawn: { [name: string]: { position: Vec3 } } = {};

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
			// Round 15: maintain the on-this-map roster (consumed by the netSync gate).
			if (this.main.playersOnThisMap) this.main.playersOnThisMap[player] = true;
			// If the game is mid-teleport (map loading), DON'T spawn yet — queue it and
			// let loadingComplete spawn every queued player. Spawning during a load is
			// what made map transitions hang / error. We still track the player record
			// (with no entity yet) so network updates for them are tolerated.
			if (ig.game.isTeleporting() || ig.game.entities.length === 0) {
				this.pendingSpawn[player] = { position };
				this.ensurePlayerRecord(player, position);
				return;
			}
			this.spawnMirror(player, position);
		} else {
			// Round 15: drop them from the on-this-map roster (see enters branch).
			if (this.main.playersOnThisMap) delete this.main.playersOnThisMap[player];
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
		const mirror = this.main.players[player];
		if (mirror && mirror.entity) {
			try { mirror.entity.kill(); } catch (_) { /* ignore */ }
		}
		this.main.players[player] = undefined;
		delete this.main.players[player];
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
				// Flush any deferred spawns (players who entered during the load).
				const pending = instance.pendingSpawn;
				instance.pendingSpawn = {};
				for (const name in pending) {
					instance.spawnMirror(name, pending[name].position);
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
					if (roster !== undefined) {
						for (const n of roster) keep.add(n);
						for (const n in pending) keep.add(n);
						instance.main.reconcilePlayerMirrorsAfterMapChange(keep);
						instance.main.newInstanceMembers = undefined;
					} else {
						for (const n in instance.main.players) {
							const p = instance.main.players[n];
							if (p && p.entity && !(p.entity as any)._killed) keep.add(n);
						}
					}
					const onMap: { [k: string]: boolean } = {};
					keep.forEach((n: string) => { onMap[n] = true; });
					instance.main.playersOnThisMap = onMap;
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
