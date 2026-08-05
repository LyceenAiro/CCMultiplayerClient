import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';
import { EntityListener } from './entityListener';

export class OnEntityAnimationListener {

	// Dedup state is per-entity (keyed by multiplayerId).
	private lastAnim = new Map<number, string>();
	private lastFace = new Map<number, Vec2>();

	constructor(
        private main: Multiplayer,
	) { }

	public register(entityListener: EntityListener): void {
		const instance = this;
		entityListener.addChild((entity: IMultiplayerEntity) => {
			instance.onUpdate(entity);
		});
	}

	public onEntityAnimation(entity: IMultiplayerEntity, animation: string, face: Vec2): void {
		this.main.connection.updateEntityAnimation(entity.multiplayerId, face, animation);
	}

	private onUpdate(entity: IMultiplayerEntity): void {
		const id = entity.multiplayerId;
		// `currentAnim` may be an animation-set object rather than a plain string
		// in 1.4.x; normalise it to the animation name before sending.
		const animation = this.animName(entity.currentAnim);
		// Animation-set form carries no recoverable name — skip rather than send ''.
		if (animation === null) {
			return;
		}
		const face = entity.face;
		const lastAnim = this.lastAnim.get(id);
		const lastFace = this.lastFace.get(id);

		if (lastAnim === undefined || !lastFace || animation !== lastAnim || !this.compareFace(face, lastFace)) {
			this.onEntityAnimation(entity, animation, face);
			this.lastAnim.set(id, animation);
			this.lastFace.set(id, {x: face.x, y: face.y});
		}
	}

	// Returns the animation name, or null when it cannot be determined (1.4.x
	// sometimes stores an AnimationSet object here instead of a string).
	private animName(anim: unknown): string | null {
		return typeof anim === 'string' ? anim : null;
	}

	private compareFace(left: Vec2, right: Vec2): boolean {
		return left.x === right.x &&
            left.y === right.y;
	}
}