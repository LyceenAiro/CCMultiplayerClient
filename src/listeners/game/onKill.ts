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
				// With the new block sync, host kills are conveyed by the enemy simply
				// being ABSENT from the host's next state block (members kill it then) —
				// there is no killEntity round-trip to suppress. Only the legacy per-id
				// path broadcasts here.
				if (self.main.host && !(self.main as any).useNetSync) {
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