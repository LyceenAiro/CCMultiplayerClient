/**
 * 1.71.10 — one scale for every mod-owned EXTERNAL DOM UI.
 *
 * The mod draws two kinds of overlays:
 *   - IN-CANVAS (name tags, net-debug HUD): rendered inside the game canvas and
 *     therefore already zoomed by the engine. Those read `getMpUiCanvasScale()`
 *     in mpOptions.ts, where 'auto' = 1 and fixed tiers scale the GUI hook.
 *   - EXTERNAL DOM (panels, chat, toasts, tooltips, arrows, story banners):
 *     rendered as DOM outside the canvas at fixed CSS px sizes. This module sets
 *     the CSS variable `--mp-ui-scale` on <html> and applies `zoom` to each
 *     top-level overlay root, so the whole layout (fonts, paddings, sizes, and
 *     reflowed text wrapping) scales coherently.
 *
 * 'auto' follows the engine's on-screen zoom: the ratio between the canvas CSS
 * box and the virtual game resolution (`canvas.getBoundingClientRect()` /
 * `ig.system.width/height`). That is exactly the mapping the mod already uses to
 * position DOM overlays over game coordinates, so Auto keeps the DOM UIs the
 * same visual size as the zoomed game HUD.
 *
 * NOTE: Chromium's `zoom` multiplies authored absolute offsets too. Modules
 * that position a zoomed root from canvas coordinates (teammate arrows,
 * net/map tooltips, chat name menu) therefore divide their computed CSS
 * coordinates by `getMpUiScale()` — the helpers here document that contract.
 */

/** Root elements the pump scales. Deliberately NOT full-screen scrims/flex
 * containers (zoom on 100% width/height roots doubles their viewport box);
 * their inner panels are scaled instead. */
const ZOOM_TARGETS = [
	'body > .mpChatBox',
	'body > .mpChatPops',
	'body > .mpChatNameMenu',
	'body > .mpLogin',
	'body > .mpWin',
	'body > .mpComm',
	'body > .mpCommToast',
	'body > .mpToastStack',
	'body > .mpTeammateArrow',
	'body > .mpMapTeamTip',
	'body > .mpNetBadgeTip',
	'body > .mpTriggerBanner',
	'body > .mpStoryStar',
	'body > .mpStoryScrim > .mpStoryBox',
	'body > .mpStoryComm > .mpStoryCommGlow',
	'body > .mpStoryComm > .mpStoryCommInner',
	'body > .mpStoryParty > .mpStoryPartyGlow',
	'body > .mpStoryParty > .mpStoryPartyInner',
	'body > .mpServerScrim > .mpServerPanel',
	'body > .mpServerModal > .mpServerForm',
	'body > .mpSaveBlock > .mpSavePanel',
];

let installed = false;
let styleInstalled = false;
let getOption: (() => number | 'auto') | null = null;
let current = 1;
let lastApplied = -1;

/** Engine's on-screen zoom: canvas CSS box / virtual game resolution. The
 * geometric mean handles minor aspect-ratio rounding; clamped so a hidden /
 * resizing canvas can never produce a pathological multiplier. */
function autoScale(): number {
	try {
		const sys: any = (ig as any).system;
		if (sys && sys.width > 0 && sys.height > 0 && sys.canvas
			&& typeof sys.canvas.getBoundingClientRect === 'function') {
			const r = sys.canvas.getBoundingClientRect();
			if (r && r.width > 0 && r.height > 0) {
				const sx = r.width / sys.width;
				const sy = r.height / sys.height;
				const s = Math.sqrt(sx * sy);
				if (isFinite(s) && s > 0) return Math.max(0.25, Math.min(8, s));
			}
		}
		if (sys && typeof sys.scale === 'number' && sys.scale > 0) {
			return Math.max(0.25, Math.min(8, sys.scale));
		}
	} catch (_) { /* fall back to 100% */ }
	return 1;
}

function compute(): number {
	try {
		const v = getOption ? getOption() : 'auto';
		return typeof v === 'number' && isFinite(v) && v > 0 ? v : autoScale();
	} catch (_) { return 1; }
}

function ensureStyle(): void {
	if (styleInstalled || typeof document === 'undefined') return;
	const style = document.createElement('style');
	style.id = 'mpUiScaleStyle';
	style.textContent = `
:root { --mp-ui-scale: 1; }
${ZOOM_TARGETS.join(',\n')} {
	zoom: var(--mp-ui-scale);
}
`;
	try {
		if (document.head) document.head.appendChild(style);
		else if (document.documentElement) document.documentElement.appendChild(style);
		styleInstalled = true;
	} catch (_) { /* document not ready — a later refresh retries */ }
}

/** Recompute from the option + engine zoom and push the CSS variable. Cheap and
 * change-gated; safe to run every frame from the simplify pump. */
export function refreshMpUiScaleNow(): void {
	try {
		if (!styleInstalled && typeof document !== 'undefined') ensureStyle();
	} catch (_) { /* ignore */ }
	const next = compute();
	if (next === current && lastApplied === current) return;
	current = next;
	let applied = false;
	try {
		if (document && document.documentElement) {
			document.documentElement.style.setProperty('--mp-ui-scale', String(current));
			applied = true;
		}
	} catch (_) { /* retry on a later frame */ }
	if (applied) lastApplied = current;
}

/** Current external-DOM UI multiplier (1 until install / a fixed tier / auto). */
export function getMpUiScale(): number {
	return current;
}

/** Install the once-per-frame scale pump. `getOption` is injected by main.ts so
 * this module never imports mpOptions (avoids a multiplayer import cycle). */
export function installMpUiScale(optionGetter: () => number | 'auto'): void {
	if (installed) return;
	installed = true;
	getOption = optionGetter;
	refreshMpUiScaleNow();
	const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
	if (s && typeof s.registerUpdate === 'function') {
		s.registerUpdate(() => {
			try { refreshMpUiScaleNow(); } catch (_) { /* never break the frame */ }
		});
	} else {
		try { window.setInterval(() => refreshMpUiScaleNow(), 500); } catch (_) { /* ignore */ }
	}
}
