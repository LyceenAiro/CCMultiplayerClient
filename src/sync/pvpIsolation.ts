import { IChangeMapResult } from '../connection';
import { OnSetHostListener } from '../listeners/connection/onSetHost';
import { wipeAllNameTags } from '../ui/mpOptions';
import type { Multiplayer } from '../multiplayer';

// Round 19: PVP-duel instance isolation (CLIENT side). Server support landed this
// round: `changeMap` accepts a tri-state `isolated` (true = pin routing to
// solo:<user>:<map> BEFORE shared-town/party rules; false = clear; absent = leave
// the override unchanged), and `disconnect` clears the override.
//
// Story PVP duels (Apollo x4, Shizuka) run IN-PLACE on the current map — no
// defeat-retry loop, so the player leaves the current instance for the duel's
// duration and re-joins it when the duel stops, win or lose. Arena cups
// (`sc.arena.active`) are intentional shared content and are EXCLUDED here.
//
// The leaver is never told which players it left (server asymmetry), so entering
// isolation locally despawns every remote mirror + name tag.

let _installed = false;

/** Register the sc.pvp observer ONCE (the guard flag makes repeated calls safe —
 * initializeListeners runs this on every connect). Observes PVP_STARTED/STOPPED
 * and routes the current map into/out of its solo instance. Any failure is
 * swallowed: isolation must never block or crash the duel itself. */
export function installPvpIsolation(main: Multiplayer): void {
	if (_installed) return;
	const pvp: any = (sc as any).pvp;
	const Model: any = (sc as any).Model;
	if (!pvp || !Model || typeof Model.addObserver !== 'function') {
		// sc.pvp exists from game init; if it somehow isn't ready yet, retry on
		// the next connect (installPvpIsolation is called each connect).
		return;
	}
	_installed = true;

	const PM = (sc as any).PVP_MESSAGE || { STARTED: 1, STOPPED: 2, ROUND_OVER: 3 };

	Model.addObserver(pvp, {
		modelChanged: (model: any, msg: number) => {
			try {
				// Guard every message: connected + in-game + not an arena cup.
				if (!main.connection || !main.connection.isOpen()) return;
				if (!ig.game || !ig.game.playerEntity) return;
				const arena: any = (sc as any).arena;
				if (arena && arena.active) return; // arena cups are shared on purpose
				if (msg === PM.STARTED) enterIsolation(main);
				else if (msg === PM.STOPPED) exitIsolation(main);
				// ROUND_OVER (3) needs no routing change.
			} catch (_) { /* an observer error must never break the duel itself */ }
		},
	} as any);
}

function enterIsolation(main: Multiplayer): void {
	if (main.isolated) return;
	main.isolated = true;
	const map = ig.game && ig.game.mapName;
	console.log('[multiplayer] PVP isolation entered on ' + (map || '(unknown map)'));
	fireIsolationReassert(main, true, (res) => {
		applyHostFlip(main, res);
		// The leaver is never told it left anyone; drop every remote mirror + tag
		// locally (the other combatant is now in their own solo instance).
		despawnRemoteMirrors(main);
	}, () => {
		// 3s watchdog: even if the reassert response is lost, we ARE isolated now,
		// so the stale mirrors from the shared instance are safe to drop.
		despawnRemoteMirrors(main);
	});
}

function exitIsolation(main: Multiplayer): void {
	if (!main.isolated) return;
	main.isolated = false;
	const map = ig.game && ig.game.mapName;
	console.log('[multiplayer] PVP isolation exited on ' + (map || '(unknown map)'));
	// The server recomputes on the false-flag reassert: back into
	// party:<id>:<map> / town:<map> if the party/town is still on this map, else
	// the player hosts an empty instance (functionally solo). Mirrors respawn via
	// the normal enters:true broadcasts — no local wipe on exit.
	fireIsolationReassert(main, false, (res) => {
		applyHostFlip(main, res);
	}, undefined);
}

/** Re-assert the CURRENT map with the given explicit isolated flag, mirroring
 * reassertCurrentInstance's payload (current marker null, same areaPath/areaType).
 * Retried when mid-teleport (reassertWhenReady idiom), bounded by onTeleport's 3s
 * race, and fire-and-forget: any failure must never block the duel itself. */
function fireIsolationReassert(main: Multiplayer, isolated: boolean,
	onSettled: (res: IChangeMapResult) => void, onWatchdog?: () => void, attempt = 0): void {
	try {
		if (!main.connection || !main.connection.isOpen()) return;
		const map = ig.game && ig.game.mapName;
		if (!map || ig.game.isTeleporting()) {
			// Mid-teleport: the in-flight teleport's changeMap already carries
			// isolated:true (the connector's sticky flag), so the next map is
			// covered. Retry the explicit reassert once the game is idle.
			if (attempt < 10) setTimeout(() => fireIsolationReassert(main, isolated, onSettled, onWatchdog, attempt + 1), 1000);
			return;
		}
		const req = main.connection.changeMap(map, null, main.getAreaPath(), main.getAreaType(), isolated);
		if (!req || typeof (req as any).then !== 'function') return;
		let done = false;
		const finish = (res?: IChangeMapResult) => {
			if (done) return;
			done = true;
			try { res ? onSettled(res) : onWatchdog && onWatchdog(); } catch (_) { /* ignore */ }
		};
		(req as Promise<IChangeMapResult>).then(finish).catch(() => finish());
		// onTeleport's 3s-race idiom: a hung changeMapResponse must not leave the
		// isolation bookkeeping (host flip / mirror wipe) pending forever.
		setTimeout(() => finish(undefined), 3000);
	} catch (e) { /* never crash the duel */ }
}

/** Apply a host flip from the reassert response using EXACTLY the pipeline
 * OnSetHostListener.onSetHost uses (promotion -> unlockEntities + netSync.
 * promoteToHost; demotion -> lockEntities). The changeMapResponse carries the
 * authoritative isHost; the server does NOT emit setHost for the joiner. */
function applyHostFlip(main: Multiplayer, res: IChangeMapResult): void {
	try {
		if (!res || typeof res.isHost !== 'boolean' || res.isHost === main.host) return;
		new OnSetHostListener(main).onSetHost(res.isHost, ig.game && ig.game.mapName);
	} catch (_) { /* never break the duel */ }
}

/** Despawn every remote mirror + name tag locally (the leaver is never told it
 * left anyone; the server-side instance is solo for the duel's duration). */
function despawnRemoteMirrors(main: Multiplayer): void {
	try { main.reconcilePlayerMirrorsAfterMapChange(new Set()); } catch (_) { /* ignore */ }
	try { wipeAllNameTags(); } catch (_) { /* ignore */ }
}
