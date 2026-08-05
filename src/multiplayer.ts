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
import { currentAreaPath, currentAreaType, areaPathOfMap, areaTypeOfMap, isSharedTownNow } from './util/areaUtil';
import { SocialOverlay } from './ui/socialOverlay';

// CrossCode ships jQuery globally (declared in types.d.ts); overlays use it directly.

export class Multiplayer {
	public futureEntities: IEntityDefinition[] = [];
	public players: {[name: string]: IPlayer | undefined} = {};
	public config: MultiplayerConfig;
	public connection!: IConnection;
	public name?: string;
	public host = false;
	public loadingMap = false;

	public entities: IMultiplayerEntity[] = [];

	private loadScreen!: () => void;
	private nextEID = 1;
	private entitySpawnListener!: OnEntitySpawnListener;
	private loadScreenHook = new LoadScreenHook();
	private pendingSaveRestore?: string;
	private _readyHookInstalled = false;
	private _pendingReady: Array<() => void> = [];
	private socialOverlay!: SocialOverlay;
	/** In-flight changeMap response, awaited by onMapEnter to decide enemy stripping. */
	public pendingChangeMap?: Promise<IChangeMapResult>;

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
		// per-account social scoping).
		this.name = username;
		this.installExitHooks();

		// Lobby architecture: the server no longer forces everyone onto one map.
		// `host` here only means "you are the authority for your own solo world"
		// until you join a shared instance (changeMap decides the real per-instance
		// host). We always start as our own host so enemies spawn locally.
		this.host = true;

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
			const entity = this.entitySpawnListener.onEntitySpawned(e.type, e.pos.x, e.pos.y, e.pos.z, e.settings);

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
		if (!to.xProtected) {
			return this.copyPosition(from, to);
		}

