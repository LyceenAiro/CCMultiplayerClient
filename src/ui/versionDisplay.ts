import { MP_VERSION } from '../multiplayer';

/**
 * ROUND 79 (feature): show the multiplayer version on the title screen AND the
 * pause screen, right below the "CCLoader v..." line the ccloader-version-display
 * mod attaches under the game's own version text (the spot where the game version
 * and the CCLoader version are shown). Format: "MP v{version}".
 *
 * Both screens carry a `versionGui` (sc.TextGui) - the same hook the
 * ccloader-version-display mod uses. We append one more tiny-font line under the
 * CCLoader line (or directly under the version text when that mod is absent).
 * The attach runs AFTER this.parent() so the CCLoader mod's injected init (which
 * creates ccloaderVersionGui) has already executed and we can detect it.
 */

export function installVersionDisplay(): void {
	if (typeof sc === 'undefined' || !(sc as any).TitleScreenGui || !(sc as any).PauseScreenGui) {
		console.warn('[multiplayer] sc.TitleScreenGui / sc.PauseScreenGui not available; MP version display not installed');
		return;
	}

	const attach = (gui: any): void => {
		try {
			if (!gui || gui._mpVersionGui || !gui.versionGui || !gui.versionGui.hook) return;
			const hasCcl = !!(gui.ccloaderVersionGui);
			const sy: number = (gui.versionGui.hook.size && typeof gui.versionGui.hook.size.y === 'number')
				? gui.versionGui.hook.size.y : 8;
			const mpGui = new (sc as any).TextGui('MP v' + MP_VERSION, { font: (sc as any).fontsystem.tinyFont });
			mpGui.setAlign(gui.versionGui.hook.align.x, gui.versionGui.hook.align.y);
			mpGui.setPos(0, sy * (hasCcl ? 2 : 1));
			gui.versionGui.addChildGui(mpGui);
			gui._mpVersionGui = mpGui;
		} catch (e) { console.warn('[multiplayer] MP version display attach failed', e); }
	};

	// ---- injects (cover screens created AFTER this install) ----
	(sc as any).TitleScreenGui.inject({
		init(this: any, ...args: any[]) {
			this.parent(...args);
			attach(this);
		},
	});

	(sc as any).PauseScreenGui.inject({
		init(this: any, ...args: any[]) {
			this.parent(...args);
			attach(this);
		},
	});

	// ---- live instances (game boot built them before mod main ran) ----
	try {
		const g: any = ig.gui;
		const hooks = g && g.guiHooks;
		if (hooks && hooks.length) {
			for (const h of hooks) {
				if (!h || !h.gui) continue;
				if (h.gui instanceof (sc as any).PauseScreenGui) attach(h.gui);
				if (h.gui instanceof (sc as any).TitleScreenGui) attach(h.gui);
			}
		}
	} catch (_) { /* ignore */ }
}
