import { Multiplayer } from './multiplayer';

/**
 * CCLoader v2 entry point.
 *
 * The mod is a classic (non-module) script listed as the manifest's `main`
 * stage, which CCLoader v2 executes once the game has started — the same point
 * at which the global `modsLoaded` DOM event fires. We wait for that event so
 * that `simplify` (and every other mod) has finished initialising before we
 * touch the game.
 */
async function startMultiplayer(): Promise<void> {
	try {
		await waitForMods();

		const multiplayer = new Multiplayer();

		console.log('[multiplayer] Loading..');

		await multiplayer.load();

		console.log('[multiplayer] Loaded');

		multiplayer.initialize();

		console.log('[multiplayer] Initialized');
	} catch (e) {
		console.error(e);
	}
}

async function waitForMods(): Promise<void> {
	await new Promise<void>((resolve) => {
		document.body.addEventListener('modsLoaded', () => {
			resolve();
		});
	});
}

startMultiplayer()
	.catch(console.error.bind(console));
