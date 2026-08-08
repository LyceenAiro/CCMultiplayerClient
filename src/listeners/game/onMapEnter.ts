import { Multiplayer } from '../../multiplayer';

export class OnMapEnterListener {
	constructor(
        private main: Multiplayer,
	) { }

	public register(): void {
		const game = ig.game as sc.CrossCode;
		const originalLoad = game.loadLevel;
		game.loadLevel = ((data: sc.MapModel.Map, clearCache?: boolean, reloadCache?: boolean) => {
			this.onMapEnter(data);
			const result = originalLoad.call(game, data, clearCache, reloadCache);
			this.main.loadingMap = false;
			return result;
		}) as typeof game.loadLevel;
	}

	public onMapEnter(data: sc.MapModel.Map): void {
		this.loadEntity('multiplayer');

		const pending = this.main.pendingChangeMap;
		this.main.pendingChangeMap = undefined;

		// onTeleport now AWAITS changeMapResponse before running the real teleport,
		// so main.host is already the target instance's verdict when loadLevel runs.
		// Members strip their local Enemy/EnemySpawner entities: a member whose save
		// never unlocked the area would otherwise synchronously spawn quest-gated
		// enemies whose EnemyType onload throws inside the map Loader, leaving
		// ig.loading stuck true = infinite black loading (the "never visited this
		// block" wedge). Member-side enemies instead arrive from the host's block as
		// typed puppets, whose types load OUTSIDE the map Loader (async, guarded) —
		// a failed type there skips one puppet, never wedges the game.
		// ONLY strip when actually connected + logged in: at boot / offline the
		// host flag is still its default (false) and stripping would empty a solo
		// world of its enemies.
		const connected = !!(this.main.connection && this.main.connection.isOpen
			&& this.main.connection.isOpen());
		// mpForceStripNextLoad: a party regroup into a never-visited area is allowed
		// (round 6); if we end up HOST of that instance (leader left meanwhile) the
		// quest-gated spawns are local and can wedge the loader — strip for this one
		// load even as host. Consumed on every load so it never leaks.
		const forceStrip = this.main.consumeForceStrip();
		if (connected && this.main.name && (!this.main.host || forceStrip)) this.stripMemberEnemies(data);

		// Direct loadLevel calls (initial game start, no teleport in flight) carry
		// no pending response; the host flag from the session is used as-is. If a
		// response is still outstanding (legacy path), re-apply it afterwards.
		if (pending) {
			pending.then((result) => {
				this.main.host = result.isHost;
				// Round 20: remember the NEW instance's host username for the " (Host)"
				// name-tag label (optional field — guarded against older servers).
				if (typeof result.host === 'string') this.main.instanceHost = result.host;
				// Round 15: capture the NEW instance's roster (changeMapResponse members)
				// so the load-complete reconcile can drop stale old-map player entries
				// that clearMap() killed but nothing else removed.
				this.main.newInstanceMembers = (result.members || []).map((mm: any) => mm.name);
			}).catch(() => { /* keep current flag */ });
		}
	}

	/** MEMBER-side: remove Enemy + EnemySpawner entities from the level data BEFORE
	 * loadLevel spawns them. Player mirrors are spawned at runtime (never part of
	 * data.entities), so they are unaffected. */
	private stripMemberEnemies(data: sc.MapModel.Map): void {
		try {
			const anyData = data as any;
			if (!anyData || !Array.isArray(anyData.entities)) return;
			const before = anyData.entities.length;
			anyData.entities = anyData.entities.filter((e: any) =>
				e && e.type !== 'Enemy' && e.type !== 'EnemySpawner');
			console.log('[multiplayer] member: stripped ' + (before - anyData.entities.length)
				+ ' local enemies/spawners from the level (host block drives puppets)');
		} catch (e) { /* never block a map load */ }
	}

	private loadEntity(name: string): void {
		new sc.EnemyType(name).load();
	}
}
