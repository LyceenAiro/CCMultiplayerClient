import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { EntityListener } from './entityListener';

export class OnEntityMoveListener {

	// Dedup state is per-entity (keyed by multiplayerId), not a single shared
	// value — with multiple enemies a shared `last` flips every tick.
	private last = new Map<number, Vec3>();

	constructor(
        private main: Multiplayer,
	) { }

	public register(entityListener: EntityListener): void {
		const instance = this;
		entityListener.addChild((entity: IMultiplayerEntity) => {
			instance.onUpdate(entity);
		});
	}

	public onEntityMoved(entity: IMultiplayerEntity, position: Vec3): void {
		this.main.connection.updateEntityPosition(entity.multiplayerId, position);
	}

	private onUpdate(entity: IMultiplayerEntity): void {
		const pos: Vec3 = entity.coll.pos;
		const last = this.last.get(entity.multiplayerId);

		if (!last || !this.comparePosition(pos, last)) {
			this.onEntityMoved(entity, pos);
			this.last.set(entity.multiplayerId, {x: pos.x, y: pos.y, z: pos.z});
		}
	}

	private comparePosition(left: Vec3, right: Vec3): boolean {
		return left.x === right.x &&
            left.y === right.y &&
            left.z === right.z;
	}
}