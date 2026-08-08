import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';

export class EntityListener {
	private children: Array<(entity: IMultiplayerEntity) => any> = [];

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		simplify.registerUpdate(() => {
			this.onUpdate(); // Added a lambda to avoid context weirdness
		});
	}

	public addChild(child: (entity: IMultiplayerEntity) => any) {
		this.children.push(child);
	}

	public onUpdate(): void {
		// Enemy sync is host-authoritative: only the host reports enemy state.
		// Without this gate, a client's enemy *mirrors* (which also carry a
		// multiplayerId) would be reported back, creating a feedback loop.
		if (!this.main.host) {
			return;
		}

		const __t0 = Date.now();
		const entities = ig.game.entities;
		for (let i = 0; i < entities.length; i++) {
			const entity = ig.game.entities[i];
			if (!(entity as IMultiplayerEntity).multiplayerId || !(entity instanceof (ig.ENTITY.Enemy as any))) {
				continue;
			}

			const mEntity = entity as IMultiplayerEntity;
			for (const child of this.children) {
				// Guard each child: some map entities (e.g. prologue cargo-ship
				// dummies) have null combat params or other incomplete state, and
				// one bad entity must not crash the whole update loop.
				try {
					child(mEntity);
				} catch (e) {
					console.warn('[multiplayer] entity listener child failed for id ' + mEntity.multiplayerId, e);
				}
			}
		}
		// Diagnose combat stutter: if the per-frame enemy-sync work ever takes >4ms
		// it can drop a frame. Log so we can see if THIS is the source of the hitch.
		const __dt = Date.now() - __t0;
		if (__dt > 4) console.warn('[multiplayer] EntityListener.onUpdate took ' + __dt + 'ms over ' + entities.length + ' entities');
	}
}