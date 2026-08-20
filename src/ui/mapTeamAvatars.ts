import { Multiplayer } from '../multiplayer';
import { areaPathOfMap } from '../util/areaUtil';
import { getMpUiScale } from './uiScale';

/**
 * 1.71.9 (QoL 2): show party-member markers on the AREA map and the WORLD map.
 *  - Area map: a marker is drawn INSIDE the room the member's sub-map belongs
 *    to. Same-map members use their live position (room-exact); members
 *    elsewhere in the area are placed one third down from their room's top
 *    edge, fanned out when several share one room.
 *  - World map: a marker is drawn at the member's AREA position. Extra
 *    markers extend LEFTWARD from the vanilla self-marker slot (skipping that
 *    slot when the local player shares the area) and wrap to a new row above
 *    when they would run off the left screen edge — never overlapping, never
 *    overflowing. Hovering any marker shows the player name. On areas the
 *    local player is NOT in, the marker closest to the area button also gets
 *    the vanilla white triangle pointer (menu.png 304,440) at its bottom-right
 *    so the head visually points at its area icon; in the local player's own
 *    area vanilla already draws that pointer on the self marker.
 * The icon is the game's OWN world-map player marker (media/gui/menu.png
 * 280,424 = 16x11 Lea head) — the exact sprite vanilla uses to mark the local
 * player on the world map. Hovering shows the player name via the mod's DOM
 * tooltip. Town STRANGERS are never drawn — only `main.partyMembers`.
 *
 * Fix round (user feedback):
 *  - Texture: was menu.png 419,147 9x14 (a generic pin) -> the vanilla player
 *    marker 280,424 16x11, same as the local player's world-map indicator.
 *  - Area map showed NOTHING: the old code drew inside sc.MapFloor's
 *    updateDrawables, but a floor's drawables render UNDERNEATH its children,
 *    and the children (sc.MapRoom) paint the opaque room tiles exactly where
 *    the icons landed — every icon was covered. Drawing is now injected into
 *    sc.MapRoom.updateDrawables AFTER the room's own tiles, so markers sit on
 *    top of the map. Icon alpha mirrors roomAlpha like the room tiles do.
 *  - Area-map CENTRED markers sit one third down from the room's top edge
 *    (the 6px lift was not enough) — clear of the room-centre teleport icon.
 *  - Hover names never worked since this shipped: pump() saved the collected
 *    hits into `prev` and reset the global, but showTooltipForMouse read the
 *    (now empty) global instead of `prev`. It now receives the array.
 *  - World-map markers only ever appeared for TOWN teammates: the area was
 *    derived from the map name's first dot segment, but "autumn.*" maps live
 *    in area "autumn-area", "heat.*" in "heat-area" and "bergen-trail.*" in
 *    "bergen-trails", so every non-town lookup missed sc.map.areas and the
 *    marker was skipped. The memberMap packet now relays the sender's
 *    engine-resolved area path; a small alias table covers old peers.
 */

const WM_ICON = { x: 280, y: 424, w: 16, h: 11 };
const ROOM_ICON = { x: 280, y: 424, w: 16, h: 11 };
/** Vanilla active-area pointer: the white 3x3 triangle sc.AreaButton draws at
 * button-local (1,2) next to the SELF head — i.e. head-local (12,10), the
 * head's bottom-right corner, pointing down-right at the area's type icon. */
const WM_PTR = { x: 304, y: 440, w: 3, h: 3 };
const WM_PTR_OFF = { x: 12, y: 10 };

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

/** Map-directory -> area-key aliases where they differ (game data, stable
 * since 1.0): "autumn.*" maps live in area "autumn-area", "heat.*" in
 * "heat-area", "bergen-trail.*" (singular) in "bergen-trails" (plural). The
 * arid-dng directory spans TWO area keys (arid-dng-1/-2) and can only be
 * resolved from the relayed area. Everything else is identity. */
const MAP_DIR_AREA_ALIAS: { [dir: string]: string } = {
	'autumn': 'autumn-area',
	'heat': 'heat-area',
	'bergen-trail': 'bergen-trails',
};

/** A member's AREA key. Map names do NOT always start with the area key
 * ("autumn.path-3-1" lives in "autumn-area"), so prefer the engine-resolved
 * area relayed with memberMap; same-instance members share our area; the
 * map-name prefix (+ alias table) is the last-resort fallback for peers whose
 * build does not relay an area yet. */
function memberArea(m: Multiplayer, name: string, map: string): string {
	try {
		const relayed = (m as any).memberAreaByName && (m as any).memberAreaByName[name];
		if (relayed) return relayed;
		if (m.playerMapByName && m.playerMapByName[name]) {
			const cur: any = (sc as any).map && (sc as any).map.currentPlayerArea;
			if (cur && cur.path) return cur.path;
		}
		const alias = MAP_DIR_AREA_ALIAS[areaPathOfMap(map)] || areaPathOfMap(map);
		const mapModel: any = (sc as any).map;
		if (mapModel && mapModel.areas && mapModel.areas[alias]) return alias;
	} catch (_) { /* ignore */ }
	return '';
}

