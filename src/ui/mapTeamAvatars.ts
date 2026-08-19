import { Multiplayer } from '../multiplayer';
import { areaPathOfMap } from '../util/areaUtil';
import { getMpUiScale } from './uiScale';

/**
 * 1.71.9 (QoL 2): show party-member mini avatars on the AREA map and the WORLD
 * map.
 *  - Area map: an avatar is drawn on the floor the member's sub-map belongs to.
 *    Same-map members use their live position (room-exact); members elsewhere
 *    in the area are placed at the centre of their room.
 *  - World map: an avatar is drawn at the member's AREA position (offset when
 *    several members share one area).
 * The icon reuses the game's own player-pointer sprite (media/gui/menu.png
 * 419,147 = 9x14). Hovering shows the player name via the mod's DOM tooltip.
 * Town STRANGERS are never drawn — only `main.partyMembers`.
 */

const ICON_X = 419;
const ICON_Y = 147;
const ICON_W = 9;
const ICON_H = 14;

let installed = false;
let getMain: (() => Multiplayer | undefined) | null = null;
let gfx: any = null;
let tooltip: JQuery | null = null;
let styleInstalled = false;

interface Hit { x: number; y: number; w: number; h: number; name: string; }

/** Collected during the current gui frame; consumed by the pump next frame. */
let hits: Hit[] = [];

function ensureStyle(): void {
	if (styleInstalled || typeof document === 'undefined' || !document.head) return;
	styleInstalled = true;
	const style = document.createElement('style');
	style.id = 'mpMapTeamStyle';
	style.textContent = `
.mpMapTeamTip { position: fixed; z-index: 10003; padding: 4px 9px;
	background: rgba(6,18,30,0.94); border: 1px solid #6fc7ff; border-radius: 4px;
	color: #eaf7ff; font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif;
	font-size: 12px; white-space: nowrap; pointer-events: none;
	box-shadow: 0 0 10px rgba(111,199,255,0.3); }
`;
	document.head.appendChild(style);
}

function ensureTooltip(): JQuery | null {
	if (typeof document === 'undefined' || !document.body) return null;
	if (tooltip && document.body.contains(tooltip[0])) return tooltip;
	tooltip = $('<div class="mpMapTeamTip"></div>');
	$(document.body).append(tooltip);
	return tooltip;
}

function hideTooltip(): void {
	if (tooltip) { try { tooltip.hide().text(''); } catch (_) { /* ignore */ } }
}

/** Party members with a known map; self excluded; town strangers excluded. The
 * instance roster (playerMapByName) is authoritative while the member is on our
 * own instance; the cross-instance memberMap cache covers story-sync members
 * who are legitimately on another map. */
function partyMembers(m: Multiplayer): Array<{ name: string; map: string }> {
	const out: Array<{ name: string; map: string }> = [];
	try {
		const roster: string[] = Array.isArray(m.partyMembers) ? m.partyMembers : [];
		for (const name of roster) {
			if (!name || name === m.name) continue;
			const map = (m.playerMapByName && m.playerMapByName[name])
				|| (m.memberMapByName && m.memberMapByName[name])
				|| '';
			if (map) out.push({ name, map });
		}
	} catch (_) { /* ignore */ }
	return out;
}

/** Room + floor record for a map path in the given area DATA. CrossCode's
 * AreaLoadable._createRooms() has already turned each floor's `maps` entries
 * into `floor.rooms` (AreaRoomBounds with name/min/max/offset), so read that. */
function findRoom(area: any, mapName: string): { floor: any; room: any } | null {
	try {
		if (!area || !Array.isArray(area.floors)) return null;
		for (const floor of area.floors) {
			if (!floor || !Array.isArray(floor.rooms)) continue;
			for (const room of floor.rooms) {
				if (room && room.name === mapName) return { floor, room };
			}
		}
	} catch (_) { /* ignore */ }
	return null;
}

/** Area-map GUI coordinates for one member. Same-map members are placed by
 * their live world position normalised into the room block (the area map is a
 * stylised 8px-per-tile overview, NOT a 1:1 world map, so raw coll pixels would
 * land far outside the floor GUI); members elsewhere in the area use the room
 * block centre. */
