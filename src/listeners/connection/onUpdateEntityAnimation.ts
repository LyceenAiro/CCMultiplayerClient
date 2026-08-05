import { Multiplayer } from '../../multiplayer';

export class OnUpdateEntityAnimationListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onUpdateEntityAnimation(this.onUpdateEntityAnimation.bind(this));
	}

	public onUpdateEntityAnimation(id: number, face: Vec2, anim: string): void {
		if (this.main.host || !this.main.entities[id]) {
			return;
		}

		this.main.setEntityAnimationProtected(this.main.entities[id], face, anim);
	}
}