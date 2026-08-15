import { Multiplayer, MP_VERSION } from './multiplayer';
import { installSocialMenuButton } from './ui/socialMenuInject';
import { installQuickMenuEnhancements } from './ui/quickMenuInject';
import { installMpOptionsTab, startNameTagLoop, startNetHudLoop } from './ui/mpOptions';
import { installSaveButtons } from './ui/saveButtons';
import { installNetBadge } from './ui/netBadge';
import { installChatBox } from './ui/chatBox';
import { installVersionDisplay } from './ui/versionDisplay';

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
		// ROUND 71 (native diagnostics boot marker): the 1.64 file-logging build
		// produced NO log files from a live native session, so instrument the very
		// first mod frame: one boot file per process proving WHICH version actually
		// loaded in the native client AND whether NW.js node fs is reachable from
		// mod scope at all (the hitnum file logger depends on it). Browser mode has
		// no window.require -> the marker simply doesn't appear, which is also data.
		try {
			const w: any = window as any;
			if (w && w.require) {
				const fsAny: any = w.require('fs');
				const pid: any = (w.process && w.process.pid) || Math.floor(Math.random() * 1e9);
				fsAny.writeFileSync('D:\\Dev_cc\\mp-boot-' + pid + '.txt',
					'version=' + MP_VERSION + ' time=' + new Date().toISOString() + '\n');
			}
		} catch (bootErr) {
			try {
				const w: any = window as any;
				if (w && w.require) {
					w.require('fs').writeFileSync('D:\\Dev_cc\\mp-boot-err.txt', String(bootErr));
				}
			} catch (_) { /* ignore */ }
		}

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

		// Round 23: direct save+upload from the bag-menu / ESC-menu save buttons while
		// connected (vanilla save menu when not connected). Same lazy getMain pattern.
		installSaveButtons(() => multiplayer);

		// Round 23 wave 4: party chat — Enter opens the bottom input; messages render
		// as NPC-style dialogue boxes bottom-left. Same lazy getMain pattern.
		installChatBox(() => multiplayer);

		// Round 23 wave 5: network-quality diamond badges on the party-HUD portraits
		// and the element-mode indicator, with hover tooltips (ping/loss, name+level).
		installNetBadge(() => multiplayer);

		// ROUND 79 (feature): "MP v{version}" line under the version/CCLoader text on
		// the title screen and the pause screen.
		installVersionDisplay();

		multiplayer = new Multiplayer();

		// Version banner — UNGATED. This is the one line that proves WHICH bundle the
		// browser actually loaded (see ROUND 40 stale-bundle diagnosis). If you don't
		// see "[multiplayer] mod version <v> loaded" in the console, the browser served
		// a CACHED mod.js: hard-reload / disable cache and retry.
		console.log('[multiplayer] mod version ' + MP_VERSION + ' loaded');

		console.log('[multiplayer] Loading..');

		await multiplayer.load();

		console.log('[multiplayer] Loaded');

		multiplayer.initialize();

		console.log('[multiplayer] Initialized');

		// Per-frame name-tag pump (idempotent, reads the instance lazily).
		startNameTagLoop(() => multiplayer);

		// Round 21: 1s network-debug HUD overlay (reads the instance lazily too).
		startNetHudLoop(() => multiplayer);
	} catch (e) {
		console.error(e);
	}
}

startMultiplayer()
	.catch(console.error.bind(console));
