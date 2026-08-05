import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';

export class OnEntityKilledListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		const self = this;
		const originalKill = ig.Entity.prototype.kill;
		ig.Entity.prototype.kill = function(this: ig.Entity, ...args: any) {
			const converted = this as IMultiplayerEntity;
			if (converted.multiplayerId) {
				// Enemy sync is host-authoritative: only the host broadcasts a kill.
				// A client that receives a killEntity replays entity.kill() locally,
				// which re-enters this hook — it must drop the id but NOT re-broadcast.
				if (self.main.host) {
					self.onEntityKilled(converted.multiplayerId);
				}
				delete (converted as any).multiplayerId;
			}

			return originalKill.apply(this, args);
		};
	}

	public onEntityKilled(id: number): void {
		this.main.connection.killEntity(id);

		if (this.main.entities[id]) {
			delete this.main.entities[id];
		}
	}
}