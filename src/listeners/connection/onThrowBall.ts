import { IBallInfo } from '../../ballInfo';
import { Multiplayer } from '../../multiplayer';

export class OnThrownBallListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		this.main.connection.onThrowBall(this.onThrowBall.bind(this));
	}

	public onThrowBall(ballInfo: IBallInfo): void {
		if (ballInfo.combatant === null) {
			return;
		}

		const entity = this.resolveEntity(ballInfo.combatant);
		if (!entity) {
			return;
		}

		// `SHOOT_PROXY` settings are an internal shape that has shifted between
		// game versions; the values we pass are part of our own wire protocol, so
		// we cast rather than track the game's exact constructor types.
		const actonStep = new ig.ACTION_STEP.SHOOT_PROXY({ proxy: ballInfo.ballInfo, dir: ballInfo.dir } as any);
		actonStep.run(entity as sc.BasicCombatant);
	}

	private resolveEntity(combatant: number | string | undefined): ig.Entity | undefined {
		if (combatant === undefined) {
			return ig.game.playerEntity;
		}

		if (typeof combatant === 'string') {
			const player = this.main.players[combatant];
			if (!player) {
				return;
			}

			return player.entity;
		}

		if (typeof combatant === 'number') {
			return this.main.entities[combatant];
		}

		throw new Error('Malformed data in ballInfo.combatant received!');
	}
}