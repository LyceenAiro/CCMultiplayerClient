import { IConfigFile } from './configFile';
import { IConnection } from './connection';
import { SocketIoConnector } from './connectors/SocketIOConnector';
import { Multiplayer } from './multiplayer';
import { IServer } from './server';

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
		await new Promise<void>((resolve, reject) => {
			simplify.resources.loadJSON(this.configPath, (data: IConfigFile) => {
				this.servers = data.servers;
				resolve();
			}, reject);
		});
	}

	public getConnection(main: Multiplayer, index: number): IConnection {
		const server = this.servers[index];
		for (const type in this.CONNECTORS) {
			if (type === server.type) {
				return new this.CONNECTORS[type](main, server);
			}
		}
		throw new Error('No connector found');
	}
}
