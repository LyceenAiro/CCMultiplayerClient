import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';

export class OnUpdateEntityHealthListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onUpdateEntityHealth(this.onUpdateEntityHealth.bind(this));
	}

	public onUpdateEntityHealth(id: number | string, health: number, maxHp?: number): void {
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

		entity.params.currentHp = health;

		// For a real remote PLAYER (string id), also push the value onto their
		// injected PartyMemberModel. The in-game party HP bar (HpHudBarGui) reads the
		// MODEL's params.currentHp/getStat('hp'), NOT the mirror entity's, so without
		// this the top-left party UI never updates when a teammate is hit or heals.
		if (typeof id === 'string') {
			const model: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[id];
			if (model && model.params) {
				model.params.currentHp = health;
				if (typeof maxHp === 'number' && maxHp > 0 && model.params.baseParams) {
					model.params.baseParams.hp = maxHp;
				}
			}
		}
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
