import { Multiplayer } from '../multiplayer';
import { getMpUiScale } from './uiScale';

/**
 * 1.71.9 (QoL 1): off-screen teammate arrows.
 *
 * For every PARTY teammate (town strangers are never indicated), project their
 * live position onto the screen. When they are outside the viewport the arrow
 * is clamped to the screen edge and rotated toward them; the arrow grows as the
 * world distance shrinks. Hovering it shows the player name. Pure pixel-art SVG
 * (crispEdges), pointer-events only on the arrow itself so it never blocks the
 * game. Hidden in menus / while disconnected / while a story video plays.
 */

const EDGE_MARGIN = 30;
const ARROW_MIN = 14;
const ARROW_MAX = 30;
const ARROW_DIST_DIV = 28;

let installed = false;
let getMain: (() => Multiplayer | undefined) | null = null;
let styleInstalled = false;
const els: { [name: string]: JQuery } = {};

function ensureStyle(): void {
	if (styleInstalled || typeof document === 'undefined' || !document.head) return;
	styleInstalled = true;
	const style = document.createElement('style');
	style.id = 'mpTeammateArrowStyle';
	style.textContent = `
.mpTeammateArrow { position: fixed; z-index: 10002; pointer-events: auto; cursor: help;
	transform-origin: center; image-rendering: pixelated; filter: drop-shadow(0 0 4px rgba(0,0,0,0.9)); }
.mpTeammateArrow svg { display: block; shape-rendering: crispEdges; }
.mpTeammateArrow::after { content: attr(data-tip); position: absolute; left: 50%; top: -26px;
	transform: translateX(-50%); background: rgba(6,18,30,0.95); border: 1px solid #6fc7ff;
	border-radius: 4px; padding: 3px 8px; color: #eaf7ff; white-space: nowrap;
	font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif; font-size: 12px;
	opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
.mpTeammateArrow:hover::after { opacity: 1; }
`;
	document.head.appendChild(style);
}

function arrowSvg(size: number): string {
	// Pixel-art arrow (tall triangle with a notched tail) scaled to the box.
	return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 13 13" shape-rendering="crispEdges">'
		+ '<path fill="#eaf7ff" d="M6 0h1v2h1v1h1v1h1v1h-1v1h1v1h1v1h-1v1h-1v1h-1v1h1v1h1v1h-1v-1h-1v-1h-1v1h-1v-1h-1v-1h1v-1h1v-1h1v-1h-1v-1h-1v-1h1v-1h1v-1h1z"/>'
		+ '<path fill="#6fc7ff" d="M5 3h1v1h-1zM7 3h1v1h-1zM6 5h1v4h-1zM3 8h2v1h-2zM8 8h2v1h-2zM3 10h1v1h-1zM9 10h1v1h-1z"/>'
		+ '</svg>';
}

function ensureEl(name: string): JQuery {
	let el = els[name];
	if (!el || !document.body.contains(el[0])) {
		el = $('<div class="mpTeammateArrow"></div>').attr('data-tip', name);
		$(document.body).append(el);
		els[name] = el;
	}
	return el;
}

function inGameOk(m: Multiplayer): boolean {
	try {
		const g: any = (ig as any).game;
		if (!g || !g.playerEntity) return false;
		if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return false;
		const menu: any = (sc as any).menu;
		if (menu && menu.menuStack && menu.menuStack.length > 0) return false;
		if (!m.connection || typeof m.connection.isOpen !== 'function' || !m.connection.isOpen()) return false;
		return true;
	} catch (_) { return false; }
}

function hideAll(): void {
	for (const name in els) {
		try { els[name].hide(); } catch (_) { /* ignore */ }
	}
}

