import { Multiplayer } from '../../multiplayer';

export class PlayerListener {
	private children: Array<(player: ig.ENTITY.Player) => any> = [];

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		simplify.registerUpdate(() => {
			this.onUpdate(); // Added a lambda to avoid context weirdness
		});
	}

	public addChild(child: (player: ig.ENTITY.Player) => any) {
		this.children.push(child);
	}

	public onUpdate(): void {
		const player = ig.game.playerEntity;

		if (player && !this.main.loadingMap) {
			const __t0 = Date.now();
			for (const child of this.children) {
				child(player);
			}
			const __dt = Date.now() - __t0;
			if (__dt > 4) console.warn('[multiplayer] PlayerListener.onUpdate took ' + __dt + 'ms');
		}
	}
}