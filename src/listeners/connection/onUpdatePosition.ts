import { Multiplayer } from '../../multiplayer';

export class OnUpdatePositionListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onUpdatePostion(this.onUpdatePostion.bind(this));
	}

	public onUpdatePostion(player: string, position: Vec3): void {
		const pl = this.main.players[player];
		if (pl && pl.entity) {
			// The mirror entity is locked (see lockEntity): write through the
			// protected backing fields so 1.4.2 physics doesn't revert the move.
			this.main.copyEntityPosition(position, pl.entity.coll.pos);
			pl.position = position;
		}
	}
}