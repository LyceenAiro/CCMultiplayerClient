import { Multiplayer } from '../../multiplayer';

export class OnMapLoadedListener {

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		// Run after each game tick via Simplify's update registry (the same
		// mechanism the entity/player listeners use), rather than overwriting
		// `ig.game.update` directly.
		simplify.registerUpdate(() => {
			this.afterUpdate();
		});
	}

	public afterUpdate(): void {
		// Flush pending enemy-mirror spawns ONLY once the map has fully finished
		// loading (loadingComplete -> not teleporting). Flushing earlier (bare
		// ig.ready) fires while map resources are still streaming in, so the
		// EnemyType.load() inside spawnMultiplayerEntity misses the resource batch
		// and the mirror spawns invisible/broken (looks like a "frozen" enemy).
		if (this.main.loadingMap || ig.game.isTeleporting()) return;
		while (this.main.futureEntities.length > 0) {
			this.main.spawnMultiplayerEntity(this.main.futureEntities[0]);
			this.main.futureEntities.shift();
		}
	}
}
