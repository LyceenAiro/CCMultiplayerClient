import { Multiplayer } from '../../multiplayer';
import { PlayerListener } from './playerListener';

export class OnPlayerAnimationListener {

	private lastAnim = '';
	private lastFace: Vec2 = {x: 0, y: 0};

	constructor(
        private main: Multiplayer,
	) { }

	public register(playerListener: PlayerListener): void {
		const instance = this;
		playerListener.addChild((player: ig.ENTITY.Player) => {
			instance.onUpdate(player);
		});
	}

	public onPlayerAnimation(player: ig.ENTITY.Player, animation: string, face: Vec2): void {
		this.main.connection.updateAnimation(face, animation);
	}

	private onUpdate(player: ig.ENTITY.Player): void {
		// `currentAnim` may be an animation-set object rather than a plain string
		// in 1.4.x; normalise it to the animation name before sending.
		const animation = this.animName(player.currentAnim);
		const face = player.face;

		if (animation !== this.lastAnim || !this.compareFace(face, this.lastFace)) {
			this.onPlayerAnimation(player, animation, face);
			this.lastAnim = animation;
			this.copyFace(face, this.lastFace);
		}
	}

	private animName(anim: unknown): string {
		return typeof anim === 'string' ? anim : '';
	}

	private compareFace(left: Vec2, right: Vec2): boolean {
		return left.x === right.x &&
            left.y === right.y;
	}

	private copyFace(from: Vec2, to: Vec2): void {
		to.x = from.x;
		to.y = from.y;
	}
}