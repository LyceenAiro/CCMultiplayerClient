import { IBallInfo } from '../ballInfo';
import { IConnection, IChangeMapResult, IPlayerProfile, IBotStateEntry } from '../connection';
import { Multiplayer, MP_VERSION } from '../multiplayer';
import { IServer } from '../server';

import type { Socket } from 'socket.io-client';

// The socket.io client library is fetched from the server at runtime (see
// `load()`), which exposes the global `io`. We can't bundle the import under
// CCLoader v2 because the mod is a classic (non-module) script.
declare const io: typeof import('socket.io-client').io;

export class SocketIoConnector implements IConnection {
	private readonly PATH = 'socket.io/socket.io.js';

	private main: Multiplayer;
	private address: string;
	private socket!: Socket;

	private username?: string;
	private map?: string;
	private marker?: string | null;
	private setHost?: (isHost: boolean) => void;

	// ---- Round 16: client-side latency probe ----
	// The server echoes our `mpPing {t: Date.now()}` payload back verbatim
	// (rate-limited 10/s per socket; we send 1/s), so RTT is trivially measurable.
	private pingTimer: any = null;
	/** Latest smoothed round-trip latency to the server in ms; -1 when unknown
	 * (never connected / disconnected). Read by the options tag display. */
	public pingMs = -1;

	constructor(main: Multiplayer, server: IServer) {
		this.main = main;
		this.address = server.type + '://' + server.hostname + ':' + server.port + '/';
	}

	public load(): Promise<void> {
		// Pull the matching socket.io client from the server itself, so client
		// and server library versions always agree.
		return simplify.loadScript(this.address + this.PATH);
	}

	public async open(hostname: string, port: number, type?: string): Promise<void> {
		this.socket = io(type + '://' + hostname + ':' + port + '/', {
			transports: ['websocket'],
		});

		// Round 16: the server echoes our `mpPing {t: Date.now()}` back; measure
		// the round-trip. Guarded (finite, >=0, <5s) so a skewed clock or a late
		// stale echo can't poison the display; an EMA (α≈0.3) keeps it from jitter.
		this.socket.on('mpPing', (data: any) => {
			if (!data || typeof data.t !== 'number') return;
			const rtt = Date.now() - data.t;
			if (!isFinite(rtt) || rtt < 0 || rtt > 5000) return;
			this.pingMs = this.pingMs < 0 ? Math.round(rtt) : Math.round(this.pingMs * 0.7 + rtt * 0.3);
		});

		this.socket.on('reconnect', async () => {
			if (this.username && this.setHost) {
				let result;
				try {
					result = await this.identify(this.username);
				} catch (e) {
					// Re-identify failed (server bounced mid-handshake, or rejected us
					// because our old session was still online). Without this we'd stay
					// in-game but offline on the server with no fallback — treat it as a
					// lost connection so the grace-then-title path runs.
					console.warn('[multiplayer] re-identify after reconnect failed', e);
					this.main.onConnectionLost();
					return;
				}
				if (result && result.success) {
					this.setHost(result.host);

					// Re-join our map instance even when there's no marker: a position
					// teleport (or any teleport whose marker didn't resolve) leaves
					// this.marker null, and skipping changeMap here stranded us in the
					// server's old instance (stale mirrors, wrong host). changeMap
					// accepts a null marker, so only require the map name.
					if (this.map) {
						// Re-derive the area from the map name (currentPlayerArea may
						// not be reliable during reconnect).
						const idx = this.map.indexOf('.');
						const areaPath = idx === -1 ? this.map : this.map.substring(0, idx);
						const area = (sc.map as any).areas[areaPath];
						const areaType = area && typeof area.areaType === 'number' ? area.areaType : 1;
						// Round 19: the server cleared a PVP-duel isolation override on
						// disconnect. If we were isolated (or a duel is still running),
						// re-assert isolated:true so the duel stays in its own solo
						// instance after the rejoin.
						const pvp: any = (sc as any).pvp;
						const duelStillOn = this.main.isolated === true || !!(pvp && pvp.isActive && pvp.isActive());
						this.changeMap(this.map, this.marker ?? null, areaPath, areaType, duelStillOn ? true : undefined);
					}
				}
			}
		});

		// Detect the server going away. socket.io auto-reconnects forever in the
		// background; we give it a short grace window (in case the server is just
		// restarting) and then drop the player back to the title screen instead of
		// leaving them stranded in a dead session.
		this.socket.on('disconnect', (reason: string) => {
			// Round 16: offline for any reason — stop pinging and drop the stale
			// RTT so the tag display reverts to the plain name. Restarts on the
			// reconnect path because identify() runs again (startPing).
			this.stopPing();
			// 'io server disconnect' = server told us to go away; others = transport lost.
			if (reason === 'io client disconnect') return; // we closed it ourselves
			this.main.onConnectionLost();
		});

		await new Promise<void>((resolve, reject) => {
			if (!this.socket) {
				return reject(new Error('[multiplayer] No socket created.'));
			}

			if (this.socket.connected) {
				return resolve();
			}

			this.socket.once('connect', () => {
				resolve();
			});

			// Surface the real reason (CORS, server down, bad port, ...) instead of
			// an empty rejection, so the console shows something actionable.
			this.socket.once('connect_error', (err: Error) => {
				reject(new Error('[multiplayer] Could not connect to ' + this.address + ' — ' + (err && err.message ? err.message : 'connection failed')));
			});
		});
	}

