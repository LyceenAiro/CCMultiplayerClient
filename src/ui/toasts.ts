/**
 * Round 23: a GENERIC in-game-style toast module (top-right stacked notification).
 *
 * Rendered like the game's item-pickup toast but positioned top-right and styled
 * richer: a dark-navy panel (rgba(6,18,30,0.94)) with cyan #6fc7ff accents, sliding
 * in from the right and auto-expiring after ~4s with a fade. Newest toast stacks
 * BELOW the previous one; at most MAX_VISIBLE are kept (oldest dropped). Optional
 * square icon slot (img) on the left, CJK-safe font stack, pure DOM/jQuery like the
 * rest of the mod UI, fixed inside the game viewport.
 *
 * Wave 3 will reuse this for friend/party toasts — keep it generic.
 */

/** Maximum toasts visible at once (oldest dropped beyond this). */
const MAX_VISIBLE = 4;
/** Auto-expire delay before the fade-out starts. */
const TOAST_DURATION_MS = 4000;
/** Fade-out duration (must match the mpToastOut keyframes). */
const FADE_MS = 400;

let container: JQuery | null = null;
let styleInstalled = false;

/** Inject the toast stylesheet exactly once (document may not be ready yet). */
function ensureStyle(): void {
	if (styleInstalled) return;
	styleInstalled = true;
	const style = document.createElement('style');
	style.id = 'mpToastsStyle';
	style.textContent = `
.mpToastStack { position: fixed; top: 10px; right: 14px; z-index: 10002;
	display: flex; flex-direction: column; gap: 8px; align-items: flex-end;
	pointer-events: none; }
.mpToast { display: flex; align-items: flex-start; gap: 10px;
	max-width: 300px; padding: 10px 14px;
	background: rgba(6, 18, 30, 0.94);
	border: 1px solid #6fc7ff; border-radius: 6px;
	box-shadow: 0 0 14px rgba(111, 199, 255, 0.35), inset 0 0 20px rgba(13, 42, 66, 0.8);
	color: #eaf7ff; font-family: 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
	opacity: 0; transform: translateX(110%);
	animation: mpToastIn 0.24s ease-out forwards; }
.mpToast.mpToastOut { animation: mpToastOut 0.4s ease-in forwards; }
.mpToastIcon { flex: 0 0 34px; width: 34px; height: 34px; border-radius: 4px;
	border: 1px solid rgba(111, 199, 255, 0.6); object-fit: cover; }
.mpToastText { display: flex; flex-direction: column; }
.mpToastTitle { font-size: 13px; color: #dff3ff; letter-spacing: 0.5px; line-height: 1.35; }
.mpToastSub { font-size: 11px; color: #8fd6ff; margin-top: 3px; line-height: 1.3; }
@keyframes mpToastIn { from { transform: translateX(110%); opacity: 0; }
	to { transform: translateX(0); opacity: 1; } }
@keyframes mpToastOut { from { transform: translateX(0); opacity: 1; }
	to { transform: translateX(110%); opacity: 0; } }
`;
	try {
		if (document.head) document.head.appendChild(style);
		else if (document.documentElement) document.documentElement.appendChild(style);
	} catch (_) { /* document not ready — the stack would fail anyway */ }
}

/** Lazily create the (single) toast stack container. Returns null when the document
 * isn't ready (no body yet) — callers just skip the toast then. */
function ensureContainer(): JQuery | null {
	if (typeof document === 'undefined' || !document.body) return null;
	ensureStyle();
	if (!container || !document.body.contains(container[0])) {
		container = $('<div class="mpToastStack"></div>');
		$(document.body).append(container);
	}
	return container;
}

/** Drop the oldest toasts beyond MAX_VISIBLE. */
function trimStack(): void {
	try {
		const c = container;
		if (!c) return;
		const kids = c.children('.mpToast');
		while (kids.length > MAX_VISIBLE) {
			kids.first().remove();
		}
	} catch (_) { /* ignore */ }
}

/** Show a game-style top-right toast. Newest stacks below the previous one;
 * auto-expires after ~4s (fade-out), oldest dropped past MAX_VISIBLE. Never throws
 * (a toast must never break the caller). */
export function showMpToast(opts: { title: string, subtitle?: string, iconUrl?: string }): void {
	try {
		const stack = ensureContainer();
		if (!stack) return;
		const box = $('<div class="mpToast"></div>');
		if (opts.iconUrl) {
			box.append($('<img class="mpToastIcon" alt="">').attr('src', opts.iconUrl));
		}
		const text = $('<div class="mpToastText"></div>');
		text.append($('<div class="mpToastTitle"></div>').text(opts.title));
		if (opts.subtitle) {
			text.append($('<div class="mpToastSub"></div>').text(opts.subtitle));
		}
		box.append(text);
		stack.append(box);
		trimStack();
		const expire = () => {
			box.addClass('mpToastOut');
			window.setTimeout(() => {
				try { box.remove(); trimStack(); } catch (_) { /* ignore */ }
			}, FADE_MS);
		};
		window.setTimeout(expire, TOAST_DURATION_MS);
	} catch (_) { /* a toast must never break the caller */ }
}