function memberMapPos(m: Multiplayer, name: string, room: any): { x: number; y: number } | null {
	try {
		const rec = m.players && m.players[name];
		const ent = rec && rec.entity;
		const g: any = (ig as any).game;
		const sameMap = !!(g && g.mapName && room && room.name === g.mapName);
		if (sameMap && ent && ent.coll && !ent._killed) {
			const wx = ent.coll.pos.x + ent.coll.size.x / 2;
			const wy = ent.coll.pos.y + ent.coll.size.y / 2;
			let nx = 0.5, ny = 0.5;
			const cm = g.collision;
			const ts = (cm && cm.tilesize) || 16;
			if (cm && typeof cm.width === 'number' && cm.width > 0) {
				nx = Math.max(0, Math.min(1, wx / (cm.width * ts)));
			}
			if (cm && typeof cm.height === 'number' && cm.height > 0) {
				ny = Math.max(0, Math.min(1, wy / (cm.height * ts)));
			}
			const rw = Math.max(8, (room.max.x - room.min.x) * 8);
			const rh = Math.max(8, (room.max.y - room.min.y) * 8);
			return { x: Math.round(room.min.x * 8 + nx * rw), y: Math.round(room.min.y * 8 + ny * rh) };
		}
	} catch (_) { /* fall through to room centre */ }
	try {
		if (room && room.min && room.max) {
			return { x: Math.round(((room.min.x + room.max.x) / 2) * 8), y: Math.round(((room.min.y + room.max.y) / 2) * 8) };
		}
	} catch (_) { /* ignore */ }
	return null;
}

function drawAreaFloorAvatars(floorGui: any, renderer: any): void {
	try {
		const m = getMain && getMain();
		const mapAny: any = (sc as any).map;
		const menu: any = (sc as any).menu;
		// 1.71.10 fix: sc.map has NO getCurrentArea() method in 1.4.2 — the old
		// guard evaluated it to undefined and bailed out every frame, so no area
		// avatar was ever drawn. Use currentArea (an AreaLoadable) directly; its
		// .data.floors[].rooms were created by the engine from the JSON maps.
		const curArea = mapAny && mapAny.currentArea;
		if (!m || !curArea || !menu || !floorGui || !floorGui.floor) return;
		const areaPath = (curArea.path || '');
		const areaData = curArea.data;
		const floorLevel = floorGui.floor.level || 0;
		// Seed screenCoords on the floor hook so ig.gui keeps it current every
		// frame (the same idiom as the world-map hook + netBadge). Hover hits can
		// then be computed in real screen coords instead of hand-built camera math.
		const fh = floorGui.hook;
		if (fh && !fh.screenCoords) {
			fh.screenCoords = { x: 0, y: 0, w: fh.size ? fh.size.x : 0, h: fh.size ? fh.size.y : 0, active: false, zIndex: 0 };
		}
		const scr = fh && fh.screenCoords;
		for (const mate of partyMembers(m)) {
			if (areaPathOfMap(mate.map) !== areaPath) continue;
			const found = findRoom(areaData, mate.map);
			if (!found || found.floor.level !== floorLevel) continue;
			const pos = memberMapPos(m, mate.name, found.room);
			if (!pos) continue;
			const lx = Math.round(pos.x - Math.floor(ICON_W / 2));
			const ly = Math.round(pos.y - ICON_H + 1);
			renderer.addGfx(gfx, lx, ly, ICON_X, ICON_Y, ICON_W, ICON_H);
			// Record the hover target in the same screen-coordinate space the
			// engine reports for the floor hook.
			if (scr) {
				hits.push({
					x: scr.x + lx - 2,
					y: scr.y + ly - 2,
					w: ICON_W + 4,
					h: ICON_H + 4,
					name: mate.name,
				});
			}
		}
	} catch (_) { /* a map icon must never break the map draw */ }
}

function drawWorldMapAvatars(world: any, renderer: any): void {
	try {
		const m = getMain && getMain();
		const mapAny: any = (sc as any).map;
		if (!m || !world || !mapAny || !mapAny.areas) return;
		const byArea: { [area: string]: string[] } = {};
		for (const mate of partyMembers(m)) {
			const area = areaPathOfMap(mate.map);
			if (!mapAny.areas[area]) continue;
			if (!byArea[area]) byArea[area] = [];
			byArea[area].push(mate.name);
		}
		for (const areaPath in byArea) {
			const area = mapAny.areas[areaPath];
			if (!area || !area.position) continue;
			const names = byArea[areaPath];
			names.forEach((name, i) => {
				const off = (i - (names.length - 1) / 2) * 10;
				const lx = Math.round(area.position.x - 8 + off - 4);
				const ly = Math.round(area.position.y - 8 - 13);
				renderer.addGfx(gfx, lx, ly, ICON_X, ICON_Y, ICON_W, ICON_H);
				// World-map hit target: world hook is positioned by the engine; seed
				// its screenCoords (same idiom as netBadge) so the hover pass can use it.
				const wh = world.hook;
				if (!wh.screenCoords) {
					wh.screenCoords = { x: 0, y: 0, w: wh.size ? wh.size.x : 0, h: wh.size ? wh.size.y : 0, active: false, zIndex: 0 };
				}
				const sc = wh.screenCoords;
				if (sc) {
					hits.push({
						x: sc.x + lx - 2,
						y: sc.y + ly - 2,
						w: ICON_W + 4,
						h: ICON_H + 4,
						name,
					});
				}
			});
		}
	} catch (_) { /* never break the world map */ }
}

