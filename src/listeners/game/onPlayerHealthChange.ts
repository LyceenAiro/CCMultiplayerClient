import { Multiplayer } from '../../multiplayer';
import { PlayerListener } from './playerListener';

export class OnPlayerHealthChangeListener {
	private lastHp = -1;
	private lastSp = -1;

	constructor(
        private main: Multiplayer,
	) { }

	public register(playerListener: PlayerListener): void {
		const instance = this;
		playerListener.addChild((player: ig.ENTITY.Player) => {
			instance.onUpdate(player);
		});
	}

	private onUpdate(player: ig.ENTITY.Player): void {
		if (!player || !player.params) {
			return;
		}
		const params: any = player.params;
		const hp = params.currentHp;
		const sp = params.currentSp;

		// Push whenever HP or SP changes (near-real-time). updatePlayerStats is
		// player-scoped (not host-gated) and feeds the in-game party HUD directly.
		if (hp !== this.lastHp || sp !== this.lastSp) {
			this.lastHp = hp;
			this.lastSp = sp;
			try {
				(this.main.connection as any).updatePlayerStats({
					hp,
					maxHp: params.getStat ? params.getStat('hp') : 0,
					sp,
					maxSp: params.maxSp,
				});
			} catch (e) { /* ignore */ }
		}
	}
}