		to.xProtected = from.x;
		to.yProtected = from.y;
		to.zProtected = from.z;
	}

	/**
	 * In shared towns (e.g. Rookie Harbor) remote-player mirrors have no collision
	 * so players can walk through each other. Called once per tick from update();
	 * flips each mirror's coll.type between IGNORE (in town) and its original
	 * value (elsewhere). Mirrors store their base coll.type on first call.
	 */
	public refreshTownCollision(): void {
		const inTown = isSharedTownNow();
		for (const name in this.players) {
			const player = this.players[name];
			const entity = player && player.entity;
			if (!entity || !entity.coll) continue;
			const e = entity as any;
			if (e._mpBaseCollType === undefined) e._mpBaseCollType = entity.coll.type;
			const target = inTown ? 1 /* ig.COLLTYPE.IGNORE */ : e._mpBaseCollType;
			if (entity.coll.type !== target) entity.coll.type = target;
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

		buttons[buttonNumber].setText('Connect', true);
		this.loadScreen = buttons[buttonNumber].onButtonPress;
		buttons[buttonNumber].onButtonPress = this.startConnect.bind(this);
	}

	private initializeListeners(): void {
		const entityListener = new EntityListener(this);
		const playerListener = new PlayerListener(this);

		entityListener.register();
		playerListener.register();

		// Keep remote-player mirror collision in sync with whether we're in a
		// shared town (walk-through in town, solid elsewhere).
		simplify.registerUpdate(() => this.refreshTownCollision());

		const playerMove = new OnPlayerMoveListener(this);
		const playerAnimation = new OnPlayerAnimationListener(this);
		const playerHealth = new OnPlayerHealthChangeListener(this);
		const entityMove = new OnEntityMoveListener(this);
		const entityAnimation = new OnEntityAnimationListener(this);
		const entityHealthChange = new OnEntityHealthChangeListener(this);
		const entityTargetChange = new OnEntityTargetChangeListener(this);
		const entityStateChange = new OnEntityStateChangeListener(this);

		playerMove.register(playerListener);
		playerAnimation.register(playerListener);
		playerHealth.register(playerListener);
		entityMove.register(entityListener);
		entityAnimation.register(entityListener);
		entityHealthChange.register(entityListener);
		entityTargetChange.register(entityListener);
		entityStateChange.register(entityListener);

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
		updatePosition.register();
		updateAnim.register();
		updateAnimTimer.register();
		registerEntity.register();
		killEntity.register();
		throwBall.register();
		entityPosition.register();
		entityAnim.register();
		entityState.register();
		entityTarget.register();
		entityHealth.register();

		this.registerLobbySocial();
		this.registerSocial();
		this.registerSaveSync();
	}

	/**
	 * Party + friend-request callbacks. The party roster drives both the native
	 * Social-party box AND a real in-world follower entity for each remote party
	 * member (so accepting an invite actually shows them in your party).
	 */
	private registerLobbySocial(): void {
		const conn = this.connection;

		conn.onPartyUpdate((party) => {
			this.applyPartyRoster(party ? party.members : []);
		});

		// Friend requests / invites surface as accept-decline toasts (socialOverlay
		// handles the party-invite toast; we add the friend-request one here).
		conn.onFriendRequest((from) => {
			this.socialOverlay.friendRequestToast(from);
		});

		// Real remote-player profiles for the Social info box.
		conn.onPlayerProfile((player, profile) => {
			this.playerProfiles[player] = profile;
		});

		// Periodically broadcast OUR real profile so others' info boxes are correct.
		let profileTimer = 0;
		simplify.registerUpdate(() => {
			profileTimer -= ig.system.tick;
			if (profileTimer > 0) return;
			profileTimer = 3; // every 3s
			const p = this.buildOwnProfile();
			if (p && this.connection && this.connection.isOpen()) {
				try { this.connection.updatePlayerProfile(p); } catch (e) { /* ignore */ }
			}
		});
	}

	/** Cache of remote players' real profiles (username -> profile). */
	public playerProfiles: { [username: string]: import('./connection').IPlayerProfile } = {};

	/** The real profile for a remote player, if we've received one. */
	public getPlayerProfile(username: string): import('./connection').IPlayerProfile | undefined {
		return this.playerProfiles[username];
	}

	/** Reads the local player's real level/stats/equip for broadcast. */
	private buildOwnProfile(): import('./connection').IPlayerProfile | null {
		try {
			const p: any = (sc as any).model && (sc as any).model.player;
			if (!p || !p.params) return null;
			return {
				level: p.level,
				hp: p.params.getStat('hp'),
				attack: p.params.getStat('attack'),
				defense: p.params.getStat('defense'),
				focus: p.params.getStat('focus'),
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
	 * Syncs the in-game party with the server roster: injects each remote member
	 * as a PartyMemberModel + contact, adds them to sc.party.currentParty (which
	 * spawns their follower entity in PATH/DUNGEON maps), and removes members who
	 * left. Only ever touches _mpName models — the player's real NPCs are untouched.
	 */
	private applyPartyRoster(members: string[]): void {
		const party: any = (sc as any).party;
		if (!party || !this.name) return;
		const remote = members.filter((m) => m && m !== this.name);

		// Add new members.
		for (const name of remote) {
			this.ensureMpModel(name);
			const c = party.contacts[name] || (party.contacts[name] = {});
			c.status = (sc as any).PARTY_MEMBER_TYPE ? (sc as any).PARTY_MEMBER_TYPE.FRIEND : 2;
			c.online = true;
			c.locked = false;
			if (!party.isPartyMember(name)) {
				// addPartyMember(name, b, c, d, i): i=false => NOT temporary, so the
				// follower entity actually spawns (temporary members are hidden).
				// b=null/c=false => deferred entity spawn (handled on next map tick).
				try { party.addPartyMember(name, null, false, false, false); } catch (e) { /* ignore */ }
			}
		}
		// Remove members who are no longer in the party (only our injected ones).
		for (let i = party.currentParty.length - 1; i >= 0; i--) {
			const name = party.currentParty[i];
			if (party.models[name] && party.models[name]._mpName && remote.indexOf(name) === -1) {
				try { party.removePartyMember(name, null, true); } catch (e) { /* ignore */ }
			}
		}
		// The native social party box (if open) rebuilds from currentParty.
		try {
			const menu: any = (sc as any).menu;
			if (menu && menu.currentMenu && menu.currentMenu.party && menu.currentMenu.party.updatePartyMembers) {
				menu.currentMenu.party.updatePartyMembers();
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
		model._mpName = username;
		model._mpFace = face;
		model.getCharacterName = () => username;
		model.getCharacterRealName = () => username;
		party.models[username] = model;
		return model;
	}

	/** Console social API + party-invite toast. (Friends/room players live in the
	 * native Social menu now — see ui/socialMenuInject.ts.) */
	private registerSocial(): void {
		const conn = this.connection;

		// F8 command box + party-invite toast. (The old L-key friends overlay was
		// removed; the native Social menu shows friends & room players instead.)
		this.socialOverlay = new SocialOverlay(this);
		this.socialOverlay.register();

		// Console API kept as a fallback: mp.friendAdd("bob"), mp.invite("bob"), ...
		(window as any).mp = {
			friendAdd: (name: string) => conn.friendAdd(name),
			friendAccept: (name: string) => conn.friendAccept(name),
			friendDecline: (name: string) => conn.friendDecline(name),
			friendRemove: (name: string) => conn.friendRemove(name),
			friends: () => conn.friendList(),
			invite: (name: string) => conn.partyInvite(name),
			accept: (partyId: string) => conn.partyAccept(partyId),
			decline: (partyId: string) => conn.partyDecline(partyId),
			leave: () => conn.partyLeave(),
			skipPrologue: () => this.skipToRookieHarbor(),
			saveHere: () => this.saveCurrentLocation(),
			boost: () => this.boost(),
			console: () => this.openDevTools(),
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
			console.warn('[multiplayer] unknown command: ' + cmd + ' (try skipPrologue, saveHere, boost, friends)');
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
			this.connection.saveUpload('autoSlot', data);
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

	/** Uploads the save to the server whenever the game saves, plus a periodic
	 * autoSlot backup. Restore happens in launchGame() via pendingSaveRestore. */
	private registerSaveSync(): void {
		const conn = this.connection;
		try {
			(ig as any).storage.register({
				onStorageSave: (slot: number) => {
					try {
						conn.saveUpload('slot' + slot, (ig as any).storage.getSlotData(slot));
					} catch (e) { /* ignore */ }
				},
			});
		} catch (e) {
			console.warn('[multiplayer] could not register storage save hook', e);
		}

		// Periodic autoSlot backup every 60s.
		setInterval(() => {
			try {
				if ((ig as any).storage && (ig as any).storage.getAutoSlotData) {
					conn.saveUpload('autoSlot', (ig as any).storage.getAutoSlotData());
				}
			} catch (e) { /* ignore */ }
		}, 60000);
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
	}

	/** Saves the current location to the server and logs out (idempotent). */
	private saveAndLogout(): void {
		if ((this as any)._loggedOut) return;
		(this as any)._loggedOut = true;
		try {
			// Best-effort final save (same path as saveHere).
			const storage: any = (ig as any).storage;
			if (storage && ig.game && ig.game.playerEntity) {
				storage.saveCheckpoint();
				const data = storage.getSlotData(-1);
				if (data) {
					storage.saveAutoSlot(data);
					this.connection.saveUpload('autoSlot', data);
				}
			}
		} catch (e) { /* ignore */ }
		try {
			this.connection.logout();
		} catch (e) { /* ignore */ }
		console.log('[multiplayer] saved + logged out');
	}

	/**
	 * Surface connection failures where the player can actually see them. The
	 * default `console.error` only reaches the hidden DevTools console, so a
	 * failed connect looked like "nothing happened". Log to the CCLoader log AND
	 * show an in-game dialog.
	 */
	private reportConnectError(err: any): void {
		const message = (err && err.message) ? err.message : String(err);
		// A plain alert always works in NW.js and is impossible to miss. This is
		// the reliable path — console.error only reaches the hidden DevTools.
		try {
			alert('[multiplayer] 连接失败 (Connect failed):\n\n' + message);
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
					const slot = new (ig as any).SaveSlot(data);
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

	/** Runs cb once after the next level load completes. */
	private onceGameReady(cb: () => void): void {
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
				const cbs = self._pendingReady.splice(0);
				for (const c of cbs) c();
			},
		});
	}

	private showLogin(): Promise<string> {
		return new Promise((resolve, reject) => {
			const box = $('<div class="gameOverlayBox gamecodeMessage" ><h3>Multiplayer Login</h3></div>');
			const form = $('<form><input type="text" name="username" placeholder="Username" /> \
                            <input type="submit" name="send" value="Submit" /><form>');
			box.append(form);

			form.submit(() => {
				const userInput = form[0].firstElementChild as HTMLInputElement;

				const name = userInput.value;
				if (!name || name === '') {
					reject(name);
				}

				ig.system.regainFocus();
				resolve(name);

				return false;
			});

			$(document.body).append(box);
			box.addClass('shown');
			ig.system.setFocusLost();

			ig.system.addFocusListener(() => {
				box.remove();
			});

			form.find('input[type=text]').focus();
		});
	}

	private disableFocus() {
		ig.system.hasFocusLost = () => false;
	}
}