/** Party members with a known map; self excluded; town strangers excluded. The
 * instance roster (playerMapByName) is authoritative while the member is on our
 * own instance; the cross-instance memberMap cache covers story-sync members
 * who are legitimately on another map. */
function partyMembers(m: Multiplayer): Array<{ name: string; map: string; area: string }> {
	const out: Array<{ name: string; map: string; area: string }> = [];
	try {
		const roster: string[] = Array.isArray(m.partyMembers) ? m.partyMembers : [];
		for (const name of roster) {
			if (!name || name === m.name) continue;
			const map = (m.playerMapByName && m.playerMapByName[name])
				|| (m.memberMapByName && m.memberMapByName[name])
				|| '';
			if (map) out.push({ name, map, area: memberArea(m, name, map) });
		}
	} catch (_) { /* ignore */ }
	return out;
}

/** Seed a hook's screenCoords so ig.gui keeps it current every frame (the same
 * idiom as netBadge); hover hits can then use real screen coordinates. */
function seedScreenCoords(hook: any): any {
	if (!hook) return null;
	if (!hook.screenCoords) {
		hook.screenCoords = { x: 0, y: 0, w: hook.size ? hook.size.x : 0, h: hook.size ? hook.size.y : 0, active: false, zIndex: 0 };
	}
	return hook.screenCoords;
}

/** Normalised (0..1) position of a member inside the CURRENT map, from their
 * live entity. Returns null when no live mirror exists. */
function liveNormPos(m: Multiplayer, name: string): { x: number; y: number } | null {
	try {
		const rec = m.players && m.players[name];
		const ent = rec && rec.entity;
		const g: any = (ig as any).game;
		if (!ent || !ent.coll || ent._killed || !g || !g.collision) return null;
		const cm = g.collision;
		const ts = (cm && cm.tilesize) || 16;
		if (typeof cm.width !== 'number' || cm.width <= 0) return null;
		if (typeof cm.height !== 'number' || cm.height <= 0) return null;
		const wx = ent.coll.pos.x + (ent.coll.size ? ent.coll.size.x / 2 : 8);
		const wy = ent.coll.pos.y + (ent.coll.size ? ent.coll.size.y / 2 : 8);
		return {
			x: Math.max(0, Math.min(1, wx / (cm.width * ts))),
			y: Math.max(0, Math.min(1, wy / (cm.height * ts))),
		};
	} catch (_) { return null; }
}

function drawRoomIcon(renderer: any, scr: any, alpha: number, cx: number, cy: number, name: string, centerAnchor?: boolean): void {
	const lx = Math.round(cx - ROOM_ICON.w / 2);
	// Live markers float just ABOVE their exact point; centred markers anchor
	// the head itself on the given point (the point IS where the icon sits).
	const ly = centerAnchor ? Math.round(cy - ROOM_ICON.h / 2) : Math.round(cy - ROOM_ICON.h - 6);
	renderer.addGfx(gfx, lx, ly, ROOM_ICON.x, ROOM_ICON.y, ROOM_ICON.w, ROOM_ICON.h).setAlpha(alpha);
	if (scr) {
		hits.push({
			x: scr.x + lx - 2,
			y: scr.y + ly - 2,
			w: ROOM_ICON.w + 4,
			h: ROOM_ICON.h + 4,
			name,
		});
	}
}

/** Drawn from inside sc.MapRoom.updateDrawables (AFTER the room tiles), so the
 * markers render on top of the area map. roomGui.room is the AreaRoomBounds
 * (name = dot map path, min/max in area tiles); the gui itself sits at
 * (min.x*8, min.y*8), so local (0,0) is the room's top-left corner. */
function drawAreaRoomAvatars(roomGui: any, renderer: any): void {
	try {
		const m = getMain && getMain();
		if (!m || !roomGui || !roomGui.room) return;
		// While the world map is up the area container stays alive (shrunken and
		// rotated behind the opaque world-map background); skip drawing AND hit
		// collection so no stale hover targets survive on the world map.
		const menuAny: any = (sc as any).menu;
		if (menuAny && menuAny.mapWorldmapActive) return;
		// Respect the vanilla fog of war: unexplored rooms paint no tiles, so a
		// floating marker there would leak (and look broken).
		if (!roomGui.unlocked) return;
		const room = roomGui.room;
		const here: string[] = [];
		for (const mate of partyMembers(m)) {
			if (mate.map === room.name) here.push(mate.name);
		}
		if (!here.length) return;
		const g: any = (ig as any).game;
		const sameMap = !!(g && g.mapName && g.mapName === room.name);
		const rw = Math.max(8, (room.max.x - room.min.x) * 8);
		const rh = Math.max(8, (room.max.y - room.min.y) * 8);
		const scr = seedScreenCoords(roomGui.hook);
		const alpha = (typeof roomGui.roomAlpha === 'number') ? roomGui.roomAlpha : 1;
		// Live mirrors go to their exact in-room spot; everyone else is centred
		// and fanned out horizontally so stacked markers never overlap.
		const centred: string[] = [];
		for (const name of here) {
			const pos = sameMap ? liveNormPos(m, name) : null;
			if (pos) drawRoomIcon(renderer, scr, alpha, pos.x * rw, pos.y * rh, name);
			else centred.push(name);
		}
		centred.forEach((name, i) => {
			const off = (i - (centred.length - 1) / 2) * (ROOM_ICON.w + 2);
			// One third down from the room's top edge — clear of the teleport /
			// landmark icon sitting at the room centre.
			drawRoomIcon(renderer, scr, alpha, rw / 2 + off, rh / 3, name, true);
		});
	} catch (_) { /* a map icon must never break the map draw */ }
}

