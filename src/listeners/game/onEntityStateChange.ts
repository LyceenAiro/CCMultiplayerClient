import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { EntityListener } from './entityListener';

export class OnEntityStateChangeListener {

	// Dedup state is per-entity (keyed by multiplayerId).
	private last = new Map<number, string>();

	constructor(
        private main: Multiplayer,
	) { }

	public register(entityListener: EntityListener): void {
		const instance = this;
		entityListener.addChild((entity: IMultiplayerEntity) => {
			instance.onUpdate(entity);
		});
	}

	public onEntityStateChanged(entity: IMultiplayerEntity, state: string): void {
		this.main.connection.updateEntityState(entity.multiplayerId, state);
	}

	private onUpdate(entity: IMultiplayerEntity): void {
		const state = entity.currentState;
		const last = this.last.get(entity.multiplayerId);

		if (last === undefined || state !== last) {
			this.onEntityStateChanged(entity, state);
			this.last.set(entity.multiplayerId, state);
		}
	}
}