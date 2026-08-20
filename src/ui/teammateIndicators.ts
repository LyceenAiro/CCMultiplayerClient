import { Multiplayer } from '../multiplayer';
import { getMpUiScale } from './uiScale';

/**
 * 1.71.9 (QoL 1): off-screen teammate arrows.
 *
 * For every PARTY teammate (town strangers are never indicated), project their
 * live position onto the screen. When they are outside the viewport the arrow
 * is clamped flush against the screen edge and rotated toward them; the arrow
 * grows as the world distance shrinks. Hovering it shows the player name.
 * Lightweight SVG, pointer-events only on the arrow itself so it never blocks
 * the game.
 *
 * Fix round (user feedback):
 *  - EDGE_MARGIN 30 -> 6 so the arrow visually hugs the screen edge (the
 *    half-size clamp keeps even the largest arrow fully on-screen).
 *  - Arrow redrawn as a clean triangle arrowhead (dark outline + vivid red
 *    body, smooth edges), size 14-30 by distance (per user feedback).
 *    Rotation is atan2-deg + 90: the graphic points UP at rest while atan2's
 *    0deg means RIGHT (CSS rotate is clockwise in screen coordinates).
 *  - The arrow is pointer-events:none with a MANUAL hover hit-test (showTip
 *    class): CSS :hover let Chromium swap the game's custom cursor for the OS
 *    cursor while hovering the arrow.
 *  - The rotation now goes on the SVG child (CSS var --mpRot), NOT the root:
 *    the ::after name tooltip is a child of the root, so rotating the root
 *    rotated the tooltip with it. Tooltip also re-anchors when the arrow sits
 *    in a corner (tip-below / tip-left / tip-right) so it never overflows the
 *    screen.
 *  - Menu/cutscene hiding uses sc.model state predicates (isMenu / isPaused /
 *    isQuickMenu / isCutscene / isHUDBlocked / ONMAPMENU) instead of only
 *    sc.menu.menuStack.length: the ESC root menu never pushes menuStack, so
 *    arrows stayed visible over ESC, and cutscenes were not covered at all.
 */

const EDGE_MARGIN = 6;
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
	style.textContent = `.mpTeammateArrow { position: fixed; z-index: 10002; pointer-events: none;
	filter: drop-shadow(0 1px 3px rgba(0,0,0,0.9)); }
.mpTeammateArrow svg { display: block;
	transform: rotate(var(--mpRot, 0deg)); }
.mpTeammateArrow::after { content: attr(data-tip); position: absolute; left: 50%; bottom: calc(100% + 6px);
	transform: translateX(-50%); background: rgba(30,6,6,0.95); border: 1px solid #ff5a52;
	border-radius: 4px; padding: 3px 8px; color: #ffe9e7; white-space: nowrap;
	font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif; font-size: 12px;
	opacity: 0; pointer-events: none; transition: opacity 0.12s ease; }
.mpTeammateArrow.tip-below::after { bottom: auto; top: calc(100% + 6px); }
.mpTeammateArrow.tip-left::after { left: -6px; transform: none; }
.mpTeammateArrow.tip-right::after { left: auto; right: -6px; transform: none; }
.mpTeammateArrow.showTip::after { opacity: 1; }
`;
	document.head.appendChild(style);
}

function arrowSvg(size: number): string {
	// Clean triangle arrowhead (paper-plane style) pointing UP at rest:
	// a dark outline silhouette with a vivid red body inset inside it.
	return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 16 16">'
		+ '<path fill="#26060a" d="M8 0 L16 15 L8 11 L0 15 Z"/>'
		+ '<path fill="#ff3229" d="M8 2.2 L14.1 13.8 L8 9.9 L1.9 13.8 Z"/>'
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
		// Hide while ANY menu/pause/quick-menu/cutscene/loading state is active.
		// The old sc.menu.menuStack check missed the ESC root menu (START never
		// pushes menuStack) and cutscenes entirely.
		const model: any = (sc as any).model;
		if (model) {
			if (typeof model.isPaused === 'function' && model.isPaused()) return false;
			if (typeof model.isMenu === 'function' && model.isMenu()) return false;
			if (typeof model.isQuickMenu === 'function' && model.isQuickMenu()) return false;
			if (typeof model.isCutscene === 'function' && model.isCutscene()) return false;
			if (typeof model.isHUDBlocked === 'function' && model.isHUDBlocked()) return false;
			const sub = (sc as any).GAME_MODEL_SUBSTATE;
			if (sub && typeof model.currentSubState !== 'undefined'
				&& (model.currentSubState === sub.ONMAPMENU || model.currentSubState === sub.TITLE)) return false;
		}
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
			// ig.system.getScreenFromMapPos(dest, x, y) MUTATES and returns `dest`;
			// give it a real vector like the name-tag projection does.
			const scr: any = {};
			sys.getScreenFromMapPos(scr, Math.round(wx), Math.round(wy));
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
			// The arrow root is zoom: var(--mp-ui-scale), and Chromium's zoom
			// multiplies authored left/top too. Convert the desired CSS center back
			// into PRE-ZOOM coords (desired / ui - size/2) so the visual center
			// still lands on the canvas-projected teammate position. Also clamp by
			// the VISUAL half-size so a 300%/400% arrow never slides half-off the
			// edge — this is what makes the arrow hug the screen border.
			const ui = getMpUiScale();
			const halfX = scaleX > 0 ? (size * ui / 2) / scaleX : 0;
			const halfY = scaleY > 0 ? (size * ui / 2) / scaleY : 0;
			px = Math.max(halfX, Math.min(vw - halfX, px));
			py = Math.max(halfY, Math.min(vh - halfY, py));
			const cssX = left0 + px * scaleX;
			const cssY = top0 + py * scaleY;
			// The arrow graphic points UP at rest while atan2's 0deg means RIGHT
			// (CSS rotate is clockwise in screen coords), so shift by +90.
			const deg = Math.round(ang * 180 / Math.PI) + 90;
			// Rotate ONLY the svg (CSS var); the root stays axis-aligned so the
			// ::after name tooltip never tilts with the arrow.
			try { (el[0] as HTMLElement).style.setProperty('--mpRot', deg + 'deg'); } catch (_) { /* ignore */ }
			// Keep the tooltip on-screen when the arrow sits in a corner.
			el.toggleClass('tip-below', py < 56);
			el.toggleClass('tip-left', px < 96);
			el.toggleClass('tip-right', px > vw - 96);
			// Manual hover: the arrow is pointer-events:none so it NEVER steals the
			// mouse from the canvas — CSS :hover made Chromium swap the game's own
			// cursor for the OS cursor. Hit-test the engine mouse position against
			// the arrow's on-screen box and toggle the showTip class instead.
			const mo: any = (ig as any).input && (ig as any).input.mouse;
			const hov = !!(mo && typeof mo.x === 'number' && mo.x >= 0
				&& Math.abs(mo.x - px) <= halfX + 2 && Math.abs(mo.y - py) <= halfY + 2);
			el.toggleClass('showTip', hov);
			el.css({
				left: Math.round(cssX / ui - size / 2),
				top: Math.round(cssY / ui - size / 2),
				width: size,
				height: size,
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
