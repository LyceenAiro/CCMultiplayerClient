import { IBallInfo } from '../ballInfo';
import { IConnection, IChangeMapResult, IPlayerProfile } from '../connection';
import { Multiplayer } from '../multiplayer';
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

		this.socket.on('reconnect', async () => {
			if (this.username && this.setHost) {
				const result = await this.identify(this.username);
				if (result.success) {
					this.setHost(result.host);

					if (this.map && this.marker) {
						// Re-derive the area from the map name (currentPlayerArea may
						// not be reliable during reconnect).
						const idx = this.map.indexOf('.');
						const areaPath = idx === -1 ? this.map : this.map.substring(0, idx);
						const area = (sc.map as any).areas[areaPath];
						const areaType = area && typeof area.areaType === 'number' ? area.areaType : 1;
						this.changeMap(this.map, this.marker, areaPath, areaType);
					}
				}
			}
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
            }) => {
				this.username = username;

				if (data.success) {
					resolve({success: data.success, host: data.host, mapName: data.mapName, save: data.save ?? null});
				} else {
					// The server rejects with {failed: "..."} — no `success` field.
					reject(new Error('[multiplayer] Login rejected: ' + (data.failed || 'unknown reason')));
				}
			});

			this.socket.emit('handshake', {
				username,
				version: sc.version.toString(),
				client: 'multiplayer',
			});
		});
	}
	public changeMap(name: string, marker: string | null, areaPath: string, areaType: number): Promise<IChangeMapResult> {
		this.map = name;
		this.marker = marker;
		const pos = ig.game.playerEntity ? { x: ig.game.playerEntity.coll.pos.x, y: ig.game.playerEntity.coll.pos.y, z: ig.game.playerEntity.coll.pos.z } : { x: 0, y: 0, z: 0 };
		return new Promise<IChangeMapResult>((resolve) => {
			this.socket.once('changeMapResponse', (data: IChangeMapResult) => resolve(data));
			this.socket.emit('changeMap', {name, marker, areaPath, areaType, pos});
		});
	}
	public updatePersition(position: Vec3): void {
		this.socket.emit('updatePosition', position);
	}
	public updateAnimation(face: Vec2, anim: string): void {
		this.socket.emit('updateAnimation', {face, anim});
	}
	public updateTimer(timer: number): void {
		this.socket.emit('updateTimer', timer);
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

	public updateEntityPosition(id: number, pos: Vec3): void {
		this.socket.emit('updateEntityPosition', {id, pos});
	}
	public updateEntityAnimation(id: number, face: Vec2, anim: string): void {
		this.socket.emit('updateEntityAnimation', {id, face, anim});
	}
	public updateEntityHealth(id: number | null, health: number): void {
		this.socket.emit('updateEntityHealth', {id, hp: health});
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
	public onUpdateEntityHealth(callback: (id: number | string, health: number) => void): void {
		this.socket.on('updateEntityHealth', (data: any) => {
			callback(data.id, data.hp);
		});
	}
	public onPlayerProfile(callback: (player: string, profile: IPlayerProfile) => void): void {
		this.socket.on('updatePlayerProfile', (data: any) => {
			callback(data.player, data.profile);
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
	public onRoomPlayers(callback: (players: string[]) => void): void {
		this.socket.on('roomPlayers', (data: any) => callback(data.players));
	}
	public onOnlineCount(callback: (count: number) => void): void {
		this.socket.on('onlineCount', (data: any) => callback(data.count));
	}
}