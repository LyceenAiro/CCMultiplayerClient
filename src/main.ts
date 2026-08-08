import { Multiplayer } from './multiplayer';
import { installSocialMenuButton } from './ui/socialMenuInject';
import { installQuickMenuEnhancements } from './ui/quickMenuInject';
import { installMpOptionsTab, startNameTagLoop } from './ui/mpOptions';

/**
 * CCLoader v2 entry point.
 *
 * The mod is a classic (non-module) script listed as the manifest's `main`
 * stage. CCLoader v2 runs `main` scripts near the end of game startup, at which
 * point Simplify (a dependency, guaranteed to load first) has already
 * initialised and set the global `simplify` object — so we can start right
 * away.
 *
 * NOTE: an earlier version of this file waited for the global `modsLoaded` DOM
 * event. That deadlocks under CCLoader v2, because the loader only fires
 * `modsLoaded` *after* every mod's `main` stage has finished — so a `main`
 * script that awaits it waits forever. We therefore run immediately and just
 * guard on `simplify` being present.
 */
async function startMultiplayer(): Promise<void> {
	try {
		if (typeof simplify === 'undefined') {
			throw new Error('[multiplayer] Simplify is not available. Is the Simplify mod installed and enabled?');
		}

		let multiplayer: Multiplayer | undefined;

		// Install the Social-menu "Add Friend" button on the prototype now (the
		// menu instance is created lazily on first open). getMain defers reading
		// the instance until a click actually happens.
		installSocialMenuButton(() => multiplayer);

		// Round 11: quick-menu (SHIFT) inspect enhancements — same lazy pattern.
		installQuickMenuEnhancements(() => multiplayer);

		// Round 12: mod-dedicated options tab (+ persistent player name tags).
		installMpOptionsTab(() => multiplayer);

		multiplayer = new Multiplayer();

		console.log('[multiplayer] Loading..');

		await multiplayer.load();

		console.log('[multiplayer] Loaded');

		multiplayer.initialize();

		console.log('[multiplayer] Initialized');

		// Per-frame name-tag pump (idempotent, reads the instance lazily).
		startNameTagLoop(() => multiplayer);
	} catch (e) {
		console.error(e);
	}
}

startMultiplayer()
	.catch(console.error.bind(console));
