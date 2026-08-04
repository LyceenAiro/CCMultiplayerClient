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
		if (!this.main.loadingMap && ig.ready) {
			while (this.main.futureEntities.length > 0) {
				this.main.spawnMultiplayerEntity(this.main.futureEntities[0]);
				this.main.futureEntities.shift();
			}
		}
	}
}
