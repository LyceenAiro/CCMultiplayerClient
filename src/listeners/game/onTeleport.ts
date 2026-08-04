import { Multiplayer } from '../../multiplayer';

export class OnTeleportListener {

	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		const instance = this;
		// `ig.game` is the concrete `sc.CrossCode` instance at runtime; the
		// static type of the global is the broader `ig.Game`, so we bind through
		// a cast when wrapping `teleport`.
		const game = ig.game as sc.CrossCode;
		const original = game.teleport;
		game.teleport = function(this: sc.CrossCode, map: string, teleportPosition: any, hint?: any) {
			instance.onTeleport(map, teleportPosition);
			return original.call(this, map, teleportPosition, hint);
		} as typeof game.teleport;
	}

	public onTeleport(map: string, teleportPosition: any): void {
		this.main.loadingMap = true;

		for (const key in teleportPosition) {
			const value = teleportPosition[key];
			if (value && typeof value === 'string') {
				this.main.connection.changeMap(map, value);
				return;
			}
		}
		this.main.connection.changeMap(map, null);
	}
}
