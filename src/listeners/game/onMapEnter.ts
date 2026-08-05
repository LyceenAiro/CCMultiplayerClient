import { Multiplayer } from '../../multiplayer';

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

		const pending = this.main.pendingChangeMap;
		this.main.pendingChangeMap = undefined;

		if (pending) {
			// We teleported here: await the server's changeMapResponse to learn if
			// we host the target instance. Enemies must be stripped *before* the
			// level finishes loading, so we defer the strip until the response
			// arrives and apply it to the same data object the game is loading.
			pending.then((result) => {
				this.main.host = result.isHost;
				if (!result.isHost) {
					this.stripEnemies(data);
				}
			}).catch(() => { /* keep enemies on error (safe fallback) */ });
			return;
		}

		// No teleport in flight (e.g. initial game start): we're our own host.
		if (!this.main.host) {
			this.stripEnemies(data);
		}
	}

	private stripEnemies(data: sc.MapModel.Map): void {
		const entities = data.entities;
		for (let i = 0; i < entities.length; i++) {
			const entity = entities[i];

			if (entity.type === 'Enemy') {
				this.loadEntity(entity.settings.enemyInfo.type);

				entities.splice(i, 1);
				i--;
			} else if (entities[i].type === 'EnemySpawner') {
				// Map-entity `settings` are loosely typed in 1.4.x; read the
				// spawner's enemy list loosely.
				const settings = entity.settings as any;
				if (settings.enemyTypes) {
					const types: any[] = settings.enemyTypes;
					for (const type of types) {
						this.loadEntity(type.info.type);
					}
				}
				entities.splice(i, 1);
				i--;
			}
		}
	}

	private loadEntity(name: string): void {
		new sc.EnemyType(name).load();
	}
}