	public isReady(): boolean {
		return !!this.socket;
	}

	public isOpen(): boolean {
		if (!this.socket) {
			return false;
		}

		return this.socket.connected;
	}

	public identify(username: string): Promise<IIdentifyResult> {
		return new Promise<IIdentifyResult>((resolve, reject) => {
			this.socket.once('handshakeResponse', (data: {
                success: boolean,
                username: string,
                host: boolean,
                mapName: string | null,
                save?: { slot: string, data: string } | null,
                failed?: string,
                // Round 17: version-mismatch rejections carry the human-readable
                // reason in `message` (the older rejections use `failed`).
                message?: string,
                hpScale?: number,
            }) => {
				this.username = username;

				if (data.success) {
					resolve({success: data.success, host: data.host, mapName: data.mapName, save: data.save ?? null, hpScale: data.hpScale});
					// Round 16: start the 1/s latency probe once authenticated. This
					// also covers reconnects (identify runs again in the reconnect
					// handler; stopPing cleared the previous timer on disconnect).
					this.startPing();
				} else {
					// The server rejects with {failed: "..."} (older style) or
					// {message: "..."} (round-17 version mismatches) — no `success`.
					reject(new Error('[multiplayer] Login rejected: ' + (data.failed || data.message || 'unknown reason')));
				}
			});

			this.socket.emit('handshake', {
				username,
				// Round 17: send the MOD version (not the game version). The server
				// rejects the connection unless it matches its own version — on the
				// first connect AND every reconnect (both re-run this handshake).
				version: MP_VERSION,
				client: 'multiplayer',
			});
		});
	}

	// ---- Round 16: latency probe ----

	/** Starts the 1/s mpPing probe (idempotent). Each tick emits only while the
	 * socket is actually connected; the server echoes the payload back and the
	 * mpPing handler above folds it into pingMs. */
	private startPing(): void {
		if (this.pingTimer) return;
		this.pingTimer = setInterval(() => {
			if (!this.isOpen() || !this.socket) return;
			this.socket.emit('mpPing', { t: Date.now() });
			// Round 17: report our smoothed RTT to the server once per second (same
			// cadence as the probe). The server relays it to the instance as
			// `playerPing` so every player there can show our ping on their name tag.
			// Only when we have a valid sample (pingMs >= 0).
			if (this.pingMs >= 0) this.socket.emit('pingReport', { ms: this.pingMs });
		}, 1000);
	}

