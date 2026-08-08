import { MultiplayerConfig } from './config';
import { IConnection } from './connection';
import { IEntityDefinition } from './entityDefinition';
import { OnKillEntityListener } from './listeners/connection/onKillEntity';
import { OnPlayerChangeMapListener } from './listeners/connection/onPlayerChangeMap';
import { OnRegisterEntityListener } from './listeners/connection/onRegisterEntity';
import { OnSetHostListener } from './listeners/connection/onSetHost';
import { OnThrownBallListener } from './listeners/connection/onThrowBall';
import { OnUpdateAnimationListener } from './listeners/connection/onUpdateAnimation';
import { OnUpdateAnimationTimerListener } from './listeners/connection/onUpdateAnimationTimer';
import { OnUpdateEntityAnimationListener } from './listeners/connection/onUpdateEntityAnimation';
import { OnUpdateEntityHealthListener } from './listeners/connection/onUpdateEntityHealth';
import { OnUpdateEntityPositionListener } from './listeners/connection/onUpdateEntityPosition';
import { OnUpdateEntityStateListener } from './listeners/connection/onUpdateEntityState';
import { OnUpdateEntityTargetListener } from './listeners/connection/onUpdateEntityTarget';
import { OnUpdatePositionListener } from './listeners/connection/onUpdatePosition';
import { EntityListener } from './listeners/game/entityListener';
import { OnEntityAnimationListener } from './listeners/game/onEntityAnimation';
import { OnEntityHealthChangeListener } from './listeners/game/onEntityHealthChange';
import { OnEntityMoveListener } from './listeners/game/onEntityMove';
import { OnEntitySpawnListener } from './listeners/game/onEntitySpawn';
import { OnEntityStateChangeListener } from './listeners/game/onEntityStateChange';
import { OnEntityTargetChangeListener } from './listeners/game/onEntityTargetChange';
import { OnEntityKilledListener } from './listeners/game/onKill';
import { OnMapEnterListener } from './listeners/game/onMapEnter';
import { OnMapLoadedListener } from './listeners/game/onMapLoaded';
import { OnPlayerAnimationListener } from './listeners/game/onPlayerAnimation';
import { OnPlayerHealthChangeListener } from './listeners/game/onPlayerHealthChange';
import { OnPlayerMoveListener } from './listeners/game/onPlayerMove';
import { OnTeleportListener } from './listeners/game/onTeleport';
import { PlayerListener } from './listeners/game/playerListener';
import { LoadScreenHook } from './loadScreenHook';
import { IMultiplayerEntity } from './mpEntity';
import { IPlayer } from './player';
import { IChangeMapResult } from './connection';
import { currentAreaPath, currentAreaType, areaPathOfMap, areaTypeOfMap, SHARED_TOWNS, hasUnlockedArea } from './util/areaUtil';
import { SocialOverlay } from './ui/socialOverlay';
import { dropNameTag, wipeAllNameTags } from './ui/mpOptions';
import { NetSync } from './sync/netSync';
import { installPvpIsolation } from './sync/pvpIsolation';
import { installGhostChests, IGhostChestsModule } from './sync/ghostChests';
import { t } from './i18n';

// CrossCode ships jQuery globally (declared in types.d.ts); overlays use it directly.

/** Round 17: the mod version. Sent with every handshake (SocketIOConnector);
 * the server rejects the connection unless it matches its own version (server
 * config.js `version` / protocol.js gate) — on FIRST connect AND every reconnect
 * (both go through the handshake). Bump TOGETHER with the server version + this
 * package.json on every release. */
export const MP_VERSION = '1.20.0';

// When true, the NEW whole-state sync (sync/netSync.ts) is active and the original
// mod's per-entity delta sync (registerEntity/updateEntity*/onEntitySpawn mirror
// spawn + per-frame player pos/anim senders) is disabled so the two never fight.
// netSync supersedes them: it self-heals (no packet-loss desync), uses stable map
// ids (no per-client random ids), and disables puppet AI so members mirror the host.
const USE_NET_SYNC = true;

export class Multiplayer {
	public futureEntities: IEntityDefinition[] = [];
	public players: {[name: string]: IPlayer | undefined} = {};
	/** Round 15: names currently on THIS map (rebuilt after every map load by
	 *  onPlayerChangeMap's loadingComplete, updated on enters/leaves). A later
	 *  netSync gate consumes it. */
	public playersOnThisMap: { [name: string]: boolean } = {};
	public config: MultiplayerConfig;
	public connection!: IConnection;
	public name?: string;
	public host = false;
	/** Round 20: the username of the CURRENT map-instance host. Seeded from
	 * changeMapResponse.host on map changes (onTeleport/onMapEnter) and kept fresh
	 * by the host's own playerPing relay (~1/s, isHost:true); the own tag reads
	 * main.host instead (the host never receives its own relay). Cleared on
	 * logout/server-loss. */
	public instanceHost?: string;
	/** Round 19: true while this client's server-side routing is pinned to
	 * solo:<user>:<map> (a story PVP duel in progress). The connector's changeMap
	 * re-sends isolated:true on ordinary teleports/reasserts while set (sticky),
	 * so the duel never leaks back into a shared/party instance. Reset on
	 * logout/server-loss (clearMultiplayerState) — the server clears the override
	 * on disconnect too. */
	public isolated = false;
	public loadingMap = false;
	/** One-shot: strip Enemy/EnemySpawner on the NEXT map load even when host
	 * (regroup into a never-visited area where we might own the instance —
	 * quest-gated local spawns could wedge the loader). Consumed by onMapEnter. */
	public mpForceStripNextLoad = false;
	public consumeForceStrip(): boolean {
		const v = this.mpForceStripNextLoad;
		this.mpForceStripNextLoad = false;
		return v;
	}
	/** True when the new whole-state block sync (sync/netSync.ts) drives enemies/players,
	 * so legacy per-entity hooks (spawn-register, kill-broadcast) stand down. */
	public get useNetSync(): boolean { return USE_NET_SYNC; }

	public entities: IMultiplayerEntity[] = [];

	private loadScreen!: () => void;
	private nextEID = 1;
	private entitySpawnListener!: OnEntitySpawnListener;
	private loadScreenHook = new LoadScreenHook();
	private pendingSaveRestore?: string;
	private _readyHookInstalled = false;
	private _pendingReady: Array<() => void> = [];
	private socialOverlay!: SocialOverlay;
	public netSync?: NetSync;
	/** Round 20: GHOST CHESTS sync module (party-aware chest visibility). Installed
	 * once; the session handle is re-bound every connect (initializeListeners). */
	public ghostChests?: IGhostChestsModule;
	/** netSync hook fired when this client is promoted to instance host (set in
	 * initializeListeners; respawns puppet enemies as real AI-driven ones). */
	public onPromotedToHost?: () => void;
	/** In-flight changeMap response, awaited by onMapEnter to decide enemy stripping. */
	public pendingChangeMap?: Promise<IChangeMapResult>;
	/** Round 19: a regroup/teleport request stashed because the LOCAL player was in a
	 * cutscene (a teleport mid-story would fight the story UI). Fired from the
	 * netSync onCutsceneEnd callback once the cutscene ends. Latest wins. */
	private _pendingRegroup: { kind: 'request', target?: string } | { kind: 'move', leader?: string, map?: string, pos?: Vec3 } | null = null;

	public getAreaPath(): string {
		return currentAreaPath();
	}
	public getAreaType(): number {
		return currentAreaType();
	}
	public getAreaPathOfMap(mapName: string): string {
		return areaPathOfMap(mapName);
	}
	public getAreaTypeOfMap(mapName: string): number {
		return areaTypeOfMap(mapName);
	}

	constructor(config?: MultiplayerConfig) {
		if (config) {
			this.config = config;
		} else {
			this.config = new MultiplayerConfig();
		}
	}

	public async load(): Promise<void> {
		await this.config.load();
	}

	public async waitForServerSelection(index: number): Promise<void> {
		this.connection = this.config.getConnection(this, index);
	}

	public initialize(): void {
		this.initializeGUI();
		this.disableFocus();
	}

	public async connect(): Promise<void> {
		const serverNumber = await this.loadScreenHook.displayServers(
			this.config.servers.map((server) => server.display ?? server.hostname),
			this.loadScreen);

		// Go back to previous sub state (out of the menu).
		sc.model.enterPrevSubState();

		await this.waitForServerSelection(serverNumber);

		const username = await this.showLogin();

		await this.connection.load();

		if (!this.connection.isOpen()) {
			console.log('[multiplayer] Connecting..');
			await this.connection.open(this.config.servers[serverNumber].hostname,
				this.config.servers[serverNumber].port,
				this.config.servers[serverNumber].type);
		}

		this.initializeListeners();

		console.log('[multiplayer] Logging in as ' + username);
		const result = await this.connection.identify(username);

		if (!result.success) {
			throw new Error('[multiplayer] Could not login! Is the user already logged in?');
		}

		// Remember the logged-in account name (drives the in-game party name and
		// per-account social scoping). Reset the logout latch so a second session on
		// this same client process logs out cleanly again (installExitHooks' guard).
		this.name = username;
		(this as any)._loggedOut = false;
		(this as any)._disconnectHandled = false;
		this.installExitHooks();

		// Prime the social caches immediately so the menu shows real values on first
		// open (don't wait for the 3s pump): online count, our own profile, friends.
		try { this.connection.onlineCount(); } catch (e) { /* ignore */ }
		try { this.connection.friendList(); } catch (e) { /* ignore */ }

		// Belt-and-braces for "friends only appear after re-adding": the server pushes
		// friendList right after handshake, but if that ever races the handler wiring,
		// re-request it shortly after identify (by which time onFriendList is certain
		// to be registered). Idempotent — a duplicate list just rebuilds the contacts.
		setTimeout(() => {
			try { if (this.connection && this.connection.isOpen()) this.connection.friendList(); } catch (e) { /* ignore */ }
		}, 1000);

		// Lobby architecture: the server no longer forces everyone onto one map.
		// `host` here only means "you are the authority for your own solo world"
		// until you join a shared instance (changeMap decides the real per-instance
		// host). We always start as our own host so enemies spawn locally.
		this.host = true;

		// Round 16 (issue 4): read the server's per-extra-party-member enemy max-HP
		// fraction off the handshake (handshakeResponse.hpScale, default 0.5) and hand
		// it to netSync, which scales monster max/current HP by party size at spawn —
		// HOST side only (members' puppets are locked mirrors of host enemies).
		if (typeof result.hpScale === 'number' && isFinite(result.hpScale)) this.mpHpScale = result.hpScale;
		try { if (this.netSync) this.netSync.setHpScale(this.mpHpScale); } catch (_) { /* ignore */ }

		// If the server has a save for us, restore it instead of starting fresh.
		if (result.save && result.save.data) {
			this.pendingSaveRestore = result.save.data;
			console.log('[multiplayer] Server save found; will restore on game start');
		} else {
			console.log('[multiplayer] No server save; starting from local/new game');
		}
	}

	public registerEntity(entity: ig.Entity): number {
		const converted = entity as IMultiplayerEntity;
		converted.multiplayerId = this.nextEID;
		this.entities[this.nextEID] = converted;
		this.nextEID++;

		return converted.multiplayerId;
	}

	public spawnMultiplayerEntity(e: IEntityDefinition): any {
		const type = e.settings && (e.settings as any).enemyInfo && (e.settings as any).enemyInfo.type;
		if (!type) {
			console.warn('[multiplayer] spawnMultiplayerEntity: missing enemyInfo.type for id ' + e.id +
				' (non-serializable settings?), skipping');
			return;
		}

		new sc.EnemyType(type).load(() => {
			// Spawn DIRECTLY (skipHook), like the original mod — do NOT route through
			// onEntitySpawned. That path is the host's "register + broadcast" logic with
			// early-return branches (unknown type / not-yet-host), so a member going
			// through it could silently never create the mirror -> enemy frozen at spawn.
			const entity: IMultiplayerEntity = ig.game.spawnEntity('Enemy', e.pos.x, e.pos.y, e.pos.z,
				Object.assign({}, e.settings, { skipHook: true })) as IMultiplayerEntity;

			// spawnEntity returns null when a spawnCondition/_killed blocks it.
			if (!entity) {
				console.warn('[multiplayer] spawnMultiplayerEntity: spawnEntity returned null for id ' + e.id + ' type ' + type);
				return;
			}

			const me = this.entities[e.id] = entity as IMultiplayerEntity;
			me.multiplayerId = e.id;
			this.lockEntity(me, e.pos);
		});
	}

	/**
	 * Locks a network-driven mirror entity's position/animation/face/state so the
	 * 1.4.2 physics & animation systems can't overwrite the values we push from
	 * the network. External writes are dropped (with a log); the network path
	 * updates the entity by writing the `xProtected`/`{protected: ...}` backing
	 * fields (see copyEntityPosition / setEntityAnimationProtected).
	 *
	 * Used both for enemy mirrors (spawnMultiplayerEntity) and player mirrors
	 * (onPlayerChangeMap), which is why it is factored out.
	 */
	public lockEntity(entity: IMultiplayerEntity, pos: Vec3): void {
		const protectedPos = {xProtected: pos.x, yProtected: pos.y, zProtected: pos.z};
		Object.defineProperty(protectedPos, 'x', { get() { return protectedPos.xProtected; }, set() { return; } });
		Object.defineProperty(protectedPos, 'y', { get() { return protectedPos.yProtected; }, set() { return; } });
		Object.defineProperty(protectedPos, 'z', { get() { return protectedPos.zProtected; }, set() { return; } });
		Object.defineProperty(entity.coll, 'pos',
			{ get() { return protectedPos; }, set() { /* network-driven: drop physics writes */ } });

		let protectedAnim = entity.currentAnim;
		Object.defineProperty(entity, 'currentAnim', {
			get() { return protectedAnim; },
			set(data) { if (data && (data as any).protected) { protectedAnim = (data as any).protected; } },
		});

		const protectedFace = entity.face ? {xProtected: entity.face.x, yProtected: entity.face.y}
			: {xProtected: 0, yProtected: 0};
		Object.defineProperty(protectedFace, 'x', {get() { return protectedFace.xProtected; }, set() { return; } });
		Object.defineProperty(protectedFace, 'y', {get() { return protectedFace.yProtected; }, set() { return; } });
		Object.defineProperty(entity, 'face',
			{ get() { return protectedFace; }, set() { /* network-driven: drop physics writes */ } });

		let protectedState = entity.currentState;
		Object.defineProperty(entity, 'currentState', {
			get() { return protectedState; },
			set(data) { if (data && (data as any).protected) { protectedState = (data as any).protected; } },
		});
	}

	/** Writes a network-supplied animation/face through the entity's lock. */
	public setEntityAnimationProtected(entity: ig.ActorEntity, face: Vec2, anim: string): void {
		(entity.face as any).xProtected = face.x;
		(entity.face as any).yProtected = face.y;
		entity.currentAnim = {protected: anim} as unknown as string;
	}

	public copyPosition(from: Vec3, to: Vec3) {
		to.x = from.x;
		to.y = from.y;
		to.z = from.z;
	}
	public copyEntityPosition(from: Vec3, to: any) {
		// Use `in`, not truthiness: a mirror exactly at x=0 has xProtected===0 (falsy)
		// and would wrongly fall through to the plain copy, which the lock's setter
		// then discards (dropping that frame's position update).
		if (!('xProtected' in to)) {
			return this.copyPosition(from, to);
		}

		to.xProtected = from.x;
		to.yProtected = from.y;
		to.zProtected = from.z;
	}

	/**
	 * Remote-player mirror upkeep, called once per tick from update(). Round 19:
	 * the collision + cutscene-fade write moved into netSync's single decision-maker
	 * (updateRemoteMirrorFade, see sync/netSync.ts) so the shared-town IGNORE rule
	 * and the cutscene-fade rule can never write conflicting values. This method
	 * keeps the mirror SPAWN safety net + captures the mirror's base collision type
	 * (netSync reads it back), so a mirror that enters mid-load still appears.
	 */
	public refreshTownCollision(): void {
		for (const name in this.players) {
			const player = this.players[name];
			if (!player) continue;
			// Safety net: if the map has finished loading but this player's mirror was
			// never spawned (entered during the load), spawn it now at its last known
			// position so they're not permanently invisible.
			if (!player.entity && !ig.game.isTeleporting() && ig.game.entities.length !== 0) {
				this.spawnMirrorAt(name, player.position);
				continue;
			}
			const entity = player.entity;
			if (!entity || !entity.coll) continue;
			const e = entity as any;
			if (e._mpBaseCollType === undefined) e._mpBaseCollType = entity.coll.type;
			// Round 19: the actual coll.type write is owned by netSync (town + fade).
		}
	}