function showTooltipForMouse(mx: number, my: number): void {
	hideTooltip();
	for (const h of hits) {
		if (mx >= h.x && mx < h.x + h.w && my >= h.y && my < h.y + h.h) {
			const tip = ensureTooltip();
			if (!tip) return;
			ensureStyle();
			// Convert game coords -> canvas CSS px (same math as netBadge).
			const ui = getMpUiScale();
			let x = mx + 14 * ui, y = my + 16 * ui;
			try {
				const sys: any = (ig as any).system;
				const canvas: any = sys && sys.canvas;
				if (canvas && typeof canvas.getBoundingClientRect === 'function') {
					const r = canvas.getBoundingClientRect();
					const sx = (sys.width > 0 && r.width > 0) ? r.width / sys.width : 1;
					const sy = (sys.height > 0 && r.height > 0) ? r.height / sys.height : 1;
					x = r.left + mx * sx + 14 * ui;
					y = r.top + my * sy + 16 * ui;
				}
			} catch (_) { /* fall back to game coords */ }
			// The tooltip root is zoomed; Chromium multiplies authored left/top,
			// so divide the DESIRED CSS position by the zoom factor.
			tip.css({ left: Math.round(x / ui), top: Math.round(y / ui) }).text(h.name).show();
			return;
		}
	}
}

function pump(): void {
	const prev = hits;
	hits = [];
	try {
		const m = getMain && getMain();
		const menu: any = (sc as any).menu;
		const mapMenuOpen = !!(menu && menu.currentMenu === (sc as any).MENU_SUBMENU.MAP);
		if (!m || !mapMenuOpen || !prev.length) { hideTooltip(); return; }
		const input: any = (ig as any).input;
		const mouse: any = input && input.mouse;
		if (!mouse || typeof mouse.x !== 'number' || mouse.x < 0) { hideTooltip(); return; }
		showTooltipForMouse(mouse.x, mouse.y);
	} catch (_) { hideTooltip(); }
}

function tryInstall(): boolean {
	try {
		const Floor: any = (sc as any).MapFloor;
		const World: any = (sc as any).MapWorldMap;
		if (!Floor || !World || typeof Floor.inject !== 'function' || typeof World.inject !== 'function') return false;
		gfx = gfx || new (ig as any).Image('media/gui/menu.png');
		if (!Floor.prototype._mpTeamAvatars) {
			Floor.inject({
				updateDrawables(this: any, renderer: any) {
					this.parent(renderer);
					drawAreaFloorAvatars(this, renderer);
				},
			});
			Floor.prototype._mpTeamAvatars = true;
		}
		if (!World.prototype._mpTeamAvatars) {
			World.inject({
				updateDrawables(this: any, renderer: any) {
					this.parent(renderer);
					drawWorldMapAvatars(this, renderer);
				},
			});
			World.prototype._mpTeamAvatars = true;
		}
		if (!Floor.prototype._mpTeamAvatars || !World.prototype._mpTeamAvatars) return false;
		const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
		if (s && typeof s.registerUpdate === 'function' && !(s as any)._mpMapTeamPump) {
			(s as any)._mpMapTeamPump = true;
			s.registerUpdate(() => { try { pump(); } catch (_) { /* ignore */ } });
		}
		return true;
	} catch (_) { return false; }
}

/** Install map avatars; retries lazily until the map GUI classes exist. */
export function installMapTeamAvatars(getter: () => Multiplayer | undefined): void {
	if (installed) return;
	if (typeof sc === 'undefined' || typeof ig === 'undefined') return;
	installed = true;
	getMain = getter;
	const attempt = () => {
		if (!tryInstall()) setTimeout(attempt, 1000);
	};
	try {
		if (!tryInstall()) setTimeout(attempt, 1000);
	} catch (_) { setTimeout(attempt, 1000); }
}
