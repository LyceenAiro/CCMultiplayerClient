import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { EntityListener } from './entityListener';

export class OnEntityHealthChangeListener {

	// Dedup state is per-entity (keyed by multiplayerId).
	private last = new Map<number, number>();

	constructor(
        private main: Multiplayer,
	) { }

	public register(entityListener: EntityListener): void {
		const instance = this;
		entityListener.addChild((entity: IMultiplayerEntity) => {
			instance.onUpdate(entity);
		});
	}

	public onEntityHealthChanged(entity: IMultiplayerEntity, health: number): void {
		this.main.connection.updateEntityHealth(entity.multiplayerId, health);
	}

	private onUpdate(entity: IMultiplayerEntity): void {
		// Some entities (and mirror entities mid-setup) have no combat params yet;
		// skip them instead of dereferencing a null `params`.
		if (!entity.params) {
			return;
		}
		// `currentHp` is the live health value; `getStat('hp')` returns the stat
		// *cap* (which never changes), so it would never trigger a send.
		const health = entity.params.currentHp;
		const last = this.last.get(entity.multiplayerId);

		if (last === undefined || health !== last) {
			this.onEntityHealthChanged(entity, health);
			this.last.set(entity.multiplayerId, health);
		}
	}
}