function drawWorldMapAvatars(world: any, renderer: any): void {
	try {
		const m = getMain && getMain();
		const mapAny: any = (sc as any).map;
		if (!m || !world || !mapAny || !mapAny.areas) return;
		const byArea: { [area: string]: string[] } = {};
		for (const mate of partyMembers(m)) {
			const area = mate.area; // engine-resolved/aliased area key (NOT the map-name prefix)
			if (!area || !mapAny.areas[area]) continue;
			// Never draw on areas the local player hasn't unlocked yet — vanilla
			// only renders buttons for visited areas, and a floating marker on an
			// unknown region would leak it.
			if (typeof mapAny.getVisitedArea === 'function' && !mapAny.getVisitedArea(area)) continue;
			if (!byArea[area]) byArea[area] = [];
			byArea[area].push(mate.name);
		}
		const scr = seedScreenCoords(world.hook);
		const selfArea = (mapAny.currentPlayerArea && mapAny.currentPlayerArea.path) || '';
		for (const areaPath in byArea) {
			const area = mapAny.areas[areaPath];
			if (!area || !area.position) continue;
			const names = byArea[areaPath];
			// Vanilla self-marker anchor: AreaButton sits at (position.x-7,
			// position.y-8) and draws the Lea head at local (-11,-8), i.e. world
			// (position.x-18, position.y-16). Extra markers extend LEFTWARD from
			// that anchor on the SAME row (when the local player shares the area,
			// column 0 stays reserved for the vanilla self marker) and wrap to a
			// new row above when they would run off the left screen edge.
			const anchorX = area.position.x - 18;
			const anchorY = area.position.y - 16;
			const stepX = WM_ICON.w + 2;
			const stepY = WM_ICON.h + 1;
			let col = (selfArea === areaPath) ? 1 : 0;
			let row = 0;
			// The head CLOSEST to the area button (the anchor slot) carries the
			// white triangle pointer at its bottom-right, like vanilla's
			// active-area self marker. When the local player shares the area the
			// vanilla self head sits in that slot and vanilla already draws the
			// pointer — so only teammate-only areas need it here.
			let needPtr = selfArea !== areaPath;
			for (const name of names) {
				let lx = anchorX - col * stepX;
				if (lx < 2 && col > 0) { row++; col = 0; lx = anchorX; }
				lx = Math.max(2, Math.round(lx));
				const ly = Math.max(2, Math.round(anchorY - row * stepY));
				renderer.addGfx(gfx, lx, ly, WM_ICON.x, WM_ICON.y, WM_ICON.w, WM_ICON.h);
				if (needPtr) {
					renderer.addGfx(gfx, lx + WM_PTR_OFF.x, ly + WM_PTR_OFF.y, WM_PTR.x, WM_PTR.y, WM_PTR.w, WM_PTR.h);
					needPtr = false;
				}
				if (scr) {
					hits.push({
						x: scr.x + lx - 2,
						y: scr.y + ly - 2,
						w: WM_ICON.w + 4,
						h: WM_ICON.h + 4,
						name,
					});
				}
				col++;
			}
		}
	} catch (_) { /* never break the world map */ }
}

function showTooltipForMouse(prev: Hit[], mx: number, my: number): void {
	hideTooltip();
	for (const h of prev) {
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
		showTooltipForMouse(prev, mouse.x, mouse.y);
	} catch (_) { hideTooltip(); }
}

function tryInstall(): boolean {
	try {
		const Room: any = (sc as any).MapRoom;
		const World: any = (sc as any).MapWorldMap;
		if (!Room || !World || typeof Room.inject !== 'function' || typeof World.inject !== 'function') return false;
		gfx = gfx || new (ig as any).Image('media/gui/menu.png');
		if (!Room.prototype._mpTeamAvatars) {
			Room.inject({
				updateDrawables(this: any, renderer: any) {
					this.parent(renderer);
					drawAreaRoomAvatars(this, renderer);
				},
			});
			Room.prototype._mpTeamAvatars = true;
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
		if (!Room.prototype._mpTeamAvatars || !World.prototype._mpTeamAvatars) return false;
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