	/** Stops the probe and clears the last RTT sample (offline = unknown). */
	private stopPing(): void {
		if (this.pingTimer) {
			try { clearInterval(this.pingTimer); } catch (_) { /* ignore */ }
			this.pingTimer = null;
		}
		this.pingMs = -1;
	}
	// Serialize changeMap calls: each registers a socket.once('changeMapResponse')
	// listener, so two in flight at once would resolve BOTH promises with the FIRST
	// response (the second once-listener eats it). A leader's re-assert can overlap an
	// acceptor's regroup changeMap — chaining them guarantees 1 request : 1 response.
	private changeMapChain: Promise<any> = Promise.resolve();
	public changeMap(name: string, marker: string | null, areaPath: string, areaType: number, isolated?: boolean): Promise<IChangeMapResult> {
		const run = () => this.doChangeMap(name, marker, areaPath, areaType, isolated);
		const result = this.changeMapChain.then(run, run);
		// Keep the chain alive regardless of this call's own resolution.
		this.changeMapChain = result.catch(() => { /* swallow */ });
		return result;
	}
	private doChangeMap(name: string, marker: string | null, areaPath: string, areaType: number, isolated?: boolean): Promise<IChangeMapResult> {
		this.map = name;
		this.marker = marker;
		const pos = ig.game.playerEntity ? { x: ig.game.playerEntity.coll.pos.x, y: ig.game.playerEntity.coll.pos.y, z: ig.game.playerEntity.coll.pos.z } : { x: 0, y: 0, z: 0 };
		const payload: any = { name, marker, areaPath, areaType, pos };
		// Round 19: PVP-duel isolation — STICKY on the client. The server treats an
		// absent `isolated` as "unchanged", so an ordinary teleport/reassert while
		// main.isolated (a duel in progress) must re-send isolated:true to keep the
		// override; only the explicit exit path sends isolated:false. Present-true
		// and absent-without-isolation both map to the tri-state the server expects.
		if (isolated === true || (isolated === undefined && this.main.isolated)) {
			payload.isolated = true;
		} else if (isolated === false) {
			payload.isolated = false;
		}
		return new Promise<IChangeMapResult>((resolve) => {
			this.socket.once('changeMapResponse', (data: IChangeMapResult) => resolve(data));
			this.socket.emit('changeMap', payload);
		});
	}
	public updatePersition(position: Vec3): void {
		this.socket.emit('updatePosition', position);
	}
	public updateAnimation(face: Vec2, anim: string): void {
		this.socket.emit('updateAnimation', {face, anim});
	}
	public updateTimer(timer: number): void {
		// Must match the event the server relays ('updateAnimationTimer') — the old
		// 'updateTimer' name never reached anyone, so remote anim timers never synced.
		this.socket.emit('updateAnimationTimer', timer);
	}

	public spawnEntity(type: string, x: number, y: number, z: number, settings?: object, showEffects?: boolean): void {
		this.socket.emit('spawnEntity', {type, x, y, z, settings, showAppearEffects: showEffects});
	}
	public registerEntity(id: number, type: string, pos: Vec3, settings: object): void {
		this.socket.emit('registerEntity', {id, type, pos, settings});
	}
	public killEntity(id: number): void {
		this.socket.emit('killEntity', {id});
	}

	public throwBall(ballInfo: IBallInfo): void {
		this.socket.emit('throwBall', ballInfo);
	}