function tick(): void {
	try {
		ensureStyle();
		const m = getMain && getMain();
		if (!m || !inGameOk(m)) { hideAll(); return; }
		// The story video owns the whole screen; off-screen arrows would clutter it.
		if (m.storySync && typeof m.storySync.storyEventActive === 'function' && m.storySync.storyEventActive()) {
			hideAll();
			return;
		}
		const sys: any = (ig as any).system;
		const g: any = (ig as any).game;
		const player = g.playerEntity;
		if (!sys || typeof sys.getScreenFromMapPos !== 'function' || !player || !player.coll) { hideAll(); return; }
		const canvas: any = sys.canvas;
		let scaleX = 1, scaleY = 1, left0 = 0, top0 = 0;
		try {
			if (canvas && typeof canvas.getBoundingClientRect === 'function') {
				const r = canvas.getBoundingClientRect();
				scaleX = sys.width > 0 && r.width > 0 ? r.width / sys.width : (sys.scale || 1);
				scaleY = sys.height > 0 && r.height > 0 ? r.height / sys.height : (sys.scale || 1);
				left0 = r.left; top0 = r.top;
			}
		} catch (_) { /* fall back to game coords */ }
		const roster: string[] = Array.isArray(m.partyMembers) ? m.partyMembers : [];
		const shown: { [name: string]: boolean } = {};
		const vw = sys.width || 1;
		const vh = sys.height || 1;
		const cx = vw / 2;
		const cy = vh / 2;
		for (const name of roster) {
			if (!name || name === m.name) continue;
			if (!m.isPartyMateOnMap(name)) continue;
			const rec = m.players && m.players[name];
			const ent = rec && rec.entity;
			let wx = 0, wy = 0, dist = 99999;
			if (ent && ent.coll && !ent._killed) {
				wx = ent.coll.pos.x + (ent.coll.size ? ent.coll.size.x / 2 : 8);
				wy = ent.coll.pos.y + (ent.coll.size ? ent.coll.size.y / 2 : 8) - ent.coll.pos.z;
				dist = Math.hypot(wx - (player.coll.pos.x + player.coll.size.x / 2),
					wy - (player.coll.pos.y + player.coll.size.y / 2 - player.coll.pos.z));
			} else if (rec && rec.position && typeof rec.position.x === 'number') {
				wx = rec.position.x; wy = rec.position.y - (typeof rec.position.z === 'number' ? rec.position.z : 0);
			} else {
				continue;
			}
			const scr = sys.getScreenFromMapPos(Math.round(wx), Math.round(wy));
			const sx = Number(scr && scr.x);
			const sy = Number(scr && scr.y);
			if (!isFinite(sx) || !isFinite(sy)) continue;
			const margin = EDGE_MARGIN;
			if (sx >= margin && sx <= vw - margin && sy >= margin && sy <= vh - margin) continue;
			// Clamp to the edge and point toward the teammate.
			const dx = sx - cx;
			const dy = sy - cy;
			const ang = Math.atan2(dy, dx);
			let px = sx, py = sy;
			if (sx < margin) { px = margin; py = cy + Math.tan(ang) * (margin - cx); }
			else if (sx > vw - margin) { px = vw - margin; py = cy + Math.tan(ang) * ((vw - margin) - cx); }
			if (py < margin) { py = margin; if (Math.abs(Math.cos(ang)) > 0.001) px = cx + (margin - cy) / Math.tan(ang); }
			else if (py > vh - margin) { py = vh - margin; if (Math.abs(Math.cos(ang)) > 0.001) px = cx + ((vh - margin) - cy) / Math.tan(ang); }
			px = Math.max(margin, Math.min(vw - margin, px));
			py = Math.max(margin, Math.min(vh - margin, py));
			const size = Math.max(ARROW_MIN, Math.min(ARROW_MAX, ARROW_MAX - (isFinite(dist) ? dist : 0) / ARROW_DIST_DIV));
			const el = ensureEl(name);
			if (el.attr('data-size') !== String(Math.round(size))) {
				el.attr('data-size', Math.round(size));
				el.html(arrowSvg(Math.round(size)));
			}
			// 1.71.10: the arrow root is `zoom: var(--mp-ui-scale)`, and Chromium's
			// zoom multiplies authored left/top too. Convert the desired CSS center
			// back into PRE-ZOOM coords (`desired / ui - size/2`) so the visual
			// center still lands on the canvas-projected teammate position. Also
			// clamp by the VISUAL half-size so a 300%/400% arrow never slides
			// half-off the edge.
			const ui = getMpUiScale();
			const halfX = scaleX > 0 ? (size * ui / 2) / scaleX : 0;
			const halfY = scaleY > 0 ? (size * ui / 2) / scaleY : 0;
			px = Math.max(halfX, Math.min(vw - halfX, px));
			py = Math.max(halfY, Math.min(vh - halfY, py));
			const cssX = left0 + px * scaleX;
			const cssY = top0 + py * scaleY;
			const deg = Math.round(ang * 180 / Math.PI);
			el.css({
				left: Math.round(cssX / ui - size / 2),
				top: Math.round(cssY / ui - size / 2),
				width: size,
				height: size,
				transform: 'rotate(' + deg + 'deg)',
			}).show();
			shown[name] = true;
		}
		for (const name in els) {
			if (!shown[name]) { try { els[name].hide(); } catch (_) { /* ignore */ } }
		}
	} catch (_) { /* never break the frame */ }
}

/** Install the per-frame off-screen teammate arrows (idempotent). */
export function installTeammateIndicators(getter: () => Multiplayer | undefined): void {
	if (installed) return;
	if (typeof simplify === 'undefined' || typeof ig === 'undefined') return;
	installed = true;
	getMain = getter;
	simplify.registerUpdate(() => { try { tick(); } catch (_) { /* ignore */ } });
}
