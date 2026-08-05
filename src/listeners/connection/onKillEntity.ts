import { Multiplayer } from '../../multiplayer';

export class OnKillEntityListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onKillEntity(this.onKillEntity.bind(this));
	}

	public onKillEntity(id: number): void {
		// Host-authoritative: the host's kills are driven by its own game logic,
		// not by a bounced-back killEntity from the relay.
		if (this.main.host || !this.main.entities[id]) {
			return;
		}

		this.main.entities[id].kill();
		delete this.main.entities[id];
	}
}