	/** Roster of the instance we most recently joined (from changeMapResponse
	 *  `members`), round 15. undefined = no changeMap completed for this load. */
	public newInstanceMembers?: string[];

	/** Round 15: the LOCAL player changed maps. clearMap() killed every old-map
	 *  mirror but this.players still references them, and the server never tells
	 *  the leaver which players it left. A stale playerState after the load then
	 *  hits applyPlayerState's dead-mirror branch, respawning a LIVE mirror whose
	 *  tag the name-tag loop projects forever. Drop every entry not in the new
	 *  instance's roster (changeMapResponse members ∪ pendingSpawn names), killing
	 *  live stragglers + hard-removing their tags. Kept entries still holding a
	 *  stale corpse are cleared so re-entry can spawn them fresh. */
	public reconcilePlayerMirrorsAfterMapChange(keep: Set<string>): void {
		try {
			// Round 19: a map change voids every cutscene puppet + cached mirror
			// fade state (mirrors are being recreated for the new map).
			try { if (this.netSync) this.netSync.clearCsPuppets(); } catch (_) { /* ignore */ }
			for (const name in this.players) {
				const p = this.players[name];
				if (keep.has(name)) {
					if (!p || !p.entity || (p.entity as any)._killed) delete this.players[name];
					continue;
				}
				if (p && p.entity) { try { (p.entity as any).kill(true); } catch (_) { /* ignore */ } }
				try { dropNameTag(name); } catch (_) { /* ignore */ }
				delete this.players[name];
			}
		} catch (_) { /* never break a map load */ }
	}

	/** Spawns a player's mirror at a given position (shared helper so both the
	 * changeMap listener and the per-frame safety net can use it). */
	public spawnMirrorAt(player: string, position: Vec3): void {
		if (!position) return;
		// Idempotent: if this player already has a live mirror (e.g. the loadingComplete
		// flush and the per-frame safety net both fire), don't spawn a second one — the
		// first would be orphaned as an uncontrollable ghost.
		const existing = this.players[player];
		if (existing && existing.entity) return;
		// Make sure the 'multiplayer' enemy type is loaded before spawning (the
		// original mod did this via loadMpEntity() — without it the spawn can produce
		// an invisible/broken mirror if the resource isn't resident yet).
		new sc.EnemyType('multiplayer').load(() => this.spawnMirrorNow(player, position));
	}

	/** Actually creates the mirror entity (called once the enemy type is loaded). */
	private spawnMirrorNow(player: string, position: Vec3): void {
		// Re-check idempotency: another path may have spawned the mirror while the
		// enemy type was loading.
		const existing = this.players[player];
		if (existing && existing.entity) return;
		try {
			const entity: IMultiplayerEntity = ig.game.spawnEntity('Enemy', position.x, position.y, position.z, {
				name: player,
				enemyInfo: { type: 'multiplayer', group: '', party: 'PLAYER' },
				// NO mapId: the original hardcoded mapId:233 collides with a real map Prop
				// (bergen-trail path-1-entrance/path-2 both have a Prop with mapId 233), and
				// spawnEntity unconditionally does mapEntities[233]=mirror, clobbering it. Mirror
				// sync is keyed by players[name], never by mapId, so omitting it (mapId 0 = no
				// stable id, not registered) is collision-free and loses nothing.
				skipHook: true,
			} as any) as IMultiplayerEntity;
			if (!entity) { console.warn('[multiplayer] mirror spawn returned null for ' + player); return; }
			// Mark it as one of OUR remote-player mirrors so the non-host ghost sweep
			// (onMapEnter.sweepSpawnedEnemies, which kills every Enemy with no
			// multiplayerId) doesn't delete the mirror — mirrors are Enemy-typed and
			// have no multiplayerId, so without this tag they're indistinguishable
			// from a map-spawned ghost enemy.
			(entity as any)._mpMirror = true;
			entity.proxies = ig.game.playerEntity.proxies;
			this.lockEntity(entity, position);
			this.players[player] = { name: player,
				position: { x: position.x, y: position.y, z: position.z },
				entity } as IPlayer;
			console.log('[multiplayer] mirror spawned for ' + player + ' @ ' + Math.round(position.x) + ',' + Math.round(position.y) + ' map=' + ig.game.mapName);
		} catch (e) {
			console.error('[multiplayer] spawnMirrorAt failed for ' + player, e);
		}
	}

	private initializeGUI(): void {
		const buttonNumber = ig.platform === 1 ? 2 : 1;

		// FRAGILE: this reaches into the title screen by fixed child/button
		// indices. It worked on 1.1.0 and the structures still exist in 1.4.x,
		// but if Radical Fish reordered the title screen it will simply not find
		// the button — warn loudly instead of crashing so the cause is obvious.
		const title = ig.gui.guiHooks.find((hook) => hook.gui instanceof sc.TitleScreenGui);
		const titleButtonGui = title?.children[2]?.gui as sc.TitleScreenButtonGui | undefined;
		const buttons = titleButtonGui?.buttons;

		if (!buttons || !buttons[buttonNumber]) {
			console.warn('[multiplayer] Could not locate the title-screen button to hijack; ' +
				'the title screen layout may have changed in this game version. Multiplayer unavailable.');
			return;
		}

		buttons[buttonNumber].setText(t('titleConnect'), true);
		this.loadScreen = buttons[buttonNumber].onButtonPress;
		buttons[buttonNumber].onButtonPress = this.startConnect.bind(this);
	}

	private initializeListeners(): void {
		// Game-side hooks (simplify.registerUpdate, ig.*.inject, setInterval) have NO
		// deregistration, so installing them again on a second connect would double
		// every per-frame packet / overlay / interval. Install them exactly once per
		// client process; only the connection-bound callbacks (which point at the new
		// socket) are re-wired below.
		if (!(this as any)._gameListenersInstalled) {
			(this as any)._gameListenersInstalled = true;
			this.initializeGameHooks();
			// Expose the instance for the NetSync enemy-puppet inject (Enemy.update runs
			// outside our class scope, so it reaches the host flag via this global).
			(window as any).__mpMain = this;
		}
		this.initializeConnectionHooks();
		// New whole-state sync (players + host enemy block). Re-wired each connect so it
		// binds to the current socket; the inject inside is once-guarded.
		this.netSync = new NetSync(this);
		this.netSync.install();
		// Round 19: PVP-duel isolation — sc.pvp observer + isolated reasserts
		// (same game-side territory as netSync; sc.pvp exists from game init).
		// Once-guarded inside, so re-running every connect cannot double-register.
		installPvpIsolation(this);
		// Round 20: ghost-chest sync (party-aware chest visibility). Installed once
		// (wraps Chest._reallyOpenUp + a simplify.registerUpdate pump); the returned
		// handle is re-bound here every connect and its server events are wired to
		// the current socket below.
		this.ghostChests = installGhostChests(this);
		this.connection.onChestOpenedBy((key, by) => {
			try { this.ghostChests && this.ghostChests.onOpenedBy(key, by); } catch (_) { /* ignore */ }
		});
		this.connection.onChestState((opened) => {
			try { this.ghostChests && this.ghostChests.onChestState(opened); } catch (_) { /* ignore */ }
		});
		// Round 17 (issue 1): the HOST's real enemy started an attack — relayed to the
		// instance. Replay it on the matching member-side puppet toward the local player
		// (puppets no longer run local AI; this keeps round-2 monster-attacks-members at
		// host-determined moments).
		this.connection.onEnemyAttack((uid, anim) => {
			try { this.netSync && this.netSync.applyEnemyAttack(uid, anim); } catch (_) { /* ignore */ }
		});
		// Host migration: respawn puppet enemies as real AI-driven ones.
		this.onPromotedToHost = () => { try { this.netSync && this.netSync.promoteToHost(); } catch (e) { /* ignore */ } };
		// Round 19: fire a regroup/teleport request stashed while the local player
		// was in a cutscene (requestRegroup / regroupToPartyLeader stash it there).
		this.netSync.onCutsceneEnd = () => { try { this.firePendingRegroup(); } catch (e) { /* ignore */ } };
	}

	/** Per-process game hooks: entity/player listeners, update pump, save sync.
	 * Registered ONCE (simplify/inject have no unregister). */
	private initializeGameHooks(): void {
		const entityListener = new EntityListener(this);
		const playerListener = new PlayerListener(this);

		entityListener.register();
		playerListener.register();

		// Keep remote-player mirror collision in sync with whether we're in a
		// shared town (walk-through in town, solid elsewhere).
		simplify.registerUpdate(() => this.refreshTownCollision());

		// Round 13: per-frame lerp of member-side puppet bots toward the leader's
		// botState targets (once-guarded — registerUpdate has no deregistration).
		simplify.registerUpdate(() => this.interpolateBotPuppets());

		const playerMove = new OnPlayerMoveListener(this);
		const playerAnimation = new OnPlayerAnimationListener(this);
		const playerHealth = new OnPlayerHealthChangeListener(this);
		const entityMove = new OnEntityMoveListener(this);
		const entityAnimation = new OnEntityAnimationListener(this);
		const entityHealthChange = new OnEntityHealthChangeListener(this);
		const entityTargetChange = new OnEntityTargetChangeListener(this);
		const entityStateChange = new OnEntityStateChangeListener(this);

		// Enemy state (pos/anim/hp) is now driven by the host's ~15Hz whole-map block
		// (sync/netSync.ts), and player state by the per-frame playerState stream. The
		// original mod's per-entity delta listeners + heartbeat are disabled (USE_NET_SYNC)
		// so they can't double-drive or fight the block. Player pos/anim senders are
		// disabled too (netSync streams them); playerHealth stays (it feeds the party
		// HUD via updatePlayerStats).
		playerMove.register(playerListener);
		playerAnimation.register(playerListener);
		playerHealth.register(playerListener);
		if (!USE_NET_SYNC) {
			entityMove.register(entityListener);
			entityAnimation.register(entityListener);
			entityHealthChange.register(entityListener);
			entityTargetChange.register(entityListener);
			entityStateChange.register(entityListener);

			// Host heartbeat: re-push position + hp for every live enemy a few times a
			// second (the change-only listeners above miss late joiners).
			let hbTimer = 0;
			const hbLast = new Map<number, { x: number, y: number, z: number, hp: number }>();
			simplify.registerUpdate(() => {
				if (!this.host) return;
				hbTimer -= ig.system.tick;
				if (hbTimer > 0) return;
				hbTimer = 0.4; // ~2.5x/sec
				for (const id in this.entities) {
					const ent: any = this.entities[id];
					if (!ent || !ent.multiplayerId || !ent.coll || ent._killed) continue;
					const pos = ent.coll.pos;
					const hp = ent.params ? ent.params.currentHp : 0;
					const last = hbLast.get(ent.multiplayerId);
					const posChanged = !last || last.x !== pos.x || last.y !== pos.y || last.z !== pos.z;
					const hpChanged = !last || last.hp !== hp;
					if (posChanged) {
						try { this.connection.updateEntityPosition(ent.multiplayerId, { x: pos.x, y: pos.y, z: pos.z }); } catch (e) { /* ignore */ }
					}
					if (hpChanged) {
						try { this.connection.updateEntityHealth(ent.multiplayerId, hp); } catch (e) { /* ignore */ }
					}
					if (posChanged || hpChanged) hbLast.set(ent.multiplayerId, { x: pos.x, y: pos.y, z: pos.z, hp });
				}
			});
		}

		const mapEnter = new OnMapEnterListener(this);
		const teleport = new OnTeleportListener(this);
		const killed = new OnEntityKilledListener(this);
		const spawn = new OnEntitySpawnListener(this);
		const mapLoaded = new OnMapLoadedListener(this);

		mapEnter.register();
		teleport.register();
		killed.register();
		spawn.register();
		mapLoaded.register();

		this.entitySpawnListener = spawn;

		this.registerSocial();
		this.registerSaveSync();
	}

	/** Connection-bound callbacks. Safe to re-run on every connect: they attach to
	 * the CURRENT connection/socket (the old socket is gone), so nothing doubles. */
	private initializeConnectionHooks(): void {
		const setHost = new OnSetHostListener(this);
		const playerChange = new OnPlayerChangeMapListener(this);
		const updatePosition = new OnUpdatePositionListener(this);
		const updateAnim = new OnUpdateAnimationListener(this);
		const updateAnimTimer = new OnUpdateAnimationTimerListener(this);
		const registerEntity = new OnRegisterEntityListener(this);
		const killEntity = new OnKillEntityListener(this);
		const throwBall = new OnThrownBallListener(this);
		const entityPosition = new OnUpdateEntityPositionListener(this);
		const entityAnim = new OnUpdateEntityAnimationListener(this);
		const entityState = new OnUpdateEntityStateListener(this);
		const entityTarget = new OnUpdateEntityTargetListener(this);
		const entityHealth = new OnUpdateEntityHealthListener(this);

		setHost.register();
		playerChange.register();
		throwBall.register();
		if (!USE_NET_SYNC) {
			// Old per-entity delta sync — superseded by netSync's playerState stream +
			// host entity block. Registering these too would double-drive the same
			// mirrors (stale-change events overwriting the 15Hz block) and re-spawn
			// enemies with random ids alongside the mapId puppets.
			updatePosition.register();
			updateAnim.register();
			updateAnimTimer.register();
			registerEntity.register();
			killEntity.register();
			entityPosition.register();
			entityAnim.register();
			entityState.register();
			entityTarget.register();
			entityHealth.register();
		}

		// Overlay: created once, but wireConnection() MUST run every connect — the
		// socket is recreated per session, and binding the party-invite callback to
		// the first session's socket is exactly why invites died after re-login
		// (round-7 bug).
		if (!this.socialOverlay) this.socialOverlay = new SocialOverlay(this);
		this.socialOverlay.registerOnce();
		this.socialOverlay.wireConnection();

		this.registerLobbySocial();
	}

