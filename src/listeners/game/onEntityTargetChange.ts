import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { EntityListener } from './entityListener';

export class OnEntityTargetChangeListener {

	// Dedup state is per-entity (keyed by multiplayerId). `undefined` = not yet
	// seen, `null` = seen with no target (distinct so we send the initial state).
	private last = new Map<number, ig.Entity | null>();

	constructor(
        private main: Multiplayer,
	) { }

	public register(entityListener: EntityListener): void {
		const instance = this;
		entityListener.addChild((entity: IMultiplayerEntity) => {
			instance.onUpdate(entity);
		});
	}

	public onEntityTargetChanged(entity: IMultiplayerEntity): void {
		const target = entity.target ? ((entity.target as IMultiplayerEntity).multiplayerId || 0) : null;

		this.main.connection.updateEntityTarget(entity.multiplayerId, target);
	}

	private onUpdate(entity: IMultiplayerEntity): void {
		const target: ig.Entity | null = entity.target;
		const last = this.last.get(entity.multiplayerId);
		if (last === undefined || target !== last) {
			this.onEntityTargetChanged(entity);
			this.last.set(entity.multiplayerId, target);
		}
	}
}