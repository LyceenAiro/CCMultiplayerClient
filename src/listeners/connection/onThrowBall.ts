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
			console.warn('[multiplayer] onThrowBall: combatant is null, dropping ball', ballInfo.ballInfo);
			return;
		}

		const entity = this.resolveEntity(ballInfo.combatant);
		if (!entity) {
			console.warn('[multiplayer] onThrowBall: could not resolve entity for combatant "' +
				ballInfo.combatant + '" (mirror not spawned yet?), dropping ball', ballInfo.ballInfo);
			return;
		}

		// The mirror's `proxies` was captured at spawn time; element switches make
		// 1.4.2 reassign playerEntity.proxies to a NEW object, leaving the mirror
		// with a stale reference and SHOOT_PROXY unable to resolve the proxy name.
		// Refresh it so the proxy lookup succeeds.
		(entity as any).proxies = ig.game.playerEntity.proxies;

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