	/**
	 * Party + social callbacks + the profile/online-count pump.
	 *
	 * PARTY MODEL: remote party members are REAL network-controlled mirrors (the
	 * same kind this.players already renders in shared towns), NOT the game's
	 * single-player follower AI bots. So we do NOT call sc.party.addPartyMember —
	 * the party-instance routing in world.js (party:<partyId>:<map>) already puts
	 * party members on the same map, and onPlayerChangeMap spawns their real
	 * mirrors. The Social party box is fed from the roster via injected models.
	 */
	private registerLobbySocial(): void {
		const conn = this.connection;

		conn.onPartyUpdate((party) => {
			this.partyMembers = party ? party.members.slice() : [];
			this.partyLeader = party ? party.leader : undefined;
			this.applyPartyRoster(this.partyMembers);
			if (!party) {
				// Round 13: party disbanded/kicked -> drop every synced follower bot for
				// good. This runs BEFORE applyPartyBots' party-size gates could skip the
				// cleanup (applyPartyBots([]) alone never fired: partyMembers is emptied
				// first, hitting its early return, so member bots kept following the
				// ex-member into solo).
				this.clearSyncedPartyBots();
				// Round 16: roster lost members (kick received / leave / disband) -> wipe
				// EVERY name tag so a kicked/left player's tag can't linger at its last
				// projected position. The per-frame applyNameTagsNow rebuilds fresh for
				// whatever is still live next frame.
				try { wipeAllNameTags(); } catch (_) { /* ignore */ }
				// Round 16: party lost on a wild map -> self-reload it as solo host
				// (kick received / voluntary leave / 2-person disband all surface here).
				// The teleport wrapper awaits changeMapResponse, which flips host=true
				// BEFORE loadLevel, so onMapEnter's strip gate (!host) skips stripping and
				// the real enemies spawn — otherwise the stripped map + missing host
				// blocks leave every monster frozen.
				this.reloadAfterPartyLoss();
			}
			// Round 16 (issue 4): the roster changed (join/leave/disband) — the instance
			// HOST rescales live enemies to the new party-size HP multiplier. Members
			// no-op (their puppets mirror host enemies); guarded so a mid-lifecycle
			// netSync can't break the roster handler.
			try { if (this.netSync) this.netSync.rescaleLiveEnemies(); } catch (_) { /* ignore */ }
			// Round 13: keep the leader-side botState stream in sync with leadership and
			// roster (starts when we lead a multi-member party, stops on leave/disband/
			// leader change/party empty).
			this.syncBotStream();
		});

		// After accepting an invite the server tells us to regroup: disband our
		// current party (server already did) and teleport next to the leader.
		conn.onPartyMove((data) => {
			this.regroupToPartyLeader(data && data.leader, data && data.map, data && data.pos);
		});

		// Server nudge (e.g. someone just joined OUR party): re-assert our current
		// instance so both ends end up in the same instance and spawn each other's
		// mirror. changeMap is idempotent server-side (leave + rejoin same instance).
		// ROUND 10: the server now migrates instances itself on party-up, but this
		// reassert stays as belt-and-braces — and it now RETRIES when it arrives
		// mid-teleport instead of being silently dropped forever (that drop was one
		// half of the "同图组队互不可见" bug).
		conn.onPartyReSync(() => {
			this.reassertWhenReady(0);
		});

		// Round 11: the HOST broadcasts the native party bots in the roster; member
		// clients spawn their own local follower copies so everyone sees them.
		conn.onPartyBots((bots) => {
			this.applyPartyBots(bots);
		});

		// Round 13: the party LEADER streams live bot state (pos/anim/hp/level) ~15 Hz;
		// members apply it to their local puppet copies (their own bot AI is suppressed).
		conn.onBotState((data) => {
			this.applyBotState(data);
		});

		// Round 17: remote players report their own RTT once per second; the server
		// relays it to the instance as playerPing. Cache it by name so the 显示ping值
		// name-tag label can append it to a teammate's tag. Ignore our own echoes
		// (the own tag always shows the LOCAL connector pingMs instead).
		conn.onPlayerPing((name, ping, isHost) => {
			try {
				if (!name || name === this.name) return;
				// Round 20: the reporter is the map-instance host — record it so the
				// name-tag loop shows " (Host)" instead of its ping. The host never
				// receives its own relay (the own tag reads main.host instead), and host
				// migration self-corrects within ~1s via the next host's pingReport.
				if (isHost) this.instanceHost = name;
				if (typeof ping === 'number' && isFinite(ping) && ping >= 0) this.remotePings[name] = Math.round(ping);
			} catch (_) { /* ignore */ }
		});

		// Live HP/SP for the in-game party HUD (top-left bars). Fired per-change by each
		// client about itself, so it's near-real-time (no 3s wait). Write straight onto
		// the injected PartyMemberModel — that's exactly what HpHudBarGui/SpMiniHudGui read.
		conn.onPlayerStats((player, stats) => {
			try {
				if (!player || player === this.name) return;
				const model: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[player];
				if (model && model.params) {
					const p: any = model.params;
					const hpBefore = p.currentHp;
					if (typeof stats.hp === 'number') p.currentHp = stats.hp;
					if (typeof stats.maxHp === 'number' && stats.maxHp > 0 && p.baseParams) p.baseParams.hp = stats.maxHp;
					if (typeof stats.sp === 'number') p.currentSp = stats.sp;
					if (typeof stats.maxSp === 'number' && stats.maxSp > 0) p.maxSp = stats.maxSp;
					// Round 18 (issue 3): the top-left HpHudBarGui is observer-driven —
					// notify on a real currentHp change so the bar tracks live.
					if (p.currentHp !== hpBefore) {
						try { (sc as any).Model.notifyObserver(p, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
					}
				}
				// Keep the live mirror entity in sync too (for combat reads on it).
				// Round 18 (issue 3): the mirror's under-feet StatusBar is observer-driven
				// too — same notify treatment so a direct write can't leave it frozen.
				const pl = this.players[player];
				if (pl && pl.entity && pl.entity.params && typeof stats.hp === 'number') {
					const ep: any = pl.entity.params;
					const eBefore = ep.currentHp;
					ep.currentHp = stats.hp;
					if (ep.currentHp !== eBefore) {
						try { (sc as any).Model.notifyObserver(ep, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
					}
				}
			} catch (e) { /* ignore */ }
		});

		// Friend requests surface as a single accept/decline box — handled by the
		// Social-menu module (ui/socialMenuInject.ts wireConnection). Registering a
		// second onFriendRequest here would stack TWO popups per request.

		// Real remote-player profiles for the Social info box. Cache them AND push
		// them onto the injected PartyMemberModel so the native info box reads the
		// right stats/gear directly.
		conn.onPlayerProfile((player, profile) => {
			const isNew = !this.playerProfiles[player];
			this.playerProfiles[player] = profile;
			// If we got a profile for someone with no injected model yet (e.g. a party
			// member whose roster update is still in flight), build it now so the HUD /
			// party box read real values instead of the cloned placeholder.
			try {
				if (this.name && player !== this.name && (sc as any).party && (sc as any).party.models
					&& !(sc as any).party.models[player]) {
					this.ensureMpModel(player);
				}
			} catch (e) { /* ignore */ }
			this.applyProfileToModel(player);
			if (isNew) {
				const mdl: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[player];
				console.log('[multiplayer] got profile for ' + player + ': lvl=' + (profile && profile.level) +
					' hp=' + (profile && profile.hp) + ' equip=' + JSON.stringify(profile && profile.equip) +
					' | model' + (mdl ? ' applied(lvl=' + mdl.level + ' hp=' + (mdl.params && mdl.params.getStat && mdl.params.getStat('hp')) + ')' : ' MISSING (not injected yet)'));
			}
		});

		// Server online count — cached here so the top-bar chip always has a value.
		conn.onOnlineCount((count) => {
			this.onlineCount = count;
		});

		// Pull presence so friend online/offline dots update live.
		conn.onPresence((player, online) => {
			this.friendPresence[player] = online;
			this.updateMpContactOnline(player, online);
			if (!online) {
				// They went offline: drop their stale profile so the info card shows
				// the blank "offline" state instead of their last-seen (wrong) gear.
				delete this.playerProfiles[player];
			}
			// Someone came online/offline -> the count changed; refresh it.
			try { this.connection.onlineCount(); } catch (e) { /* ignore */ }
			// If the social menu is open, refresh its friend dots live.
			this.refreshOpenSocialMenu();
		});

		// Broadcast OUR real profile + pull the online count periodically. Runs on
		// the global update hook (fires on title + in-game), throttled by tick.
		// registerUpdate has NO deregistration and registerLobbySocial runs on every
		// reconnect, so guard it to install exactly once — otherwise each reconnect
		// adds another pump and our profile/count get reported 2x, 3x, ...
		if (!(this as any)._socialPumpInstalled) {
			(this as any)._socialPumpInstalled = true;
			let timer = 0;
			simplify.registerUpdate(() => {
				timer -= ig.system.tick;
				if (timer > 0) return;
				timer = 3; // every 3s
				if (!this.connection || !this.connection.isOpen()) return;
				try { this.connection.onlineCount(); } catch (e) { /* ignore */ }
				const p = this.buildOwnProfile();
				if (p) {
					try { this.connection.updatePlayerProfile(p); } catch (e) { /* ignore */ }
					// Log our own broadcast occasionally so the user can confirm the
					// profile pipeline is alive (first time, then throttled).
					if (!(this as any)._profileLogged) {
						(this as any)._profileLogged = true;
						console.log('[multiplayer] broadcasting own profile: lvl=' + p.level +
							' hp=' + p.hp + ' atk=' + p.attack + ' def=' + p.defense + ' foc=' + p.focus);
					}
				}
			});
		}
	}

	/** Cache of remote players' real profiles (username -> profile). */
	public playerProfiles: { [username: string]: import('./connection').IPlayerProfile } = {};
	/** Latest known server online count (for the top-bar chip). */
	public onlineCount = 0;
	/** friend username -> online flag (from presence pushes). */
	public friendPresence: { [username: string]: boolean } = {};
	/** Current party roster (usernames, including self) + leader. */
	public partyMembers: string[] = [];
	public partyLeader?: string;
	/** Round 16 (issue 4): server-provided per-extra-party-member enemy max-HP
	 * fraction (handshakeResponse.hpScale, default 0.5 = +50% HP per extra party
	 * member). Consumed by netSync (setHpScale) — the HOST scales monster HP at
	 * spawn by `1 + hpScale * (partySize - 1)`; members never scale (their puppets
	 * are locked mirrors of host enemies). */
	public mpHpScale = 0.5;
	/** Round 17: RTT in ms each remote player in our instance reports to the
	 * server (relayed as `playerPing`, ~1/s cadence). Shown on their name tag when
	 * 显示ping值 is on. Stale entries are harmless (tags only render for present
	 * players); the whole map is cleared in clearMultiplayerState on logout. */
	public remotePings: { [name: string]: number } = {};
	/** Round 11: native party BOTS in the roster (host publishes; members apply
	 * as local follower copies so they're visible to everyone). */
	public partyBots: string[] = [];
	private _lastSentBots = '';
	private _lastBotPublish = 0;
	// Round 13: party-bot sync state. The party LEADER streams live bot state
	// (~15 Hz) while members freeze their local copies as host-driven puppets.
	private _botStateTimer: any = null;
	/** Bot names this client has adopted from the host's partyBots broadcasts. Used
	 * to scope cleanup to NETWORK bots only — a solo player's own native bots
	 * (Emilie/...) in a shared town are never stripped by another host's broadcast. */
	private _mpAdoptedBots: { [name: string]: boolean } = {};
	/** Names present in the last received botState block (cull vanished bots). */
	private _mpLastBotNames: string[] = [];
	private _mpBotSeenOnce = false;
	/** Last map we saw the leader stream for (cull-once per map mismatch). */
	private _mpLeaderMap = '';
	/** Round 16: Date.now() of the last botState block received. A stall >3s with
	 *  no map mismatch means the leader teleported to a NEW instance (we're on the
	 *  same map, so the mismatch cull never fires) or disconnected — cull the
	 *  frozen puppets. Cleared in the hygiene resets. */
	private _mpLastBotStateAt = 0;

	/** The real profile for a remote player, if we've received one. */
	public getPlayerProfile(username: string): import('./connection').IPlayerProfile | undefined {
		return this.playerProfiles[username];
	}

	/**
	 * Re-send our current map to the server so it recomputes/re-joins our instance.
	 * Idempotent server-side (leave + rejoin the same instance). Used when the party
	 * changes so the leader and a newly-joined member both refresh into the shared
	 * instance and spawn each other's mirror entity.
	 */
	public reassertCurrentInstance(): void {
		try {
			if (!this.connection || !this.connection.isOpen()) return;
			const map = ig.game && ig.game.mapName;
			if (!map || ig.game.isTeleporting()) return; // mid-teleport: onTeleport handles it
			const p = this.connection.changeMap(map, null, this.getAreaPath(), this.getAreaType());
			// changeMap rejoins the CURRENT instance; its response carries the authoritative
			// isHost. Apply ONLY demotion (host->member): a stale host=true client would stream
			// a second conflicting enemy block, and clearing the flag is safe (its enemies just
			// become puppets of the real host). Do NOT apply promotion (member->host) here:
			// that requires respawning the locked puppets (promoteToHost), which only the
			// setHost path does — a bare flag flip would leave frozen AI-locked enemies as the
			// authority. If the server intended a promotion it sends setHost; a partyReSync
			// reassert never legitimately promotes (the instance already had a host).
			if (p && typeof (p as any).then === 'function') {
				(p as Promise<IChangeMapResult>).then((res) => {
					if (res && res.isHost === false && this.host === true) {
						this.host = false;
						console.log('[multiplayer] reassert: demoted to member (no longer streaming enemy block)');
					}
				}).catch(() => { /* ignore */ });
			}
		} catch (e) { /* ignore */ }
	}

	/** Retry-wrapped reassertCurrentInstance: a partyReSync that arrives mid-teleport
	 * cannot reassert (the in-flight teleport owns the changeMap), so retry once per
	 * second for up to 10s until the game is idle. Round 10: the old silent drop left
	 * a freshly-formed party split across solo instances until someone re-entered the map. */
	private reassertWhenReady(attempt: number): void {
		try {
			if (!this.connection || !this.connection.isOpen()) return;
			if (ig.game && ig.game.isTeleporting()) {
				if (attempt < 10) setTimeout(() => this.reassertWhenReady(attempt + 1), 1000);
				return;
			}
			this.reassertCurrentInstance();
		} catch (e) { /* ignore */ }
	}

	/** Updates an injected mp contact's online flag (drives the friend list dot). */
	private updateMpContactOnline(username: string, online: boolean): void {
		const party: any = (sc as any).party;
		const c = party && party.contacts && party.contacts[username];
		if (c && c._mp) c.online = online;
	}

	/** Reads the local player's real level/stats/equip for broadcast. Also carries
	 * live currentHp/currentSp so the remote party HUD (HP/SP bars) stays fresh even
	 * outside of combat (SP has no dedicated event, so the 3s profile is its sync). */
	private buildOwnProfile(): import('./connection').IPlayerProfile | null {
		try {
			const p: any = (sc as any).model && (sc as any).model.player;
			if (!p || !p.params) return null;
			return {
				level: p.level,
				exp: p.exp,
				hp: p.params.getStat('hp'),
				attack: p.params.getStat('attack'),
				defense: p.params.getStat('defense'),
				focus: p.params.getStat('focus'),
				currentHp: p.params.currentHp,
				currentSp: p.params.currentSp,
				maxSp: p.params.maxSp,
				equip: p.equip ? {
					head: p.equip.head, leftArm: p.equip.leftArm, rightArm: p.equip.rightArm,
					torso: p.equip.torso, feet: p.equip.feet,
				} : undefined,
			};
		} catch (e) {
			return null;
		}
	}

	/**
	 * After accepting a party invite: teleport to the party leader so the group
	 * actually meets up. If the leader is in a shared town we just teleport to
	 * their map; otherwise we go to the leader's party-instance map. Falls back to
	 * the default town if we have no usable target yet.
	 */
	private regroupToPartyLeader(leader: string | undefined, map: string | undefined, pos: Vec3 | undefined): void {
		// Round 19: a regroup teleport that arrives while the LOCAL player is in a
		// cutscene must not fire — teleporting mid-story would fight the story UI
		// and can soft-lock the cutscene. Stash it; the netSync onCutsceneEnd
		// callback fires it once the cutscene ends (latest stash wins).
		try {
			const mdl: any = (sc as any).model;
			if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) {
				console.log('[multiplayer] in cutscene — stashing regroup to ' + (map || 'default'));
				this._pendingRegroup = { kind: 'move', leader, map, pos };
				return;
			}
		} catch (_) { /* fall through to teleporting */ }
		const target = map && typeof map === 'string' ? map : 'rhombus-sqr.central';
		console.log('[multiplayer] regrouping to party leader ' + leader + ' @ ' + target);

		// UNLOCK POLICY (round 6, user directive): a party regroup is ALWAYS allowed.
		// The old hard "进度不足" block keyed off `ig.vars.storage.maps`, which the
		// engine only populates on VISIT (onLevelChange) — a save that unlocked the
		// block story-wise but never stood on one of its maps (e.g. skipped prologue)
		// was wrongly rejected, and the engine's own "area unlocked" accessor is
		// visit-based too, so no stricter signal exists. Members are safe in
		// never-visited areas anyway: onMapEnter strips local Enemy/EnemySpawner and
		// the host block drives puppets (round-3 design). Residual risk: ending up
		// HOST of the target instance (leader left meanwhile) makes quest-gated
		// spawns LOCAL, which can wedge the loader — so for a not-yet-visited area
		// we force the enemy strip for THIS load even when host.
		const targetArea = areaPathOfMap(target);
		if (SHARED_TOWNS.indexOf(targetArea) === -1 && !hasUnlockedArea(target)) {
			this.mpForceStripNextLoad = true;
			console.log('[multiplayer] regroup into not-yet-visited area ' + targetArea
				+ ' — allowed; forcing enemy strip for this load (host-wedge guard)');
		}

		// Close the pause/main menu BEFORE teleporting: this button lives in the
		// Social menu, and ig.Game.update only consumes teleporting.levelData while
		// !paused — with the menu still open the teleport froze at a black fade
		// until the 15s watchdog bounced the player (round-6 black screen).
		try {
			const mdl: any = (sc as any).model;
			if (mdl && ((mdl.isMenu && mdl.isMenu()) || (mdl.isPaused && mdl.isPaused()))) {
				mdl.enterRunning();
			}
		} catch (_) { /* ignore */ }

		// If we're already mid-teleport (e.g. a map load is in flight), defer the
		// regroup until it finishes — calling teleport() during a load clobbers the
		// teleport state and black-screens. Wait for loadingComplete, then go.
		if (ig.game.isTeleporting()) {
			console.log('[multiplayer] already teleporting; deferring regroup until load completes');
			this.onceGameReady(() => this.regroupToPartyLeader(leader, map, pos));
			return;
		}

		// A shared town is one big town:<map> instance — both of us are in it as long
		// as we're on the same map. Teleport to the town's default LANDMARK (a proper
		// marker teleport, the most robust kind) so we reliably land in the shared
		// instance and the leader's mirror spawns. A position-based teleport is only
		// needed for party/solo instances (paths/dungeons).
		const areaPath = areaPathOfMap(target);
		if (SHARED_TOWNS.indexOf(areaPath) !== -1) {
			try {
				(ig.game as any).teleport(target); // default hint -> normal fade, robust
				return;
			} catch (e) {
				console.warn('[multiplayer] town regroup failed, going to default town', e);
				try { (ig.game as any).teleport('rhombus-sqr.central'); } catch (_) { /* ignore */ }
				return;
			}
		}

		// Party instance (path/dungeon): teleport to the leader's exact position so we
		// land in the same party:<partyId>:<map> instance and next to them. All three
		// coordinates must be finite numbers (the server sends pos:null when its cache
		// is malformed, but never trust the wire blindly).
		if (pos && isFinite(pos.x) && isFinite(pos.y) && isFinite(pos.z)) {
			try {
				// TeleportPosition's ctor only takes a marker; the position is set via
				// setFromData(marker, pos, face, level, baseZPos, size). face/size MUST
				// be supplied: ig.Game.loadLevel's no-marker branch reads a.face.x and
				// a.pos.x + a.size.x/2 directly, so a null face throws every frame and
				// wedges the game in a black reload loop. NOTE: no 'LOAD' hint — that
				// triggers a full game-reset path that black-screens; a normal
				// (undefined-hint) teleport is a clean fade + loadLevel.
				const p: any = ig.game.playerEntity;
				const tp = new (ig as any).TeleportPosition(null);
				tp.setFromData(null, { x: pos.x, y: pos.y, z: pos.z || 0 },
					p && p.face ? p.face : { x: 0, y: 1 },
					p && p.coll ? p.coll.level : 0,
					p && p.coll ? p.coll.baseZPos : 0,
					p && p.coll && p.coll.size ? p.coll.size : { x: 16, y: 16 });
				(ig.game as any).teleport(target, tp);
				return;
			} catch (e) {
				console.warn('[multiplayer] position regroup failed, trying map default', e);
			}
		}
		// Fallback: the map's default spawn (still the same party instance).
		try {
			(ig.game as any).teleport(target);
		} catch (e) {
			console.warn('[multiplayer] regroup teleport failed, going to default town', e);
			try { (ig.game as any).teleport('rhombus-sqr.central'); } catch (_) { /* ignore */ }
		}
	}

	/**
	 * Manual "传送到队友身边" (Social party-box button). Joining a party no longer
	 * auto-teleports; the player presses this to travel to the leader. We ask the
	 * server for the leader's current location (partyRegroup) and the existing
	 * onPartyMove handler performs the actual (unlock-guarded) teleport.
	 */
	public requestRegroup(target?: string): void {
		if (!this.connection || !this.connection.isOpen()) return;
		if (!this.partyMembers || this.partyMembers.length <= 1) return; // not in a party
		const t = target && this.partyMembers.indexOf(target) !== -1 ? target : undefined;
		// Round 19: never send a regroup while the LOCAL player is in a cutscene —
		// the resulting teleport would fight the story UI. Stash it; the netSync
		// onCutsceneEnd callback fires it once the cutscene ends (latest wins).
		try {
			const mdl: any = (sc as any).model;
			if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) {
				console.log('[multiplayer] in cutscene — stashing manual regroup');
				this._pendingRegroup = { kind: 'request', target: t };
				return;
			}
		} catch (_) { /* fall through to sending */ }
		console.log('[multiplayer] manual regroup requested' + (t ? ' (to ' + t + ')' : ' (to leader)'));
		this.connection.partyRegroup(t);
	}

	/** Round 19: fire a regroup/teleport request stashed during a cutscene (called
	 * from the netSync onCutsceneEnd callback). Latest stash wins; none -> no-op. */
	private firePendingRegroup(): void {
		const p = this._pendingRegroup;
		this._pendingRegroup = null;
		if (!p) return;
		if (p.kind === 'request') {
			console.log('[multiplayer] cutscene ended — firing stashed manual regroup');
			try { this.connection.partyRegroup(p.target); } catch (_) { /* ignore */ }
		} else {
			console.log('[multiplayer] cutscene ended — firing stashed regroup teleport');
			this.regroupToPartyLeader(p.leader, p.map, p.pos);
		}
	}

	/** Round 19: show a transient in-game toast (delegates to the SocialOverlay,
	 * used by the cutscene auto-decline / teleport-refusal feedback). */
	public showToast(message: string): void {
		try { if (this.socialOverlay) this.socialOverlay.showToast(message); } catch (_) { /* ignore */ }
	}

	/**
	 * Feeds the native Social party box from the server roster. We inject a
	 * PartyMemberModel + contact per remote member (online, friend-status so the
	 * box shows them) but do NOT spawn follower bots. The box just renders the
	 * roster; the actual in-world player is the network mirror.
	 */
	private applyPartyRoster(members: string[]): void {
		const party: any = (sc as any).party;
		if (!party || !this.name) return;
		const remote = members.filter((m) => m && m !== this.name);

		for (const name of remote) {
			this.ensureMpModel(name);
			const c = party.contacts[name] || (party.contacts[name] = {});
			c._mp = true;
			c._mpInParty = true;
			// Do NOT force FRIEND status — party members aren't necessarily friends,
			// and the party box renders from the roster (m.partyMembers), not the
			// contact status. Keep whatever friend-status they already have (or
			// default to CONTACT) so the friends tab isn't polluted.
			if (typeof c.status !== 'number') c.status = 1; // CONTACT
			c.online = true;
			c.locked = false;
		}
		// Clear the in-party flag on members who left (only our injected ones).
		for (const name in party.contacts) {
			const c = party.contacts[name];
			if (c && c._mp && c._mpInParty && remote.indexOf(name) === -1) {
				c._mpInParty = false;
			}
		}

		// Keep the native in-game party HUD (top-left HP bars) in sync with the
		// roster. currentParty normally holds single-player follower bots, but our
		// party members are REAL network players — we add them for the HUD only and
		// suppress follower-entity spawning via the _spawnPartyMemberEntity inject.
		let changed = false;
		if (party.currentParty) {
			// Remove _mp members no longer in the roster — but NEVER synced party
			// bots (round 12: offline friends invited as follower bots also carry
			// _mpName and live in currentParty without being in the roster).
			for (let i = party.currentParty.length; i--;) {
				const n = party.currentParty[i];
				if (party.models[n] && party.models[n]._mpName && remote.indexOf(n) === -1
					&& this.partyBots.indexOf(n) === -1) {
					party.currentParty.splice(i, 1);
					changed = true;
				}
			}
			// Add current _mp members. If the name was a synced BOT until now (a bot
			// player who came online and joined for real), promote it: drop the local
			// follower entity first so we don't render bot + mirror of the same name.
			for (const name of remote) {
				if (this.partyBots.indexOf(name) !== -1) {
					this.partyBots = this.partyBots.filter((b) => b !== name);
					try {
						if (party.isPartyMember(name)) party.removePartyMember(name, null, true);
					} catch (_) { /* ignore */ }
					changed = true;
				}
				if (party.currentParty.indexOf(name) === -1 && party.models[name]) {
					party.currentParty.push(name);
					changed = true;
				}
			}
		}
		if (changed) {
			try { sc.Model.notifyObserver(party, (sc as any).PARTY_MSG.PARTY_CHANGED); } catch (e) { /* ignore */ }
		}

		// The native social party box (if open) rebuilds from the new roster.
		this.refreshOpenSocialMenu();
	}

	/** Round 11 HOST side: detect native party BOTS (models without _mpName) in
	 * the roster and publish changes to the instance. Runs once per second. Also
	 * force-republishes every 15s so ordering edge cases (a member's partyUpdate
	 * arriving AFTER the bots replay was rejected) self-heal.
	 * ROUND 12: also publishes "mod bots" — offline friends the host invited as
	 * follower bots (_mpName models that are NOT in the network roster). Real
	 * network members stay excluded (they're mirrors, not bots). Combined cap:
	 * players + bots <= 8. */
	private checkBotRoster(): void {
		try {
			if (!this.host || !this.connection || !this.connection.isOpen()) return;
			const party: any = (sc as any).party;
			if (!party || !party.currentParty) return;
			if (!ig.game || !ig.game.playerEntity || ig.game.isTeleporting()) return;
			const roster = this.partyMembers || [];
			const maxBots = Math.max(0, 8 - roster.length);
			const bots: string[] = [];
			for (const n of party.currentParty) {
				const mdl = party.models[n];
				if (!mdl) continue;
				// A real network party member is a mirror on every client — never a bot.
				if (mdl._mpName && roster.indexOf(n) !== -1) continue;
				if (bots.length < maxBots) bots.push(n);
			}
			const key = bots.join('|');
			const now = Date.now();
			if (key === this._lastSentBots && now - this._lastBotPublish < 15000) return;
			this._lastSentBots = key;
			this._lastBotPublish = now;
			this.partyBots = bots;
			this.connection.partyBots(bots);
			console.log('[multiplayer] publishing party bots: ' + JSON.stringify(bots));
		} catch (_) { /* ignore */ }
	}

	/** Round 11 MEMBER side: mirror the host's party bots as local follower copies.
	 * addPartyMember spawns the entity natively (the _spawnPartyMemberEntity inject
	 * only suppresses REAL network party members). ROUND 13: only the party LEADER
	 * runs these bots with full AI; every other member's copies are frozen as puppets
	 * (_mpPuppet) — AI suppressed, position/anim/hp lerped from the leader's botState
	 * stream. Gated to partied players — spectators of a shared town must not adopt
	 * the host's bots. ROUND 12: the list may contain "mod bots" (usernames of
	 * offline friends) — build the injected model on the fly if this client never met
	 * them, so their follower copy still spawns. */
	private applyPartyBots(bots: string[]): void {
		try {
			const party: any = (sc as any).party;
			if (!party || !party.currentParty) return;
			this.partyBots = (bots || []).slice();
			const roster = this.partyMembers || [];
			// Remove bots the host dropped. Never touch real network members — only
			// currentParty entries that are NOT in the roster AND not announced bots
			// (that's exactly the synced-bot set, official or mod). ROUND 13: this
			// cleanup runs BEFORE the host/party-size gates below, so a disband
			// (roster is emptied first -> applyPartyBots([]) previously hit the early
			// return and left member bots following the ex-member into solo) or a host
			// demotion still removes the bots. Scoped to NETWORK-adopted names so a
			// solo player's own native bots (Emilie/...) in a shared town are never
			// stripped by another host's partyBots broadcast.
			for (let i = party.currentParty.length; i--;) {
				const n = party.currentParty[i];
				if (!n || roster.indexOf(n) !== -1) continue;
				if (this.partyBots.indexOf(n) !== -1) continue;
				// Round 15: a kicked bot can already have its _mpAdoptedBots entry
				// deleted (an earlier cull cleared it), so don't gate cleanup on that
				// flag alone — clean any NETWORK bot that's absent from the new roster.
				// The entity's puppet/synced markers survive a deleted tracking entry,
				// so those still get the removal path below; native single-player bots
				// (Emilie/...) carry neither marker and stay untouched (round-13
				// shared-town safety: never strip a spectator's own bots).
				const ent = this.partyBotEntity(party, n);
				if (!this._mpAdoptedBots[n]
					&& !(ent && (ent._mpPuppet || (ent.model && ent.model._mpBotSynced)))) continue;
				try { party.removePartyMember(n, null, true); } catch (_) { /* ignore */ }
				try { dropNameTag(n); } catch (_) { /* ignore */ }
				delete this._mpAdoptedBots[n];
			}
			// Adoption/spawning gates: the host runs its own bots natively, and
			// spectators (solo / party of one) must not adopt the host's bots.
			if (this.host) return;
			if (!this.partyMembers || this.partyMembers.length <= 1) return;
			// Add newly announced bots.
			for (const name of this.partyBots) {
				if (!name || party.currentParty.indexOf(name) !== -1) continue;
				if (roster.indexOf(name) !== -1) continue; // real member -> mirror, not bot
				// Round 14: adoption is gated on a CONFIRMED leader-map match (strict
				// equality; the botState stream sets _mpLeaderMap within ~66ms). Without
				// the gate a member on a DIFFERENT map adopts + re-adopts the leader's
				// bots (the 1s partyBots re-broadcast respawns them right after each
				// cull) -> bots appear next to a member who isn't on the leader's map.
				const sameMap = this._mpLeaderMap !== '' && this._mpLeaderMap === this.currentMapName;
				if (!sameMap) continue;
				if (!party.models[name]) {
					// Mod bot for a player this client has no model of — build one.
					try { this.ensureMpModel(name); } catch (_) { /* ignore */ }
				}
				if (!party.models[name]) continue; // still unknown -> skip
				try { party.addPartyMember(name, null, false, true); } catch (_) { /* ignore */ }
			}
			// ROUND 13: only the party LEADER runs its bots with full AI. Every other
			// party member freezes its local bot copies as puppets: position/anim/hp
			// become leader-driven (botState stream), the local AI is suppressed by the
			// PartyMemberEntity.update inject, and the model can't die/level locally.
			const isLeader = this.isPartyLeader;
			for (const name of this.partyBots) {
				if (!name) continue;
				const e = this.partyBotEntity(party, name);
				// Round 14: skip killed entities too — a dead bot must not be re-puppeted
				// (its corpse would sit frozen next to the player until the next cull).
				if (!e || e._killed) continue;
				if (!isLeader) {
					// Round 15: puppet-marking extracted to markPuppetBot so the ungated
					// botState adoption path (adoptBot) marks puppets identically.
					this.markPuppetBot(name);
				} else {
					// Leadership can transfer mid-session — a promoted leader's own bots
					// must resume their full AI (cleared; the inject honours _mpPuppet).
					this._mpAdoptedBots[name] = true;
					e._mpPuppet = false;
				}
			}
			console.log('[multiplayer] party bots applied: ' + JSON.stringify(this.partyBots));
		} catch (_) { /* ignore */ }
	}

	// ---- round 13: leader-driven party bot sync (botState) ----

	/** Round 14: current map name, guarded ('' outside the game). Bot adoption is
	 * gated on this matching the CONFIRMED leader map (_mpLeaderMap), so a member
	 * can never adopt the leader's bots while on a different map. */
	private get currentMapName(): string {
		try { return (ig.game && ig.game.mapName) || ''; } catch (_) { return ''; }
	}

	/** True when this client is the party leader (owns the follower bots). */
	private get isPartyLeader(): boolean {
		return !!(this.name && this.partyLeader === this.name);
	}

	/** Looks up a party bot's live entity (sc.party.partyEntities[name]). */
	private partyBotEntity(party: any, name: string): any {
		try {
			if (party && typeof party.getPartyMemberEntity === 'function') return party.getPartyMemberEntity(name);
		} catch (_) { /* ignore */ }
		return (party && party.partyEntities && party.partyEntities[name]) || null;
	}

	/** Round 15: marks ONE party bot as a member-side puppet (AI suppressed, pos/
	 * anim/hp lerped from the leader's botState stream). Extracted from applyPartyBots
	 * so the ungated botState adoption path (adoptBot) puppets identically. */
	private markPuppetBot(name: string): void {
		const party: any = (sc as any).party;
		const e = this.partyBotEntity(party, name);
		if (!e || e._killed) return;
		this._mpAdoptedBots[name] = true;
		e._mpPuppet = true;
		const pos = e.coll ? e.coll.pos : null;
		const px = pos ? pos.x : 0;
		const py = pos ? pos.y : 0;
		const pz = pos ? pos.z : 0;
		try { this.lockEntity(e, { x: px, y: py, z: pz }); } catch (_) { /* ignore */ }
		if (e.model) {
			e.model._mpBotSynced = true;
			// Remember the bot's pre-puppet noDie so a leadership transfer can
			// restore it (a promoted leader's bot must be killable again).
			if (!('_mpBotNoDieWas' in e.model)) e.model._mpBotNoDieWas = !!e.model.noDie;
			e.model.noDie = true;
		}
		if (e.params && !e.params._mpBotIsDefeatedPatched) {
			e.params._mpBotIsDefeatedPatched = true;
			if (typeof e.params.isDefeated === 'function') e.params._mpBotOrigIsDefeated = e.params.isDefeated;
			e.params.isDefeated = function () { return false; };
		}
		if (typeof e._mpBotToX !== 'number') {
			e._mpBotToX = px; e._mpBotToY = py; e._mpBotToZ = pz;
		}
	}

	/** Round 15: adopt a party bot purely from the ungated botState stream. The
	 * partyBots broadcast is double host-gated (client checkBotRoster + server
	 * protocol.js) when the party LEADER isn't the instance host — e.g. a member
	 * teleports to a new map first, becomes instance host, then the leader follows
	 * — so applyPartyBots never fires and the bot never gets a puppet. The botState
	 * stream is NOT host-gated, so adoption is driven from it here. Never throws. */
	private adoptBot(name: string): void {
		try {
			if (!name || this.isPartyLeader) return;
			if (!this.partyMembers || this.partyMembers.length <= 1) return;
			if (this.partyMembers.indexOf(name) !== -1) return; // real member -> mirror, not bot
			const g: any = (ig as any).game;
			if (g && typeof g.isTeleporting === 'function' && g.isTeleporting()) return; // don't adopt mid-load
			const party: any = (sc as any).party;
			if (!party || !party.currentParty) return;
			if (party.currentParty.indexOf(name) !== -1) return; // idempotent
			if (!party.models[name]) { try { this.ensureMpModel(name); } catch (_) { /* ignore */ } }
			if (!party.models[name]) return; // official bot whose model is missing -> skip
			try { party.addPartyMember(name, null, false, true); } catch (_) { /* ignore */ }
			if (this.partyBots.indexOf(name) === -1) this.partyBots.push(name); // keep roster array + party box + applyPartyRoster strip loop consistent
			this.markPuppetBot(name);
		} catch (_) { /* never break the state loop */ }
	}

	/** Starts/stops the leader-side botState stream to match leadership + roster.
	 * Runs from onPartyUpdate: starts only when we lead a multi-member party, stops
	 * on leave/disband/leader change/party empty. */
	private syncBotStream(): void {
		const shouldRun = this.isPartyLeader && !!(this.partyMembers && this.partyMembers.length > 1);
		if (shouldRun) {
			// A promoted leader's own bots were member-side puppets until now — give
			// back their full AI (leadership can transfer).
			this.ensureLeaderBotsUnPuppeted();
			if (!this._botStateTimer) {
				this._botStateTimer = setInterval(() => { this.streamBotState(); }, 66); // ~15 Hz
			}
		} else {
			this.stopBotStream();
		}
	}

	private stopBotStream(): void {
		if (this._botStateTimer) {
			try { clearInterval(this._botStateTimer); } catch (_) { /* ignore */ }
			this._botStateTimer = null;
		}
	}

	/** A promoted leader's local bots were member-side puppets — unfreeze them so
	 * they run their own full AI again. */
	private ensureLeaderBotsUnPuppeted(): void {
		try {
			const party: any = (sc as any).party;
			if (!party || !party.partyEntities) return;
			for (const name in party.partyEntities) {
				const e: any = party.partyEntities[name];
				if (e && e._mpPuppet) {
					e._mpPuppet = false;
					if (e.model) {
						e.model._mpBotSynced = false;
						// Restore the pre-puppet noDie so the promoted leader's bot can die
						// normally (the puppet freeze set it to true).
						if ('_mpBotNoDieWas' in e.model) e.model.noDie = !!e.model._mpBotNoDieWas;
					}
					if (e.params && e.params._mpBotIsDefeatedPatched) {
						e.params._mpBotIsDefeatedPatched = false;
						if (typeof e.params._mpBotOrigIsDefeated === 'function') e.params.isDefeated = e.params._mpBotOrigIsDefeated;
						delete e.params._mpBotOrigIsDefeated;
					}
				}
			}
		} catch (_) { /* ignore */ }
	}

	/** LEADER side (~15 Hz): stream every live bot entity's state to the instance so
	 * members can render the same bots as host-driven puppets. Emits an EMPTY bots
	 * array when there are none — members use that as the cull signal. */
	private streamBotState(): void {
		try {
			if (!this.connection || !this.connection.isOpen()) return;
			if (!this.isPartyLeader) return;
			if (!ig.game || !ig.game.playerEntity || ig.game.isTeleporting()) return;
			const party: any = (sc as any).party;
			if (!party || !party.currentParty) return;
			const roster = this.partyMembers || [];
			const bots: any[] = [];
			for (const n of party.currentParty) {
				if (!n) continue;
				const mdl = party.models && party.models[n];
				if (mdl && mdl._mpName && roster.indexOf(n) !== -1) continue; // real member -> mirror
				const e = this.partyBotEntity(party, n);
				if (!e || e._killed || !e.coll) continue;
				const face = e.face || { x: 0, y: 1 };
				bots.push({
					n,
					x: Math.round(e.coll.pos.x),
					y: Math.round(e.coll.pos.y),
					z: Math.round(e.coll.pos.z),
					fx: face.x,
					fy: face.y,
					a: typeof e.currentAnim === 'string' ? e.currentAnim : '',
					hp: e.params ? e.params.currentHp : 0,
					mh: e.params && e.params.getStat ? e.params.getStat('hp') : 0,
					lv: mdl ? mdl.level : 0,
					ex: mdl ? mdl.exp : 0,
				});
			}
			this.connection.botState({ map: ig.game.mapName || '', bots });
		} catch (_) { /* ignore */ }
	}

	/** MEMBER side: apply the leader's botState block to our local puppet copies. */
	private applyBotState(data: any): void {
		try {
			if (!data || !Array.isArray(data.bots)) return;
			// Round 16: every received block (match or mismatch, and even our own
			// echoed block) refreshes the stall clock — a quiet stream means the
			// leader left our instance, not that the puppets are healthy.
			this._mpLastBotStateAt = Date.now();
			if (data.from === this.name) return;
			if (this.isPartyLeader) return; // we run our own bots with full AI
			const party: any = (sc as any).party;
			if (!party || !party.currentParty) return;
			const map = (ig.game && ig.game.mapName) || '';
			// Leader on a different map: our puppets have nothing to follow. Cull them
			// all (once per leader-map), then wait — the recurring partyBots broadcast
			// re-adds membership and respawns the puppet when the leader returns.
			if (data.map !== map) {
				// Round 14: cull on EVERY mismatched block — the old once-per-leader-map
				// latch let the 1s partyBots re-broadcast re-adopt right after each cull,
				// leaving bots on a member who re-entered on another map. cullLocalBotEntities
				// is cheap; once culled the loop finds nothing.
				this._mpLeaderMap = data.map;
				this.cullLocalBotEntities(party);
				this._mpLastBotNames = [];
				this._mpBotSeenOnce = false;
				return;
			}
			this._mpLeaderMap = data.map;
			const newNames: string[] = [];
			for (const b of data.bots) {
				if (!b || typeof b.n !== 'string' || !b.n) continue;
				newNames.push(b.n);
				const e = this.partyBotEntity(party, b.n);
				if (!e || e._killed || !e.coll) {
					// Round 15: bot we have no puppet for yet. The partyBots broadcast
					// is double host-gated (client checkBotRoster + server protocol.js)
					// when the party LEADER isn't the instance host, so applyPartyBots
					// may never fire here — adopt from the ungated botState stream
					// instead (state fills in on the next block). newNames already holds
					// b.n so the vanish-cull below won't immediately remove it.
					this.adoptBot(b.n);
					continue;
				}
				if (typeof b.x === 'number' && typeof b.y === 'number' && typeof b.z === 'number') {
					e._mpBotToX = b.x; e._mpBotToY = b.y; e._mpBotToZ = b.z;
				}
				// Round 14: only write anim/face for entities WE puppeted (_mpPuppet). A
				// non-puppet entity (e.g. one the engine freshly respawned) is not locked,
				// and setEntityAnimationProtected would write a bare object into its
				// currentAnim. Position/HP/level writes below stay for every entity.
				if (e._mpPuppet && typeof b.fx === 'number' && typeof b.fy === 'number' && e.face) {
					try {
						if (typeof b.a === 'string' && b.a) {
							this.setEntityAnimationProtected(e, { x: b.fx, y: b.fy }, b.a);
						} else {
							(e.face as any).xProtected = b.fx;
							(e.face as any).yProtected = b.fy;
						}
					} catch (_) { /* ignore */ }
				}
				if (e.params) {
					if (typeof b.hp === 'number') e.params.currentHp = b.hp;
					if (e.params.defeated) e.params.defeated = false;
				}
				// Display stats on the party model (top-left HUD / roster box).
				const mdl = e.model || (party.models && party.models[b.n]);
				if (mdl) {
					let lvCh = false, exCh = false;
					if (typeof b.lv === 'number' && mdl.level !== b.lv) { mdl.level = b.lv; lvCh = true; }
					if (typeof b.ex === 'number' && mdl.exp !== b.ex) { mdl.exp = b.ex; exCh = true; }
					if (mdl.params) {
						if (typeof b.hp === 'number') mdl.params.currentHp = b.hp;
						if (typeof b.mh === 'number' && b.mh > 0 && mdl.params.baseParams) mdl.params.baseParams.hp = b.mh;
					}
					// Round 14: the member HUD's EXP bar only re-renders on an observer
					// notification (modelChanged: b==EXP_CHANGE -> setExpRatio(model.exp/...));
					// writing model.exp directly never reaches it. Fire after the writes,
					// guarded (the enum may be absent on unusual builds).
					if (lvCh) { try { (sc as any).Model.notifyObserver(mdl, (sc as any).PARTY_MEMBER_MSG.LEVEL_CHANGE); } catch (_) { /* ignore */ } }
					if (exCh) { try { (sc as any).Model.notifyObserver(mdl, (sc as any).PARTY_MEMBER_MSG.EXP_CHANGE); } catch (_) { /* ignore */ } }
				}
			}
			// Cull bots that vanished from the stream (died/removed on the leader).
			if (this._mpBotSeenOnce) {
				for (const old of this._mpLastBotNames) {
					if (newNames.indexOf(old) !== -1) continue;
					this.cullLocalBot(party, old);
				}
			}
			this._mpLastBotNames = newNames;
			this._mpBotSeenOnce = true;
		} catch (_) { /* ignore */ }
	}

	/** Culls ONE synced bot entity (kills it + splices currentParty). The party-box
	 * roster reads m.partyBots + sc.party.models, so the name stays listed. */
	private cullLocalBot(party: any, name: string): void {
		try {
			if (!name) return;
			// Round 15: drop the tag + tracking BEFORE the isPartyMember early return
			// below — a bot already removed from the party model never reaches it, so
			// its tag would otherwise linger at the last projected position.
			try { dropNameTag(name); } catch (_) { /* ignore */ }
			this.partyBots = this.partyBots.filter((x: string) => x !== name);
			delete this._mpAdoptedBots[name];
			if (typeof party.isPartyMember === 'function' && !party.isPartyMember(name)) return;
			if (typeof party.removePartyMember === 'function') party.removePartyMember(name, null, true);
			// Round 14: hard-remove the bot's name tag so it can't linger at the last
			// projected position (the per-frame tag loop would otherwise keep it alive).
			try { dropNameTag(name); } catch (_) { /* ignore */ }
		} catch (_) { /* ignore */ }
	}

	/** Culls every local synced bot entity (leader left our map / disbanded bots).
	 *  Public so the connection listeners (onPlayerChangeMap) can cull instantly
	 *  when the party leader leaves our instance (round 16). */
	public cullLocalBotEntities(party: any): void {
		try {
			const roster = this.partyMembers || [];
			for (let i = party.currentParty.length; i--;) {
				const n = party.currentParty[i];
				if (!n || roster.indexOf(n) !== -1) continue;
				const e = this.partyBotEntity(party, n);
				if ((e && e._mpPuppet) || this._mpAdoptedBots[n]) {
					try { party.removePartyMember(n, null, true); } catch (_) { /* ignore */ }
					try { dropNameTag(n); } catch (_) { /* ignore */ }
					// Round 15: keep this.partyBots consistent with the cull (see cullLocalBot).
					this.partyBots = this.partyBots.filter((x: string) => x !== n);
				}
				delete this._mpAdoptedBots[n];
			}
		} catch (_) { /* ignore */ }
	}

	/** Party disbanded/kicked/left: remove every synced follower bot for good and
	 * stop the leader-side stream. Called from onPartyUpdate BEFORE any applyPartyBots
	 * gates can skip the cleanup (partyMembers is emptied first). */
	private clearSyncedPartyBots(): void {
		try {
			const party: any = (sc as any).party;
			if (party && party.currentParty) {
				for (const name of this.partyBots) {
					if (!name) continue;
					this.cullLocalBot(party, name);
					// Round 14: hard-remove the tag here too (belt-and-braces on top of
					// the cullLocalBot call) so a disband/kick leaves no lingering tag.
					try { dropNameTag(name); } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
		this.partyBots = [];
		this._mpAdoptedBots = {};
		this._mpLastBotNames = [];
		this._mpBotSeenOnce = false;
		this._mpLeaderMap = '';
		this._mpLastBotStateAt = 0;
		// Round 16: the disband cleanup path — belt-and-braces wipe of every cached
		// tag so no ex-member bot tag survives (cullLocalBot's per-name drops only
		// cover names still tracked at that moment).
		try { wipeAllNameTags(); } catch (_) { /* ignore */ }
		this.stopBotStream();
	}

	/** Round 16: party lost (kick/leave/disband) on a wild map — our load stripped
	 *  the enemies and the server never tells us we became solo-instance host, so
	 *  puppets freeze. Reload the current map via a position-preserving self-teleport;
	 *  the changeMapResponse flips main.host before loadLevel → no strip → live enemies. */
	private reloadAfterPartyLoss(attempt = 0): void {
		try {
			if (!this.connection || !this.connection.isOpen()) return;
			if (this.host) return;                     // block host: map never stripped
			if (!ig.game || !(ig.game as any).playerEntity) return;
			if (ig.game.isTeleporting()) {             // defer past an in-flight load
				if (attempt < 10) setTimeout(() => this.reloadAfterPartyLoss(attempt + 1), 1000);
				return;
			}
			const map: string = (ig.game as any).mapName;
			if (!map) return;
			// Shared towns never strip enemies — no reload needed.
			if (SHARED_TOWNS.indexOf(areaPathOfMap(map)) !== -1) return;
			if (!hasUnlockedArea(map)) this.mpForceStripNextLoad = true; // never-visited wedge guard (round 6)
			console.log('[multiplayer] party lost on wild map ' + map + ' — reloading as solo host');
			try {
				const p: any = (ig.game as any).playerEntity;
				const tp = new (ig as any).TeleportPosition(null);
				tp.setFromData(null, { x: p.coll.pos.x, y: p.coll.pos.y, z: p.coll.pos.z || 0 },
					p.face ? p.face : { x: 0, y: 1 },
					p.coll.level || 0, p.coll.baseZPos || 0,
					p.coll.size ? p.coll.size : { x: 16, y: 16 });
				(ig.game as any).teleport(map, tp);
				return;
			} catch (_) { /* fall through */ }
			(ig.game as any).teleport(map);            // default-spawn fallback
		} catch (_) { /* never break the roster handler */ }
	}

	/** Round 14 MEMBER side: this client changed maps. Reset the leader-map latch and
	 * cull every local synced bot BEFORE the engine's respawnMembers (inside
	 * PartyModel.onMapEnter's parent()) runs — a stray bot still in currentParty would
	 * otherwise be re-spawned as a FRESH, non-puppet entity that the update inject then
	 * drives through engine AI with a null model (crash). The leader never calls this:
	 * its own bots survive map changes via native respawn. */
	public onPartyMapEnter(): void {
		try {
			this._mpLeaderMap = '';
			this.cullLocalBotEntities((sc as any).party);
		} catch (_) { /* ignore */ }
	}

	/** Round 13 MEMBER side: per-frame lerp of puppet bots toward their latest
	 * botState targets (same ~12%/frame as netSync's interpolatePuppets). Big jumps
	 * (teleport / leader switched map) snap instantly. No-op when not in a party. */
	private interpolateBotPuppets(): void {
		try {
			if (!this.partyMembers || this.partyMembers.length <= 1) return;
			const party: any = (sc as any).party;
			if (!party || !party.currentParty) return;
			// Round 16: the leader's botState stream went quiet for 3s without a map
			// mismatch (they teleported to a NEW instance — we're on the same map, so
			// the mismatch cull never fires — or disconnected). Cull the frozen puppets
			// ONCE per stall. Member-only: a PROMOTED leader keeps _mpAdoptedBots for
			// its own bots, so this cull must never run on the leader or it would strip
			// them (the leader never receives botState, but a stale member-side
			// timestamp can survive a leadership transfer).
			if (!this.isPartyLeader && this._mpLastBotStateAt && Date.now() - this._mpLastBotStateAt > 3000) {
				this._mpLastBotStateAt = 0;      // fire once per stall
				this._mpLeaderMap = '';
				this.cullLocalBotEntities((sc as any).party);
				this._mpLastBotNames = [];
				this._mpBotSeenOnce = false;
			}
			const t = Math.min(1, ig.system.tick * 12);
			for (let i = 0; i < party.currentParty.length; i++) {
				const n = party.currentParty[i];
				if (!n) continue;
				const e = this.partyBotEntity(party, n);
				if (!e || !e._mpPuppet || e._killed || !e.coll) continue;
				const cp: any = e.coll.pos;
				if (typeof cp.xProtected !== 'number' || typeof e._mpBotToX !== 'number') continue;
				const dx = e._mpBotToX - cp.xProtected;
				const dy = e._mpBotToY - cp.yProtected;
				const dz = e._mpBotToZ - cp.zProtected;
				if (dx === 0 && dy === 0 && dz === 0) continue;
				if (dx * dx + dy * dy > 120 * 120 || Math.abs(dz) > 100) {
					cp.xProtected = e._mpBotToX; cp.yProtected = e._mpBotToY; cp.zProtected = e._mpBotToZ;
					continue;
				}
				if (dx !== 0) cp.xProtected = cp.xProtected + dx * t;
				if (dy !== 0) cp.yProtected = cp.yProtected + dy * t;
				if (dz !== 0) cp.zProtected = cp.zProtected + dz * t;
			}
		} catch (_) { /* ignore */ }
	}

	/**
	 * If the Social menu is currently open, rebuild its friend list + party box so
	 * presence / roster changes show live. sc.menu.currentMenu is a MENU_SUBMENU
	 * ENUM (not the GUI instance), so we resolve the real submenu via guiReference
	 * and only when it's actually the SOCIAL menu.
	 */
	public refreshOpenSocialMenu(): void {
		try {
			const menu: any = (sc as any).menu;
			if (!menu || menu.currentMenu !== (sc as any).MENU_SUBMENU.SOCIAL) return;
			const guiRef = menu.guiReference;
			const social = guiRef && typeof guiRef._getMenuFromID === 'function'
				? guiRef._getMenuFromID(menu.currentMenu) : null;
			if (!social) return;
			if (social.list && typeof social.list.updatePartyMembers === 'function') {
				social.list.updatePartyMembers();
			}
			if (social.party && typeof social.party.updatePartyMembers === 'function') {
				social.party.updatePartyMembers();
			}
		} catch (e) { /* ignore */ }
	}

	/** Builds (once) a PartyMemberModel for a remote player, reusing a real
	 * character's loaded config but showing the account name. */
	public ensureMpModel(username: string): any {
		const party: any = (sc as any).party;
		if (party.models[username]) return party.models[username];
		const opts: string[] = (sc as any).PARTY_OPTIONS || ['Lea', 'Emilie', 'Sergey'];
		// Pick a face not already used by another injected player.
		const used: { [c: string]: boolean } = {};
		for (const k in party.models) if (party.models[k] && party.models[k]._mpName) used[party.models[k]._mpFace] = true;
		let face = opts[0];
		for (const c of opts) { if (!used[c]) { face = c; break; } }
		const src = party.models[face];
		if (!src) return null;
		const model: any = Object.create(Object.getPrototypeOf(src));
		for (const k in src) model[k] = src[k];
		// The shallow copy above SHARES the source character's mutable sub-objects
		// (equip/params/healing/...). The engine's onStoragePreLoad/reset run
		// setLoadData/reset on EVERY model — including our injected ones — which
		// would clearEquipment()/autoequip() the SHARED equip and clobber the real
		// character's gear/params. Give our model its own copies so it can be
		// reset/saved without touching the source.
		try { model.equip = ig.copy(src.equip); } catch (e) { model.equip = { head: -1, leftArm: -1, rightArm: -1, torso: -1, feet: -1 }; }
		try { model.params = new (sc as any).CombatParams(model); } catch (e) { /* keep shared params as fallback */ }
		try { model.healing = ig.copy(src.healing); } catch (e) { /* ignore */ }
		try { model.core = ig.copy(src.core); } catch (e) { /* ignore */ }
		try { model.baseParams = ig.copy(src.baseParams); } catch (e) { /* ignore */ }
		// Own observer list — the HUD addObserver()s each currentParty member, and a
		// shared array would push our HUD onto the source character too.
		model.observers = [];
		// Round 16: force the protagonist (Lea) avatar. Do NOT mutate model.config —
		// it's a SHARED reference with the source character. Override getHeadIdx as an
		// own property instead (Lea's headIdx is 0 per data/players/lea.json).
		const lea: any = (sc as any).party && (sc as any).party.models ? (sc as any).party.models.Lea : null;
		model.getHeadIdx = function (this: any) {
			try { if (lea && lea.config && typeof lea.config.headIdx === 'number') return lea.config.headIdx; } catch (_) {}
			return 0;
		};
		if (lea && lea.defaultExpression) { model.defaultExpression = lea.defaultExpression; }
		model._mpName = username;
		model._mpFace = face;
		model.getCharacterName = () => username;
		model.getCharacterRealName = () => username;
		party.models[username] = model;
		// Seed the model with the real synced profile so the native SocialInfoBox
		// (which reads model.params/model.equip directly) is correct even before/独立
		// of our explicit overwrite.
		this.applyProfileToModel(username);
		return model;
	}

	/**
	 * Writes a remote player's real synced profile (level/stats/equip) onto their
	 * injected PartyMemberModel, so the native SocialInfoBox.setCharacter — which
	 * reads b.params.getStat(...) and b.equip directly — shows the RIGHT numbers
	 * and gear instead of the cloned face-character's placeholder.
	 */
	public applyProfileToModel(username: string): void {
		const party: any = (sc as any).party;
		const model = party && party.models && party.models[username];
		const profile = this.playerProfiles && this.playerProfiles[username];
		if (!model || !profile) return;
		try {
			let lvlCh = false, expCh = false;
			if (typeof profile.level === 'number' && model.level !== profile.level) { model.level = profile.level; lvlCh = true; }
			// EXP within the level — the Social info box's EXP bar reads model.exp.
			if (typeof profile.exp === 'number' && model.exp !== profile.exp) { model.exp = profile.exp; expCh = true; }
			if (profile.equip && model.equip) {
				for (const slot of ['head', 'leftArm', 'rightArm', 'torso', 'feet']) {
					const id = (profile.equip as any)[slot];
					if (typeof id === 'number') model.equip[slot] = id;
				}
			}
			// params: overwrite the base stats so getStat() returns the real values.
			if (model.params && typeof model.params.setBaseParams === 'function') {
				model.params.setBaseParams({
					hp: profile.hp, attack: profile.attack,
					defense: profile.defense, focus: profile.focus,
				});
			} else if (model.params && model.params.baseParams) {
				if (typeof profile.hp === 'number') model.params.baseParams.hp = profile.hp;
				if (typeof profile.attack === 'number') model.params.baseParams.attack = profile.attack;
				if (typeof profile.defense === 'number') model.params.baseParams.defense = profile.defense;
				if (typeof profile.focus === 'number') model.params.baseParams.focus = profile.focus;
			}
			// Live HP/SP so the party HUD bars reflect combat in near-real-time. These
			// ride the 3s profile (SP has no dedicated sync event; HP also gets the
			// instant updateEntityHealth push, which wins on arrival).
			if (typeof profile.currentHp === 'number') model.params.currentHp = profile.currentHp;
			if (typeof profile.currentSp === 'number') model.params.currentSp = profile.currentSp;
			if (typeof profile.maxSp === 'number') model.params.maxSp = profile.maxSp;
			// Round 14: the member HUD's EXP bar re-renders ONLY on an observer
			// notification (modelChanged: b==EXP_CHANGE -> setExpRatio(model.exp/...));
			// writing model.exp directly never reaches it. Fire after the writes,
			// guarded (the enum may be absent on unusual builds).
			if (lvlCh) { try { (sc as any).Model.notifyObserver(model, (sc as any).PARTY_MEMBER_MSG.LEVEL_CHANGE); } catch (_) { /* ignore */ } }
			if (expCh) { try { (sc as any).Model.notifyObserver(model, (sc as any).PARTY_MEMBER_MSG.EXP_CHANGE); } catch (_) { /* ignore */ } }
		} catch (e) { /* ignore */ }
	}

	/** Console social API + party-invite toast. (Friends/room players live in the
	 * native Social menu now — see ui/socialMenuInject.ts.) */
	private registerSocial(): void {
		// Console API kept as a fallback: mp.friendAdd("bob"), mp.invite("bob"), ...
		// Read this.connection DYNAMICALLY — the old closures captured the first
		// session's connector and went dead after logout/re-login (same class of bug
		// as the party-invite toast, round 7).
		(window as any).mp = {
			friendAdd: (name: string) => this.connection.friendAdd(name),
			friendAccept: (name: string) => this.connection.friendAccept(name),
			friendDecline: (name: string) => this.connection.friendDecline(name),
			friendRemove: (name: string) => this.connection.friendRemove(name),
			friends: () => this.connection.friendList(),
			invite: (name: string) => this.connection.partyInvite(name),
			accept: (partyId: string) => this.connection.partyAccept(partyId),
			decline: (partyId: string) => this.connection.partyDecline(partyId),
			leave: () => this.connection.partyLeave(),
			skipPrologue: () => this.skipToRookieHarbor(),
			saveHere: () => this.saveCurrentLocation(),
			boost: () => this.boost(),
			console: () => this.openDevTools(),
			host: () => this.debugState(),
			run: (cmd: string) => this.runCommand(cmd),
		};
	}

	/** Opens the built-in NW.js DevTools window (the real console) if available. */
	public openDevTools(): void {
		try {
			const gui = (window as any).require && (window as any).require('nw.gui');
			if (gui && gui.Window && gui.Window.get()) {
				gui.Window.get().showDevTools();
				console.log('[multiplayer] DevTools opened');
				return;
			}
		} catch (e) { /* fall through */ }
		console.warn('[multiplayer] nw.gui DevTools unavailable here; use the in-game command box (press F8)');
	}

	/** Executes a chat-style command, e.g. run("skipPrologue") / run("saveHere"). */
	public runCommand(cmd: string): void {
		const mp = (window as any).mp as any;
		const fn = mp && mp[cmd];
		if (typeof fn === 'function') {
			fn();
		} else {
			console.warn('[multiplayer] unknown command: ' + cmd + ' (try skipPrologue, saveHere, boost, friends, host)');
		}
	}

	/** F8 `host` command: dump the live sync state so a tester can see host flag,
	 * map, live mirrors and puppet count at a glance. */
	public debugState(): void {
		const players = Object.keys(this.players).filter(k => this.players[k] && this.players[k]!.entity);
		const puppets = this.netSync ? Object.keys((this.netSync as any).puppets || {}).length : 0;
		const msg = 'map=' + (ig.game && ig.game.mapName) + ' | host=' + this.host
			+ ' | name=' + this.name + ' | mirrors=[' + players.join(',') + ']'
			+ ' | puppets=' + puppets + ' | party=[' + this.partyMembers.join(',') + ']'
			+ ' | connected=' + (this.connection && this.connection.isOpen());
		console.log('[multiplayer] STATE ' + msg);
		try { alert('[multiplayer]\n' + msg); } catch (_) { /* ignore */ }
	}

	/** A non-fatal in-game notice (falls back to console if the dialog system isn't up). */
	private showCenterMessage(text: string): void {
		try {
			(sc as any).Dialogs.showInfoDialog(text);
		} catch (_) {
			try { alert('[multiplayer]\n' + text); } catch (e) { console.warn('[multiplayer] ' + text); }
		}
	}

	/** Saves the current location to the AUTO slot and uploads it to the server
	 * immediately. Run this after you're standing where you want to spawn. */
	public saveCurrentLocation(): void {
		try {
			const storage = (ig as any).storage;
			storage.saveCheckpoint();
			const data = storage.getSlotData(-1);
			if (!data) {
				console.warn('[multiplayer] saveHere: autoSlot data was empty');
				return;
			}
			storage.saveAutoSlot(data);
			this.connection.saveUpload('autoSlot', this.sanitizeSaveStringForUpload(data));
			console.log('[multiplayer] Saved current location (' + ig.game.mapName + ') and uploaded to server');
		} catch (e) {
			console.error('[multiplayer] saveHere failed', e);
		}
	}

	/** Teleports the player straight to Rookie Harbor (skips the prologue/tutorial
	 * for testing). This ONLY moves the player — it does NOT touch story-progress
	 * variables, level, or equipment, so your character stays exactly as-is. The
	 * prologue quest remains available to finish later if you want. */
	public skipToRookieHarbor(): void {
		console.log('[multiplayer] Teleporting to Rookie Harbor (teleporter). Character/story unchanged.');
		ig.game.teleport('rookie-harbor.teleporter');
	}

	/**
	 * Fast-forward for testing: instead of patching stats live (which fights the
	 * engine and caused the bugs you saw), this builds a savegame and loads it
	 * through the game's own ig.SaveSlot / ig.storage.loadSlot pipeline — exactly
	 * how the reference CCMultiplayerClient starts clean from a save instead of
	 * mutating the live model.
	 *
	 * The catch: loadSlot notifies EVERY ig.storage listener's onStoragePreLoad(),
	 * and most subsystems (message/gui/timers/options/party/arena/...) hard-crash
	 * on a save that lacks their key (e.g. a.message.sideMessages). A real save
	 * has all those keys, but fabricating them all is brittle. So we snapshot
	 * ig.storage.listeners, run the load with ONLY the listeners that tolerate a
	 * minimal save (map/vars/player/version), then restore the full list.
	 *
	 * Abilities unlocked: melee (CLOSE_COMBAT), ranged (THROWING), dash (DASH),
	 * guard (GUARD), charge (CHARGE), neutral element — i.e. everything the
	 * prologue + chapter 1 grants. Level ~10 with matching HP/SP/params. Story
	 * flag plot.line = 4310 (past the prologue, before Bergen ~6600).
	 */
	public boost(): void {
		const CORE: any = (sc as any).PLAYER_CORE;
		const SaveSlot: any = (ig as any).SaveSlot;
		const storage: any = (ig as any).storage;
		const player: any = (sc as any).model && (sc as any).model.player;
		if (!CORE || !SaveSlot || !storage || !player || !player.getSaveData) {
			console.warn('[multiplayer] boost: game not ready (start the game first)');
			return;
		}

		// --- player save data, from PlayerModel.getSaveData(), then overridden ---
		const level = 10;
		const playerData: any = player.getSaveData();
		playerData.core = playerData.core || {};
		[CORE.MOVE, CORE.CHARGE, CORE.DASH, CORE.CLOSE_COMBAT, CORE.GUARD,
			CORE.THROWING, CORE.ELEMENT_NEUTRAL, CORE.QUICK_MENU, CORE.MENU,
			CORE.EXP, CORE.SPECIAL, CORE.COMBAT_RANK, CORE.CREDITS]
			.forEach((c) => { if (c !== undefined) playerData.core[c] = true; });
		playerData.level = level;
		playerData.exp = 0;
		playerData.chapter = 1;
		playerData.credit = Math.max(playerData.credit || 0, 2000);
		playerData.hp = 99999; // clamped to maxHp in preLoad
		playerData.spLevel = 2;
		playerData.skillPoints = [level - 1, 0, 0, 0, 0];

		// --- vars: start from current, bump the story line past the prologue ---
		let vars: any = null;
		try { vars = (ig as any).vars.getJson(); } catch (e) { vars = null; }
		if (vars && vars.storage) {
			vars.levelName = 'rookie-harbor.teleporter';
			vars.storage.plot = vars.storage.plot || {};
			vars.storage.plot.line = 4310;
			vars.storage.plot.metaSpace = 0;
		} else {
			vars = {
				levelName: 'rookie-harbor.teleporter',
				storage: {maps: {}, plot: {line: 4310, metaSpace: 0}},
			};
		}

		const saveData: any = {
			map: 'rookie-harbor.teleporter', // map NAME string (loadSlot: teleport(c.map,...))
			position: null,                  // null -> spawn at the map's default point
			vars,
			player: playerData,
			version: (sc as any).version ? (sc as any).version.toOnlyNumberString() : undefined,
			saveVersion: (sc as any).version ? (sc as any).version.saveVersion : 0,
		};

		// loadSlot notifies EVERY ig.storage listener's onStoragePreLoad(save), and
		// most subsystems (message/gui/timers/options/party/arena/...) crash when
		// their key is absent (a.message.sideMessages, a.gui, ...). In this minified
		// build we can't rely on class names, so identify each listener's required
		// key from its source (`function(a){...a.KEY...}`) and keep ONLY those whose
		// key our save provides — plus any that read none (safe by inspection).
		const providedKeys = ['player', 'version', 'saveVersion', 'visitedAreas', 'landmarks'];
		const all = storage.listeners as any[];
		const restored = all.slice();
		const subset = all.filter((l: any) => {
			if (!l || typeof l.onStoragePreLoad !== 'function') return true; // can't crash in preLoad
			let src = '';
			try { src = Function.prototype.toString.call(l.onStoragePreLoad); } catch (e) { return true; }
			const arg = src.match(/function\s*\(\s*([A-Za-z_$][\w$]*)/);
			if (!arg) return true; // no save argument -> safe
			const key = src.match(new RegExp('\\b' + arg[1] + '\\.([A-Za-z_$][\\w$]*)'));
			if (!key) return true; // never dereferences the save -> safe
			return providedKeys.indexOf(key[1]) !== -1;
		});

		try {
			storage.listeners = subset;
			const slot = new SaveSlot(saveData);
			storage.loadSlot(slot, true); // true => teleport back to the saved map
			console.log('[multiplayer] boost applied: loaded a clean Rookie Harbor save ' +
				'(story done, abilities unlocked, level ' + level + '). Use saveHere() to persist.');
		} catch (e) {
			storage.listeners = restored;
			console.error('[multiplayer] boost: failed to load save', e);
			return;
		}
		// Restore the full listener set shortly after the load completes, so the
		// subsystems resume normal save/load behaviour going forward.
		setTimeout(() => { storage.listeners = restored; }, 2000);
	}

	/** Force a save + upload WITHOUT moving the defeat checkpoint. The engine's
	 * saveCheckpoint() writes ig.storage.checkPointSave with _saveState, and
	 * _saveState snapshots position = the player's CURRENT position — so every
	 * periodic/area-change save relocated the "load last checkpoint" point to
	 * wherever the player happened to be standing. After a party wipe the vanilla
	 * defeat flow then teleported players back into the combat area instead of the
	 * real save point (the round-9 "revived at the death spot instead of the
	 * checkpoint" bug). _saveState + saveAutoSlot build/persist the exact same
	 * save (listeners' onStorageSave fires inside _saveState, so the upload hook
	 * runs too) — they just never touch checkPointSave. The explicit `saveHere`
	 * command (saveCurrentLocation) keeps saveCheckpoint() on purpose: it is the
	 * user deliberately moving their spawn point. */
	private saveWithoutMovingCheckpoint(): boolean {
		try {
			const storage: any = (ig as any).storage;
			if (!storage || !ig.game || !ig.game.playerEntity) return false;
			const state: any = {};
			storage._saveState(state); // builds the save + fires onStorageSave (upload hook)
			if (typeof storage.saveAutoSlot === 'function') storage.saveAutoSlot(state);
			return true;
		} catch (e) { return false; }
	}

	/** Force a save and upload it to the server. Used by the event triggers
	 * (area change / teleport-point unlock), the periodic backup and available as
	 * mp.saveNow. Checkpoint-safe: see saveWithoutMovingCheckpoint. */
	public saveNow(reason: string): void {
		try {
			const conn = this.connection;
			if (!conn || !conn.isOpen || !conn.isOpen()) return;
			if (this.saveWithoutMovingCheckpoint()) {
				console.log('[multiplayer] saved + uploaded (' + reason + ')');
			}
		} catch (e) { /* a save must never break the frame */ }
	}

	/** Uploads the save to the server whenever the game saves, plus event-driven
	 * saves (area change, teleport-point unlock — round 6) and a periodic backup.
	 * Restore happens in launchGame() via pendingSaveRestore.
	 * NOTE: callbacks read `this.connection` DYNAMICALLY — capturing the connection
	 * at register time (a per-process hook) silently dead-ended every upload after
	 * the first reconnect, which is why auto/exit saves "never worked". */
	private registerSaveSync(): void {
		try {
			(ig as any).storage.register({
				// ig.Storage._saveState builds the save object and calls
				// onStorageSave(saveObject) — the argument is the SAVE DATA, not a slot
				// index. At this point map/vars/position are set and the subsystems
				// (player, party, quests, stats, ...) each attach their key, so the
				// object is a complete save. Upload it whole (JSON) — the old code
				// treated it as a slot index and uploaded a garbage "slot[object Object]" key.
				onStorageSave: (save: any) => {
					try {
						const conn = this.connection;
						if (!conn || !conn.isOpen || !conn.isOpen()) return;
						this.sanitizePartyForUpload(save);
						// Upload the ENCRYPTED form (same as the 60s backup and what
						// ig.SaveSlot expects on restore). Uploading raw JSON here made
						// restore silently fail: SaveSlot.init only treats a string
						// starting "[-!_0_!-]" as encrypted, so plaintext JSON became a
						// string `data` and loadSlot's `(c=c.getData())&&c.vars` was
						// undefined -> no teleport, no error, fresh game (lost save).
						const tools: any = (ig as any).StorageTools;
						if (tools && typeof tools.encryptSlotData === 'function') {
							conn.saveUpload('autoSlot', tools.encryptSlotData(save));
							return;
						}
						// Fallback (tools missing): plaintext JSON, kept for safety.
						const json = JSON.stringify(save);
						if (json && json.length > 8) conn.saveUpload('autoSlot', json);
					} catch (e) { /* ignore */ }
				},
			});
		} catch (e) {
			console.warn('[multiplayer] could not register storage save hook', e);
		}

		// Event-driven saves (round 6, user request): switching AREA (block) and
		// unlocking a teleport point/landmark both trigger a fresh checkpoint save +
		// upload, so the server copy is never far behind the live game. Once-guarded:
		// registerSaveSync runs once per process but reconnects swap the connection.
		if (!(this as any)._saveTriggersInstalled) {
			(this as any)._saveTriggersInstalled = true;
			let lastArea = '';
			let lastLandmarks = '';
			let lastSaveAt = 0;
			let lastCheckAt = 0;
			simplify.registerUpdate(() => {
				try {
					const conn = this.connection;
					if (!conn || !conn.isOpen || !conn.isOpen()) return;
					const g: any = ig.game;
					if (!g || !g.playerEntity || g.isTeleporting() || (ig as any).loading) return;
					const now = Date.now();
					if (now - lastCheckAt < 500) return; // poll, not per-frame
					lastCheckAt = now;
					if (now - lastSaveAt < 1500) return; // debounce bursty vars changes
					const area = currentAreaPath();
					let landmarks = '';
					try {
						const al = (sc as any).map && (sc as any).map.activeLandmarks;
						if (al) landmarks = JSON.stringify(al);
					} catch (_) { /* ignore */ }
					if (lastArea && area !== lastArea) {
						lastSaveAt = now;
						this.saveNow('area changed: ' + area);
					} else if (lastLandmarks && landmarks !== lastLandmarks) {
						lastSaveAt = now;
						this.saveNow('teleport point unlocked');
					}
					lastArea = area;
					lastLandmarks = landmarks;
				} catch (e) { /* never break the frame for a save */ }
			});
		}

		// Periodic backup every 60s. saveCheckpoint() makes it FRESH (the old code
		// uploaded getAutoSlotData(), which only changes when the game itself writes
		// the autoslot — usually stale or empty).
		setInterval(() => { this.saveNow('periodic backup'); }, 60000);

		// Round 11: while hosting, publish the native party BOT roster so member
		// clients can spawn their own follower copies (checked once per second).
		setInterval(() => { this.checkBotRoster(); }, 1000);
	}

	/**
	 * Strips our injected multiplayer pseudo-players from a save's party block
	 * before it is uploaded to the server. The native onStorageSave serializes
	 * EVERY sc.party model/contact — including the fake `_mp` ones we inject for
	 * the Social menu — and currentParty too. If such a polluted save is later
	 * restored, onStoragePreLoad sets currentParty to a name whose model no longer
	 * exists at runtime, and the in-game party HUD crashes with
	 * "Cannot read property 'observers' of undefined" (addObserver on a missing
	 * PartyMemberModel). Keeping only the native characters (and a currentParty
	 * that references only them) makes the stored save a clean single-player save.
	 */
	private sanitizePartyForUpload(save: any): void {
		try {
			const party: any = (sc as any).party;
			const p = save && save.party;
			if (!p || !party) return;
			const isMp = (name: string) => {
				const c = party.contacts && party.contacts[name];
				const mdl = party.models && party.models[name];
				return !!(name && ((c && c._mp) || (mdl && mdl._mpName)));
			};
			if (p.models) for (const k in p.models) if (isMp(k)) delete p.models[k];
			if (p.contacts) for (const k in p.contacts) if (isMp(k)) delete p.contacts[k];
			if (p.currentParty && p.currentParty.length) {
				p.currentParty = p.currentParty.filter((n: string) => !isMp(n));
			}
		} catch (e) { /* ignore */ }
	}

	/** Same as sanitizePartyForUpload but for an already-serialized save string
	 * (the periodic getAutoSlotData backup). Decrypts -> cleans -> re-encrypts. */
	private sanitizeSaveStringForUpload(str: string): string {
		try {
			const tools: any = (ig as any).StorageTools;
			if (!tools || !str) return str;
			const data = tools.isEncrypted(str) ? tools.decryptSlotData(str) : JSON.parse(str);
			this.sanitizePartyForUpload(data);
			return tools.encryptSlotData(data);
		} catch (e) {
			return str; // on any failure, upload as-is rather than drop the backup
		}
	}

	private startConnect(): void {
		this.connect()
			.then(() => {
				console.log('[multiplayer] Connected');
				this.launchGame();
			})
			.catch((err: any) => {
				console.error(err);
				this.reportConnectError(err);
			});
	}

	/**
	 * Save + logout hooks so a player who exits to the title screen or closes the
	 * game is properly taken offline (previously they stayed "online" on the
	 * server, which then rejected their next login as a duplicate).
	 *
	 *  - ig.game.gotoTitle is wrapped: the pause menu's "exit to title" goes here.
	 *  - window.beforeunload covers closing the window / killing the process.
	 * Both are idempotent (guarded by _loggedOut).
	 */
	private installExitHooks(): void {
		if ((this as any)._exitHooksInstalled) return;
		(this as any)._exitHooksInstalled = true;

		const game: any = ig.game as any;
		if (game && typeof game.gotoTitle === 'function') {
			const original = game.gotoTitle.bind(game);
			game.gotoTitle = (...args: any[]) => {
				this.saveAndLogout();
				return original(...args);
			};
		}

		window.addEventListener('beforeunload', () => {
			this.saveAndLogout();
		});

		// Our party members are REAL network mirrors (spawned by onPlayerChangeMap),
		// NOT the game's single-player follower bots. We add them to currentParty so
		// the in-game HUD shows their HP bars, but we must never let the engine spawn
		// a follower bot for them (respawnMembers/doDeferredEntityUpdate would
		// otherwise try every frame, erroring and stalling on map transitions).
		if (!(this as any)._partySpawnGuardInstalled) {
			(this as any)._partySpawnGuardInstalled = true;
			(sc as any).PartyModel.inject({
				_spawnPartyMemberEntity(this: any, name: string, ...rest: any[]) {
					const mdl = this.models && this.models[name];
					// Real network party members are mirrors — never follower bots.
					// ROUND 12: _mpName models that are NOT in the roster are "mod
					// bots" (offline friends invited as followers) and MUST spawn.
					if (mdl && mdl._mpName) {
						const m = (window as any).__mpMain;
						if (m && m.partyMembers && m.partyMembers.indexOf(name) !== -1) return null;
					}
					// Round 14: idempotent spawn. respawnMembers/doDeferredEntityUpdate can
					// call this for a bot that ALREADY has a live entity (double-spawn /
					// orphan). Reuse the live one; only a stale corpse is dropped so it can
					// respawn cleanly.
					try {
						const cur = this.partyEntities && this.partyEntities[name];
						if (cur) {
							if (!cur._killed) return cur;      // live entity -> reuse, no orphan
							delete this.partyEntities[name];   // stale corpse -> clean respawn
						}
					} catch (_) { /* ignore */ }
					return this.parent(name, ...rest);
				},
				// Our _mp party members have no follower entity (partyEntities[name] is
				// undefined). The native isDefeated() dereferences it blindly:
				//   for(a=currentParty.length;a--;) if(!partyEntities[currentParty[a]].isDefeated())...
				// so losing a fight with an _mp member in the party crashed on a null
				// deref. Skip members with no spawned entity; fall back to the player.
				isDefeated(this: any) {
					// While CONNECTED, the mp death system owns defeat entirely: an
					// individual death becomes spectate + countdown (host AND member),
					// and only when the WHOLE party is down does netSync fire the
					// vanilla checkpoint reload — for everyone at once. Returning true
					// here at any earlier moment lets the engine run its single-player
					// full-defeat flow for just this client: that was the host skipping
					// straight to the restart flow, and the member later stuck at 0 HP
					// after the host's solo checkpoint reload (round 7). Gate on the
					// connection, not on isLocalDead(): the old gate had a 1-frame race
					// at the death moment (hp 0 -> native check ran before our death
					// state was up).
					const m = (window as any).__mpMain;
					if (m && m.connection && m.connection.isOpen && m.connection.isOpen()) return false;
					const cp = this.currentParty || [];
					for (let a = cp.length; a--;) {
						const ent = this.partyEntities && this.partyEntities[cp[a]];
						if (ent && typeof ent.isDefeated === 'function' && !ent.isDefeated()) return false;
					}
					const p = ig.game && (ig.game as any).playerEntity;
					return p ? p.isDefeated() : this.parent();
				},
			});
			// ROUND 13: party bots are leader-driven puppets on non-leader clients —
			// suppress the PartyMemberEntity AI state machine (it lives ENTIRELY in
			// update's pre-parent() block) and keep only physics/anim/HP-bar alive via
			// the direct PlayerBaseEntity.update call. Puppets are position-locked and
			// lerped from the leader's botState stream, so AI would only fight the net.
			(sc as any).PartyMemberEntity.inject({
				update(this: any) {
					// Round 14: a NULL model is exactly as dangerous as a puppet — the
					// engine AI (this.parent()) derefs this.model and crashes. Treat it as
					// a puppet: run the base update and kill the model-less entity instead
					// of ever routing it into the engine AI state machine.
					if ((this as any)._mpPuppet || !this.model) {
						try { (sc as any).PlayerBaseEntity.prototype.update.call(this); } catch (_) { /* ignore */ }
						if (!this.model && !this.currentAction) { try { this.kill(); } catch (_) { /* ignore */ } }
						return;
					}
					return this.parent();
				},
			});
			// ROUND 13: a member's own kills must not level the leader's synced bots
			// locally (sc.party.addExperience distributes to every follower model, so
			// member-local bots would level up independently of the leader). Suppress
			// PartyMemberModel.addExperience for puppet-marked models (_mpBotSynced)
			// and for any _mpName model while we are NOT the leader. The original
			// method returns nothing, so an early return matches its signature.
			(sc as any).PartyMemberModel.inject({
				addExperience(this: any, a: any, b: any, e: any, f: any, g: any) {
					try {
						const m = (window as any).__mpMain;
						const isLeader = !!(m && m.name && m.partyLeader === m.name);
						if (this._mpBotSynced || (!isLeader && this._mpName)) return;
					} catch (_) { /* ignore */ }
					return this.parent(a, b, e, f, g);
				},
			});
			// Round 14: on a member's map change, cull synced bots BEFORE the engine's
			// respawnMembers runs. sc.PartyModel.onMapEnter -> respawnMembers spawns a
			// FRESH, non-puppet PartyMemberEntity for any bot still in currentParty
			// (that re-introduced a model-less zombie right after the cull, and the
			// update inject previously drove it through engine AI -> null crash). Only
			// non-leader members in a multi-member party cull; the LEADER path is
			// untouched (its own bots survive map changes via native respawn).
			(sc as any).PartyModel.inject({
				onMapEnter(this: any) {
					try {
						const m = (window as any).__mpMain;
						if (m && !m.isPartyLeader && m.partyMembers && m.partyMembers.length > 1) {
							m.onPartyMapEnter();
						}
					} catch (_) { /* ignore */ }
					return this.parent();
				},
			});
		}
	}

	/** Saves the current location to the server and logs out (idempotent). */
	private saveAndLogout(): void {
		if ((this as any)._loggedOut) return;
		(this as any)._loggedOut = true;
		try {
			// Best-effort final save (checkpoint-safe — see saveWithoutMovingCheckpoint;
			// the onStorageSave hook uploads while the socket is still open).
			this.saveWithoutMovingCheckpoint();
		} catch (e) { /* ignore */ }
		try {
			this.connection.logout();
		} catch (e) { /* ignore */ }
		// Close the socket so a title-screen client can't keep streaming playerState
		// into a logged-out ("unauthenticated") socket and flood the server console.
		try {
			const sock: any = this.connection as any;
			if (sock && sock.socket && typeof sock.socket.close === 'function') sock.socket.close();
		} catch (e) { /* ignore */ }
		this.clearMultiplayerState();
		console.log('[multiplayer] saved + logged out');
	}

	/**
	 * Called when the socket drops (server closed / network lost). socket.io keeps
	 * trying to reconnect in the background, so we allow a short grace period (in
	 * case the server is just restarting). If we're still offline after that, save
	 * the game and return to the title screen instead of leaving the player
	 * stranded in a dead session.
	 */
	public onConnectionLost(): void {
		const self = this as any;
		if (self._disconnectHandled) return;
		self._disconnectHandled = true;
		console.log('[multiplayer] connection lost; waiting briefly for reconnect...');

		const GRACE_MS = 12000;
		setTimeout(() => {
			if (this.connection && this.connection.isOpen()) {
				// Server came back within the grace period — stay in game.
				console.log('[multiplayer] reconnected; staying in game');
				self._disconnectHandled = false;
				return;
			}
			this.dropToTitleOnServerDown();
		}, GRACE_MS);
	}

	/** Save + return to title because the server is unreachable. */
	private dropToTitleOnServerDown(): void {
		try {
			// Best-effort save (the upload won't reach a dead server, but the local
			// autoslot persists; checkpoint-safe — see saveWithoutMovingCheckpoint).
			this.saveWithoutMovingCheckpoint();
		} catch (e) { /* ignore */ }

		try { alert(t('connLost')); } catch (_) { /* ignore */ }

		try {
			// Close the socket so socket.io stops reconnecting in the background.
			const sock: any = this.connection as any;
			if (sock && sock.socket && typeof sock.socket.close === 'function') sock.socket.close();
		} catch (e) { /* ignore */ }

		// Mark logged-out so we don't try to re-save on the way out, and so a later
		// reconnect on this client re-arms cleanly (connect() resets _loggedOut).
		(this as any)._loggedOut = true;
		this.name = undefined;
		this.clearMultiplayerState();
		try { (ig.game as any).gotoTitle(); } catch (e) {
			console.error('[multiplayer] gotoTitle failed', e);
		}
		console.log('[multiplayer] returned to title (server unreachable)');
	}

	/** Despawn all remote mirrors and drop party/social state (on logout / server
	 * loss), so a stale mirror or roster doesn't leak into the title screen or the
	 * next session. */
	private clearMultiplayerState(): void {
		// Round 19: kill every cutscene puppet + drop cached mirror fade state and
		// any stashed regroup (logout / server loss ends the session's world state).
		try { if (this.netSync) this.netSync.clearCsPuppets(); } catch (e) { /* ignore */ }
		this._pendingRegroup = null;
		// Round 19: a logout/server-loss ends any PVP-duel isolation (the server
		// clears the override on disconnect too) — the client flag must not leak
		// into the next session.
		this.isolated = false;
		try {
			for (const name in this.players) {
				const p = this.players[name];
				if (p && p.entity) { try { p.entity.kill(); } catch (e) { /* ignore */ } }
			}
		} catch (e) { /* ignore */ }
		this.players = {};
		this.partyMembers = [];
		this.partyLeader = undefined;
		// Round 17: remote-ping cache is session-scoped — wipe it on logout/server loss
		// so a stale ping never leaks into the next session's tags.
		this.remotePings = {};
		// Round 20: the cached instance-host username is session-scoped too.
		this.instanceHost = undefined;
		// Round 20: ghost-chest sync state is session-scoped — kill any ghosts, restore
		// any live-chest alphas we faded, and drop the opened-by/chest-info caches.
		try { if (this.ghostChests) this.ghostChests.reset(); } catch (e) { /* ignore */ }
		// Round 13: drop the leader botState stream + any adopted-bot tracking.
		this.stopBotStream();
		this._mpAdoptedBots = {};
		this._mpLastBotNames = [];
		this._mpBotSeenOnce = false;
		this._mpLeaderMap = '';
		this._mpLastBotStateAt = 0;
	}

	/**
	 * Surface connection failures where the player can actually see them. The
	 * default `console.error` only reaches the hidden DevTools console, so a
	 * failed connect looked like "nothing happened". Log to the CCLoader log AND
	 * show an in-game dialog.
	 */
	private reportConnectError(err: any): void {
		// Round 16: a user-initiated cancel of the login panel is not a connection
		// failure — return silently so no error dialog pops for it.
		if (err === 'cancelled') return;
		const message = (err && err.message) ? err.message : String(err);
		// A plain alert always works in NW.js and is impossible to miss. This is
		// the reliable path — console.error only reaches the hidden DevTools.
		try {
			alert(t('connFailed') + ':\n\n' + message);
		} catch (_) { /* ignore */ }
	}

	private launchGame(): void {
		// Remove title screen interact.
		// const buttonInteract = ig.gui.menues[15].children[2].buttonInteract; // TODO Resolve buttonInteract
		// ig.interact.removeEntry(buttonInteract);

		ig.interact.removeEntry(ig.interact.entries[0]);
		ig.bgm.clear('MEDIUM_OUT'); // Clear BGM

		// Restore a server-side save (if any) once the engine is up, then hand off
		// to the game's normal start. loadSlot teleports us back to the saved map.
		if (this.pendingSaveRestore) {
			const data = this.pendingSaveRestore;
			this.pendingSaveRestore = undefined;
			this.onceGameReady(() => {
				try {
					// Normalize to the encrypted form before building the SaveSlot:
					// SaveSlot.init only treats a "[-!_0_!-]"-prefixed string as
					// encrypted, so a legacy plaintext save would otherwise become a
					// string `data` and loadSlot would silently no-op (lost save).
					let raw: any = data;
					const tools: any = (ig as any).StorageTools;
					if (typeof raw === 'string' && tools && !tools.isEncrypted(raw)) {
						try { raw = tools.encryptSlotData(JSON.parse(raw)); } catch (e) { /* keep as-is */ }
					}
					const slot = new (ig as any).SaveSlot(raw);
					// Defense-in-depth: drop any party members whose model doesn't
					// exist at runtime (e.g. a save polluted by an older build that
					// uploaded our _mp pseudo-players). Restoring such a save crashes
					// the party HUD (addObserver on an undefined PartyMemberModel).
					this.cleanRestoredParty(slot.getData());
					(ig as any).storage.loadSlot(slot, true);
					console.log('[multiplayer] Restored server save');
				} catch (e) {
					console.error('[multiplayer] Failed to restore server save, starting fresh', e);
					ig.game.start();
				}
			});
			// Start the game so loadingComplete fires; loadSlot then takes over.
			ig.game.start();
			return;
		}

		ig.game.start(); // Start the game in story mode.
	}

	/**
	 * Before restoring a save, drop any currentParty entry (and party model/contact)
	 * that has no live model at runtime. Guards against polluted saves written by an
	 * older build that serialized our injected `_mp` pseudo-players: without this the
	 * native party HUD crashes restoring them (addObserver on an undefined model).
	 */
	private cleanRestoredParty(saveData: any): void {
		try {
			const party: any = (sc as any).party;
			const p = saveData && saveData.party;
			if (!p || !party || !party.models) return;
			const valid = (n: string) => n === 'Lea' || !!party.models[n];
			if (p.currentParty && p.currentParty.length) {
				p.currentParty = p.currentParty.filter(valid);
			}
			if (p.models) for (const k in p.models) if (!valid(k)) delete p.models[k];
			if (p.contacts) for (const k in p.contacts) if (!valid(k)) delete p.contacts[k];
		} catch (e) { /* ignore */ }
	}

	/** Runs cb once after the next level load completes. Also re-applies the party
	 * roster so HP bars survive the onReset that game start/level load performs. */
	public onceGameReady(cb: () => void): void {
		const self = this as any;
		if (this._readyHookInstalled) {
			this._pendingReady.push(cb);
			return;
		}
		this._readyHookInstalled = true;
		this._pendingReady = [cb];
		ig.Game.inject({
			loadingComplete(this: any) {
				this.parent();
				// ig.game.start()/onReset clears sc.party.currentParty. If we already
				// have a cached roster (a partyUpdate arrived before the game started),
				// re-apply it now so the in-game HP bars aren't missing until the next
				// partyUpdate. No-op when solo.
				try {
					if (self.partyMembers && self.partyMembers.length) self.applyPartyRoster(self.partyMembers);
				} catch (e) { /* ignore */ }
				const cbs = self._pendingReady.splice(0);
				for (const c of cbs) c();
			},
		});
	}

	/** Inject the login-panel stylesheet exactly once (same idempotent pattern as
	 *  socialOverlay.ensureCommStyle — reuses the comm-call visual language: dark
	 *  navy panel, cyan border, Noto Sans SC). */
	private ensureLoginStyle(): void {
		if (document.getElementById('mpLoginStyle')) return;
		const style = document.createElement('style');
		style.id = 'mpLoginStyle';
		style.textContent = `
.mpLogin {
    position: fixed; left: 50%; top: 50%;
    transform: translate(-50%, -50%);
    width: 380px; max-width: 92vw;
    background: rgba(6, 18, 30, 0.94);
    border: 2px solid #6fc7ff; border-radius: 6px;
    box-shadow: 0 0 18px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    z-index: 10000; padding: 16px 18px 14px 18px;
    animation: mpLoginIn 0.22s ease-out;
}
@keyframes mpLoginIn { from { opacity: 0; transform: translate(-50%, -50%) translateY(16px); }
                        to   { opacity: 1; transform: translate(-50%, -50%) translateY(0); } }
.mpLoginHead { display: flex; align-items: center;
    border-bottom: 1px solid rgba(111,199,255,0.4); padding-bottom: 8px; margin-bottom: 12px; }
.mpLoginTitle { font-size: 15px; letter-spacing: 2px; color: #dff3ff; }
.mpLoginClose { margin-left: auto; width: 24px; height: 24px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #dff3ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 14px; line-height: 22px; text-align: center; font-family: inherit; }
.mpLoginClose:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpLoginInput { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 8px;
    background: rgba(8, 26, 44, 0.9); color: #eaf7ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 14px; font-family: inherit; outline: none; }
.mpLoginInput:focus { box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpLoginHint { font-size: 12px; color: #ff9d9d; min-height: 15px; margin-bottom: 8px; }
.mpLoginSubmit { width: 100%; padding: 8px 14px; cursor: pointer;
    background: rgba(31, 111, 74, 0.9); color: #eafff2;
    border: 1px solid #7dffa8; border-radius: 4px;
    font-size: 14px; font-family: inherit; letter-spacing: 2px; }
.mpLoginSubmit:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }
.mpLoginRecent { margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(111,199,255,0.3); }
.mpLoginRecentLabel { font-size: 11px; letter-spacing: 1px; color: #8fd6ff; margin-bottom: 6px; }
.mpLoginChips { display: flex; flex-wrap: wrap; gap: 6px; }
.mpLoginChip { padding: 3px 10px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #dff3ff;
    border: 1px solid #6fc7ff; border-radius: 12px;
    font-size: 12px; font-family: inherit; }
.mpLoginChip:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
`;
		document.head.appendChild(style);
	}

	private showLogin(): Promise<string> {
		return new Promise((resolve, reject) => {
			this.ensureLoginStyle();

			// Round 16: the login panel is a centered DOM overlay (comm-call visual
			// language) instead of the old full-width black band. Fresh per call —
			// no cached username, so re-login after gotoTitle keeps working.
			const box = $('<div class="mpLogin"></div>');
			const hist = readLoginHistory();
			const input = $('<input type="text" class="mpLoginInput" />');
			input.attr('placeholder', t('loginUserPh'));
			input.val(hist.last || '');
			const hint = $('<div class="mpLoginHint"></div>');
			const submit = $('<button type="submit" class="mpLoginSubmit">' + t('loginSubmit') + '</button>');
			const close = $('<button type="button" class="mpLoginClose" title="Close">&times;</button>');
			const form = $('<form></form>');

			let settled = false;
			const cleanup = (): void => {
				if (settled) return;
				settled = true;
				try { ig.system.removeFocusListener(onFocus); } catch (_) { /* ignore */ }
				document.removeEventListener('mousedown', onMousedown, true);
				box.remove();
				ig.system.regainFocus();
				// Swallow the click that closed the panel so it doesn't hit a title
				// button underneath (the openAddFriendBox idiom).
				try { (ig.interact as any).setBlockDelay(0.2); } catch (_) { /* ignore */ }
			};
			const commit = (name: string): void => {
				persistLoginHistory(name);
				cleanup();
				resolve(name);
			};
			const cancel = (): void => {
				cleanup();
				reject('cancelled'); // distinctive marker — startConnect must not alert
			};
			const submitName = (): void => {
				const name = String(input.val() || '').trim();
				if (!name) {
					hint.text(t('loginRequired'));
					input.focus();
					return; // do NOT settle — keep the panel open, focus in the input
				}
				commit(name);
			};

			// Round 16: the old focus listener REMOVED the box on regained focus and
			// never settled the promise -> connect() hung forever on the title screen.
			// Replaced: any regain that isn't a submit CANCELS (rejects) instead of
			// silently dropping; while the user is typing we keep the panel instead.
			const onFocus = (): void => {
				if (settled) return;
				if (document.activeElement === input[0]) {
					try { ig.system.setFocusLost(); } catch (_) { /* ignore */ }
					return;
				}
				cancel();
			};
			ig.system.addFocusListener(onFocus);

			// Clicking OUTSIDE the panel cancels too (a normal modal dismiss). The
			// capture phase runs before the game's own mousedown handling, so cancel
			// + setBlockDelay swallow the closing click before it hits a title button.
			const onMousedown = (e: MouseEvent): void => {
				if (settled) return;
				if (box[0] && !box[0].contains(e.target as Node)) cancel();
			};
			document.addEventListener('mousedown', onMousedown, true);

			// Header: title + a visible close (X) affordance wired to the same reject.
			const head = $('<div class="mpLoginHead"></div>');
			head.append('<span class="mpLoginTitle">' + t('loginTitle') + '</span>');
			head.append(close);
			box.append(head);

			form.append(input).append(hint).append(submit);
			box.append(form);

			// Recent users: one chip per previously-used name — clicking one submits
			// that name immediately.
			const recents = hist.recent.filter((r) => !!r && r !== hist.last);
			if (recents.length) {
				const recentBox = $('<div class="mpLoginRecent"></div>');
				recentBox.append('<div class="mpLoginRecentLabel">' + t('loginRecent') + '</div>');
				const chips = $('<div class="mpLoginChips"></div>');
				for (const r of recents) {
					const chip = $('<button type="button" class="mpLoginChip"></button>');
					chip.text(r);
					chip.on('click', () => commit(r));
					chips.append(chip);
				}
				recentBox.append(chips);
				box.append(recentBox);
			}

			form.submit(() => {
				submitName();
				return false;
			});
			close.on('click', () => cancel());

			$(document.body).append(box);
			ig.system.setFocusLost();
			input.focus();
		});
	}

	private disableFocus() {
		ig.system.hasFocusLost = () => false;
	}
}

// ---- login history (localStorage) ----

/** Read the stored login history: { last, recent[] } (newest first, capped at 5). */
function readLoginHistory(): { last: string, recent: string[] } {
	try {
		const raw = localStorage.getItem('cc-mp-login');
		if (raw) {
			const data = JSON.parse(raw);
			if (data && typeof data === 'object') {
				const recent = Array.isArray(data.recent)
					? data.recent.filter((x: any) => typeof x === 'string')
					: [];
				return {
					last: typeof data.last === 'string' ? data.last : '',
					recent,
				};
			}
		}
	} catch (_) { /* ignore */ }
	return { last: '', recent: [] };
}

/** Persist a successful login: newest first, dedup, cap 5. */
function persistLoginHistory(name: string): void {
	try {
		const hist = readLoginHistory();
		const recent = [name].concat(hist.recent.filter((r) => r !== name)).slice(0, 5);
		localStorage.setItem('cc-mp-login', JSON.stringify({ last: name, recent }));
	} catch (_) { /* ignore */ }
}