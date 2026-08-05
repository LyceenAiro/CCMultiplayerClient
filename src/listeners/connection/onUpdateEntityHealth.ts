import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';

export class OnUpdateEntityHealthListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onUpdateEntityHealth(this.onUpdateEntityHealth.bind(this));
	}

	public onUpdateEntityHealth(id: number | string, health: number): void {
		// Entity health (numeric id) is host-authoritative: the host drives it
		// locally and must not apply bounced-back values. Player health (string
		// username) is reported by each client about itself, so no host gate.
		if (typeof id === 'number' && this.main.host) {
			return;
		}

		const entity = this.getEntity(id);

		if (!entity) {
			return;
		}

		console.log('[multiplayer] Set ' + id + '\'s health to ' + health);

		entity.params.currentHp = health;
	}

	private getEntity(id: number | string): IMultiplayerEntity | null {
		if (typeof id === 'number') {
			return this.main.entities[id];
		}

		const player = this.main.players[id];
		if (player) {
			return player.entity;
		}

		return null;
	}
}