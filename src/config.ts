import { IConfigFile } from './configFile';
import { IConnection } from './connection';
import { SocketIoConnector } from './connectors/SocketIOConnector';
import { Multiplayer } from './multiplayer';
import { IServer } from './server';

/** localStorage key for the user-managed server list (see persistServers). */
const SERVERS_STORAGE_KEY = 'cc-mp-servers';

export class MultiplayerConfig {
	public servers: IServer[] = [];

	private readonly CONNECTORS: {[type: string]: any} = {
		http: SocketIoConnector,
		https: SocketIoConnector,
	};

	private readonly configPath: string;

	constructor(configPath = 'config/config.json') {
		// Simplify (bundled with CCLoader v2) resolves the mod's install
		// directory from its manifest name ('multiplayer').
		const mod = simplify.getMod('multiplayer');
		if (!mod) {
			throw new Error('[multiplayer] Could not find our own mod via simplify.getMod()');
		}
		const base = mod.baseDirectory.endsWith('/') ? mod.baseDirectory : mod.baseDirectory + '/';
		this.configPath = base + configPath;
	}

	public async load(): Promise<void> {
		const fileServers: IServer[] = await new Promise<IServer[]>((resolve, reject) => {
			simplify.resources.loadJSON(this.configPath, (data: IConfigFile) => {
				resolve((data && Array.isArray(data.servers)) ? data.servers : []);
			}, reject);
		});
		this.servers = fileServers;
		// A user-managed list (from the server-list screen) overrides the shipped
		// config.json; the file remains the seed for first launch (and the launcher
		// keeps its loopback entry in sync — see syncLoopbackPorts).
		this.loadServersFromStorage(fileServers);
	}

	// ---- server-list management (Minecraft-style 连接服务器 screen) ----

	/** Add a server and persist the list. */
	public addServer(server: IServer): void {
		this.servers.push(server);
		this.persistServers();
	}

	/** Remove a server by index and persist the list. */
	public removeServer(index: number): void {
		if (index >= 0 && index < this.servers.length) {
			this.servers.splice(index, 1);
			this.persistServers();
		}
	}

	/** Persist the current server list to localStorage (never throws). */
	public persistServers(): void {
		try {
			window.localStorage.setItem(SERVERS_STORAGE_KEY, JSON.stringify({ servers: this.servers }));
		} catch (_) { /* storage unavailable -> list lives in memory only */ }
	}

	/** Override config.json's servers with the user-managed localStorage list, if any.
	 * Defensive: a malformed entry is dropped so the server screen never breaks. After
	 * the override, loopback (localhost / 127.0.0.1) entries are re-pointed at the file's
	 * current port so the launcher's relay-port sync always wins (see syncLoopbackPorts). */
	private loadServersFromStorage(fileServers: IServer[]): void {
		try {
			const raw = window.localStorage.getItem(SERVERS_STORAGE_KEY);
			if (raw) {
				const parsed = JSON.parse(raw);
				if (parsed && Array.isArray(parsed.servers)) {
					this.servers = parsed.servers.filter((s: any) =>
						s && typeof s.hostname === 'string' && s.hostname.trim() &&
						isFinite(Number(s.port)) && Number(s.port) >= 1 && Number(s.port) <= 65535 &&
						typeof s.type === 'string' && s.type);
				}
			}
		} catch (_) { /* corrupt storage -> keep the config.json list */ }
		this.syncLoopbackPorts(fileServers);
	}

	/** tools/play-local.js (syncModConfig) rewrites config.json's localhost / 127.0.0.1
	 * entry to the live relay port on every launch. Re-apply that port to any matching
	 * stored entry so the in-game list always points at the relay just started — without
	 * resurrecting a loopback entry the user deleted (we only touch entries that exist). */
	private syncLoopbackPorts(fileServers: IServer[]): void {
		for (const f of fileServers) {
			if (!f || typeof f.hostname !== 'string') continue;
			const hn = f.hostname.toLowerCase();
			if (hn !== 'localhost' && hn !== '127.0.0.1') continue;
			const port = Number(f.port);
			if (!(port >= 1 && port <= 65535)) continue;
			for (const s of this.servers) {
				if (s && typeof s.hostname === 'string' && s.hostname.toLowerCase() === hn && s.type === f.type) {
					s.port = port;
				}
			}
		}
	}

	public getConnectionFor(main: Multiplayer, server: IServer): IConnection {
		for (const type in this.CONNECTORS) {
			if (type === server.type) {
				return new this.CONNECTORS[type](main, server);
			}
		}
		throw new Error('No connector found');
	}

	public getConnection(main: Multiplayer, index: number): IConnection {
		return this.getConnectionFor(main, this.servers[index]);
	}
}
