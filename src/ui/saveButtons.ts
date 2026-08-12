import { Multiplayer } from '../multiplayer';

/**
 * Round 23: DIRECT save+upload buttons in the two in-game save triggers.
 *
 * While connected to the server, clicking the save button performs a DIRECT
 * save + upload (no save-management page) and shows the "save uploaded" toast via
 * the normal saveSaved flow. While NOT connected, the button keeps its vanilla
 * behavior (open the save menu).
 *
 * Engine facts (game.compiled.js):
 *  - sc.StartMenu (TAB bag submenu) creates `this.buttons.save` whose onButtonPress
 *    is `function(){sc.menu.pushMenu(sc.MENU_SUBMENU.SAVE)}`.
 *  - sc.PauseScreenGui (ESC) creates `this.saveGameButton.onButtonPress =
 *    function(){sc.menu.setDirectMode(true, sc.MENU_SUBMENU.SAVE); sc.model.enterMenu(true)}`.
 *  - sc.StartMenu is created ONCE by sc.MainMenu.init (this.submenus.start), and
 *    sc.PauseScreenGui is a single instance added to ig.gui at game boot — BOTH
 *    typically exist before this installer runs (mod main runs after game start).
 *    So we inject init (covers a host built after install) AND patch the live
 *    instances if they already exist.
 *  - sc.PauseScreenGui.updateButtons runs EVERY time the pause menu opens on the
 *    (persistent) instance — a reliable live hook to patch the button even when the
 *    instance predates this install.
 */

export function installSaveButtons(getMain: () => Multiplayer | undefined): void {
	if (typeof sc === 'undefined' || !(sc as any).StartMenu || !(sc as any).PauseScreenGui) {
		console.warn('[multiplayer] sc.StartMenu / sc.PauseScreenGui not available; direct-save buttons not installed');
		return;
	}

	/** Patch ONE save button. `vanilla` is the fallback behavior when not connected
	 * (the original handler is preferred; vanilla is only used when the button had
	 * none). Reads getMain LIVE so reconnects always see the current connection. */
	const patch = (btn: any, vanilla: () => void): void => {
		if (!btn || btn._mpSaveWired) return;
		btn._mpSaveWired = true;
		const orig = typeof btn.onButtonPress === 'function' ? btn.onButtonPress : null;
		btn.onButtonPress = (...args: any[]) => {
			const main = getMain();
			const conn = main && main.connection;
			if (conn && conn.isOpen()) {
				// Connected: DIRECT save + upload, no save-management page.
				try { main.saveNow('manual save'); } catch (_) { /* ignore */ }
			} else if (orig) {
				orig.apply(btn, args);
			} else {
				try { vanilla(); } catch (_) { /* ignore */ }
			}
		};
	};

	const patchStartMenu = (sm: any): void => {
		if (sm && sm.buttons && sm.buttons.save) {
			patch(sm.buttons.save, () => { (sc as any).menu.pushMenu((sc as any).MENU_SUBMENU.SAVE); });
		}
	};

	const patchPause = (pg: any): void => {
		if (pg && pg.saveGameButton) {
			patch(pg.saveGameButton, () => {
				(sc as any).menu.setDirectMode(true, (sc as any).MENU_SUBMENU.SAVE);
				(sc as any).model.enterMenu(true);
			});
		}
	};

	// ---- injects (cover hosts/submenus created AFTER this install) ----
	(sc as any).StartMenu.inject({
		init(this: any) {
			this.parent();
			patchStartMenu(this);
		},
	});

	// PauseScreenGui: single boot instance, so ALSO patch from updateButtons (runs
	// every time the pause menu opens on the persistent instance).
	(sc as any).PauseScreenGui.inject({
		init(this: any) {
			this.parent();
			patchPause(this);
		},
		updateButtons(this: any, fromMenu: any) {
			this.parent(fromMenu);
			patchPause(this);
		},
	});

	// ---- live instances (game boot built them before mod main ran) ----
	try {
		const mr = (sc as any).menu && (sc as any).menu.guiReference;
		if (mr && mr.submenus && mr.submenus.start) patchStartMenu(mr.submenus.start);
	} catch (_) { /* ignore */ }
	try {
		const g: any = ig.gui;
		const hooks = g && g.guiHooks;
		if (hooks && hooks.length) {
			for (const h of hooks) {
				if (h && h.gui instanceof (sc as any).PauseScreenGui) { patchPause(h.gui); break; }
			}
		}
	} catch (_) { /* ignore */ }
}
