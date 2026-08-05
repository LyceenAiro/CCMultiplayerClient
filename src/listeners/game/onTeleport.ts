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

		let marker: string | null = null;
		for (const key in teleportPosition) {
			const value = teleportPosition[key];
			if (value && typeof value === 'string') {
				marker = value;
				break;
			}
		}

		// Fire the changeMap request and stash the response promise. onMapEnter
		// (loadLevel) awaits it to learn whether we're the host of the target
		// instance — which decides whether enemies are stripped from the level.
		// Derive the area from the TARGET map name: at teleport time
		// sc.map.currentPlayerArea still points at the map we're leaving, so
		// reading it would mis-classify towns and split matchmaking instances.
		const areaPath = this.main.getAreaPathOfMap(map);
		const areaType = this.main.getAreaTypeOfMap(map);
		this.main.pendingChangeMap = this.main.connection.changeMap(map, marker, areaPath, areaType);
	}
}