	public combatHit(hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number }): void {
		this.socket.emit('combatHit', hit);
	}

	public partyRegroup(target?: string): void {
		this.socket.emit('partyRegroup', target ? { target } : {});
	}

	// Round 11: host broadcasts the native party BOTS in the roster so member
	// clients can spawn their own follower copies.
	public partyBots(bots: string[]): void {
		this.socket.emit('partyBots', { bots });
	}
	public onPartyBots(callback: (bots: string[]) => void): void {
		this.socket.on('partyBots', (data: any) => callback((data && data.bots) || []));
	}

	// Round 13: the party leader streams live bot state (pos/anim/hp/level); members
	// apply it to their local puppet copies.
	public botState(state: { map: string, bots: IBotStateEntry[] }): void {
		this.socket.emit('botState', state);
	}
	public onBotState(callback: (data: { map?: string, from?: string, bots: IBotStateEntry[] }) => void): void {
		this.socket.on('botState', (data: any) => callback(data));
	}

	// Round 20: GHOST CHESTS — we tell the party which chests on the current map we
	// opened. Emitting is gated on being connected AND on party size > 1 (the
	// feature is party-only; a solo player has nothing to announce and the server
	// would ignore it anyway — this just avoids the pointless packets).
	public emitChestOpened(list: Array<{ map: string, id: number }>): void {
		if (!this.socket || !this.socket.connected) return;
		const partied = !!(this.main.partyMembers && this.main.partyMembers.length > 1);
		if (!partied) return;
		this.socket.emit('chestOpened', { list: (list || []).slice(0, 128) });
	}
	/** Round 20: a party teammate opened a chest (server-relayed chestOpenedBy). */
	public onChestOpenedBy(callback: (chestKey: string, by: string) => void): void {
		this.socket.on('chestOpenedBy', (data: any) => {
			if (data && typeof data.key === 'string' && typeof data.by === 'string') {
				callback(data.key, data.by);
			}
		});
	}
	/** Round 20: the party's opened-chest snapshot for a map we just joined. */
	public onChestState(callback: (opened: { [chestKey: string]: string[] }) => void): void {
		this.socket.on('chestState', (data: any) => {
			callback((data && data.opened) || {});
		});
	}

	// Round 11: special-skill effect replay (sheet path + effect key).
	public skillFx(fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }): void {
		this.socket.emit('skillFx', fx);
	}
	public onSkillFx(callback: (player: string, fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }) => void): void {
		this.socket.on('skillFx', (data: any) => {
			if (data) callback(data.player, data);
		});
	}

	public enemyDamage(hit: { uid: number, damage: number, attacker: string }): void {
		this.socket.emit('enemyDamage', hit);
	}

	// Round 17: HOST -> all — the host's real enemy started an attack; members replay
	// it on their puppet toward the local player (member puppets no longer run local AI).
	public enemyAttack(atk: { uid: number, anim: string }): void {
		this.socket.emit('enemyAttack', atk);
	}

	public updateEntityPosition(id: number, pos: Vec3): void {
		this.socket.emit('updateEntityPosition', {id, pos});
	}
	public updateEntityAnimation(id: number, face: Vec2, anim: string): void {
		this.socket.emit('updateEntityAnimation', {id, face, anim});
	}
	public updateEntityHealth(id: number | null, health: number, maxHp?: number): void {
		this.socket.emit('updateEntityHealth', {id, hp: health, maxHp});
	}
	public updatePlayerStats(stats: { hp?: number, maxHp?: number, sp?: number, maxSp?: number }): void {
		this.socket.emit('updatePlayerStats', stats);
	}
	// ---- NEW sync system ----
	public updatePlayerState(state: any): void {
		this.socket.emit('playerState', state);
	}
	public updateEntityStateBlock(map: string, entities: any[], combat?: boolean): void {
		this.socket.emit('entityState', { map, e: entities, cb: !!combat });
	}
	// Round 19: cutscene-spawned monster stream (see applyCutsceneEntity). The server
	// relays it to the instance stamped with the sender as `from` (protocol.js).
	public updateCutsceneEntityBlock(state: { map: string, list: any[] }): void {
		this.socket.emit('cutsceneEntity', state);
	}
	public onPlayerState(callback: (player: string, state: any) => void): void {
		this.socket.on('playerState', (data: any) => callback(data.player, data));
	}
	public onEntityState(callback: (map: string, entities: any[], combat: boolean) => void): void {
		this.socket.on('entityState', (data: any) => callback(data.map, data.e, !!data.cb));
	}
	public onCutsceneEntity(callback: (from: string, data: { map: string, list: any[] }) => void): void {
		this.socket.on('cutsceneEntity', (data: any) => {
			if (!data || typeof data.map !== 'string' || !Array.isArray(data.list)) return;
			callback(data.from, data);
		});
	}
	public updateEntityState(id: number, state: string): void {
		this.socket.emit('updateEntityState', {id, state});
	}
	public updateEntityTarget(id: number, target: string | number | null): void {
		this.socket.emit('updateEntityTarget', {id, target});
	}
	public updatePlayerProfile(profile: IPlayerProfile): void {
		this.socket.emit('updatePlayerProfile', profile);
	}

	public onSetHost(callback: (isHost: boolean, map?: string) => void): void {
		this.setHost = callback;
		this.socket.on('setHost', (data: { isHost: boolean, map?: string } | boolean) => {
			// Tolerate the legacy bare-boolean form.
			if (typeof data === 'boolean') {
				callback(data);
			} else {
				callback(data.isHost, data.map);
			}
		});
	}

	public onPlayerChangeMap(callback:
        (player: string, enters: boolean, position: Vec3, map: string, marker: string | null) => void): void {
		this.socket.on('onPlayerChangeMap', (data: any) => {
			callback(data.player, data.enters, data.position, data.map, data.marker);
		});
	}
	public onUpdatePostion(callback: (player: string, pos: Vec3) => void): void {
		this.socket.on('updatePosition', (data: any) => {
			callback(data.player, data.pos);
		});
	}
	public onUpdateAnimation(callback: (player: string, face: Vec2, anim: string) => void): void {
		this.socket.on('updateAnimation', (data: any) => {
			callback(data.player, data.face, data.anim);
		});
	}
	public onUpdateAnimationTimer(callback: (player: string, timer: number) => void): void {
		this.socket.on('updateAnimationTimer', (data: any) => {
			callback(data.player, data.timer);
		});
	}
	public onThrowBall(callback: (ballInfo: IBallInfo) => void): void {
		this.socket.on('throwBall', (data: IBallInfo) => {
			callback(data);
		});
	}
	public onCombatHit(callback: (hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number }) => void): void {
		this.socket.on('combatHit', (data: any) => {
			callback(data);
		});
	}
	public onEnemyDamage(callback: (hit: { uid: number, damage: number, attacker: string }) => void): void {
		this.socket.on('enemyDamage', (data: any) => {
			callback(data);
		});
	}
	public onEnemyAttack(callback: (uid: number, anim: string) => void): void {
		this.socket.on('enemyAttack', (data: any) => {
			if (data && typeof data.uid === 'number' && typeof data.anim === 'string') callback(data.uid, data.anim);
		});
	}
	public onRegisterEntity(callback: (id: number, type: string, pos: Vec3, settings: object) => void): void {
		this.socket.on('registerEntity', (data: any) => {
			callback(data.id, data.type, data.pos, data.settings);
		});
	}
	public onKillEntity(callback: (id: number) => void): void {
		this.socket.on('killEntity', (data: any) => {
			callback(data.id);
		});
	}
	public onUpdateEntityPosition(callback: (id: number, pos: Vec3) => void): void {
		this.socket.on('updateEntityPosition', (data: any) => {
			callback(data.id, data.pos);
		});
	}
	public onUpdateEntityAnimation(callback: (id: number, face: Vec2, anim: string) => void): void {
		this.socket.on('updateEntityAnimation', (data: any) => {
			callback(data.id, data.face, data.anim);
		});
	}
	public onUpdateEntityState(callback: (id: number, state: string) => void): void {
		this.socket.on('updateEntityState', (data: any) => {
			callback(data.id, data.state);
		});
	}
	public onUpdateEntityTarget(callback: (id: number, target: string | number | null) => void): void {
		this.socket.on('updateEntityTarget', (data: any) => {
			callback(data.id, data.target);
		});
	}
	public onUpdateEntityHealth(callback: (id: number | string, health: number, maxHp?: number) => void): void {
		this.socket.on('updateEntityHealth', (data: any) => {
			callback(data.id, data.hp, data.maxHp);
		});
	}
	public onPlayerProfile(callback: (player: string, profile: IPlayerProfile) => void): void {
		this.socket.on('updatePlayerProfile', (data: any) => {
			callback(data.player, data.profile);
		});
	}
	public onPlayerStats(callback: (player: string, stats: { hp?: number, maxHp?: number, sp?: number, maxSp?: number }) => void): void {
		this.socket.on('updatePlayerStats', (data: any) => {
			callback(data.player, data);
		});
	}
	// Round 17: a player in our instance reported its own RTT (server-relayed
	// `playerPing`); the multiplayer instance caches it for the name-tag display.
	// Round 20: the relay also carries `isHost` (true when the reporter is the
	// map-instance host) — pass it through for the " (Host)" tag label.
	public onPlayerPing(callback: (name: string, ping: number, isHost?: boolean) => void): void {
		this.socket.on('playerPing', (data: any) => {
			if (data && typeof data.name === 'string' && typeof data.ping === 'number') callback(data.name, data.ping, !!data.isHost);
		});
	}

	// ---- social (lobby architecture) ----
	public friendAdd(name: string): void {
		this.socket.emit('friendAdd', { name });
	}
	public friendAccept(name: string): void {
		this.socket.emit('friendAccept', { name });
	}
	public friendDecline(name: string): void {
		this.socket.emit('friendDecline', { name });
	}
	public friendRemove(name: string): void {
		this.socket.emit('friendRemove', { name });
	}
	public friendList(): void {
		this.socket.emit('friendList');
	}
	public friendRequests(): void {
		this.socket.emit('friendRequests');
	}
	public partyInvite(name: string): void {
		this.socket.emit('partyInvite', { to: name });
	}
	public partyAccept(partyId: string): void {
		this.socket.emit('partyAccept', { partyId });
	}
	public partyDecline(partyId: string): void {
		this.socket.emit('partyDecline', { partyId });
	}
	public partyLeave(): void {
		this.socket.emit('partyLeave');
	}
	public partyKick(target: string): void {
		this.socket.emit('partyKick', { target });
	}
	public saveUpload(slot: string, data: string): void {
		this.socket.emit('saveUpload', { slot, data });
	}
	public logout(): void {
		this.socket.emit('logout');
	}

	// ---- lobby queries (Social-menu "房间玩家" tab + online counter) ----
	public roomPlayers(): void {
		this.socket.emit('roomPlayers');
	}
	public onlineCount(): void {
		this.socket.emit('onlineCount');
	}

	public onPresence(callback: (player: string, online: boolean) => void): void {
		this.socket.on('presence', (data: any) => callback(data.player, data.online));
	}
	public onPartyUpdate(callback: (party: { partyId: string, leader: string, members: string[] } | null) => void): void {
		this.socket.on('partyUpdate', (data: any) => callback(data));
	}
	public onPartyInvite(callback: (from: string, partyId: string) => void): void {
		this.socket.on('partyInvite', (data: any) => callback(data.from, data.partyId));
	}
	public onPartyMove(callback: (data: { leader?: string, map?: string, pos?: Vec3 }) => void): void {
		this.socket.on('partyMove', (data: any) => callback(data));
	}
	public onPartyReSync(callback: () => void): void {
		this.socket.on('partyReSync', () => callback());
	}
	public onFriendList(callback: (friends: Array<{ name: string, online: boolean }>) => void): void {
		this.socket.on('friendList', (data: any) => callback(data.friends));
	}
	public onFriendActionResult(callback: (result: any) => void): void {
		this.socket.on('friendActionResult', (data: any) => callback(data));
	}
	public onFriendRequest(callback: (from: string) => void): void {
		this.socket.on('friendRequest', (data: any) => callback(data.from));
	}
	public onFriendRequests(callback: (requests: Array<{ name: string, online: boolean }>) => void): void {
		this.socket.on('friendRequests', (data: any) => callback(data.requests));
	}
	// ---- lobby query callbacks ----
	public onRoomPlayers(callback: (players: string[], host?: string) => void): void {
		this.socket.on('roomPlayers', (data: any) => callback(data.players, data.host));
	}
	public onOnlineCount(callback: (count: number) => void): void {
		this.socket.on('onlineCount', (data: any) => callback(data.count));
	}
}