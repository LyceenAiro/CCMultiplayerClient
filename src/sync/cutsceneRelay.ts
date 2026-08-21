import { Multiplayer } from '../multiplayer';

/**
 * Dungeon cutscene-trigger relay ("gather on story moment").
 *
 * In a dungeon, a floor switch / puzzle switch often arms an EventTrigger
 * cutscene (Temple Mine g/room4: FloorSwitch sets map.activateElevator ->
 * the activateElevator CUTSCENE plays). The switch state syncs via
 * puzzleSync, but the CUTSCENE only fires on clients whose own EventTrigger
 * happens to be event-ready in that window — a teammate mid-combat or with a
 * menu open never sees it, and once the switch var falls back the moment is
 * gone for them.
 *
 * This module relays the trigger START itself: the first client whose
 * EventTrigger actually fires broadcasts {map, mapId, playerPos} to the map
 * instance. Receivers on the SAME map (same block) then
 *   1. teleport their player to the triggerer's EXACT coordinates, and
 *   2. start the same cutscene locally and mark the trigger consumed.
 *
 * Scope guards keep this from ever firing on mundane events:
 *   - eventType must be CUTSCENE or COMBAT_CUTSCENE (parallel snow-toggle
 *     style events never gather the party);
 *   - triggerType must be ONCE (map._entity<id>_triggered) — per-entry
 *     (tmp.*) and ALWAYS triggers are excluded, so walking into a map never
 *     chain-teleports anyone;
 *   - the trigger must have a real startCondition — condition-less entry
 *     cutscenes fire per-player on arrival by design;
 *   - while main-story sync is active, story sync owns trigger authority and
 *     this relay stays out of the way (both directions).
 */

interface ICutsceneRelayPacket {
	map: string;
	mi: number;
	p: [number, number, number];
	from?: string;
}

export interface ICutsceneRelay {
	install(): void;
	onRelay(data: ICutsceneRelayPacket): void;
}

let shared: CutsceneRelay | null = null;

export function installCutsceneRelay(getMain: () => Multiplayer | undefined): ICutsceneRelay {
	if (!shared) shared = new CutsceneRelay(getMain);
	return shared;
}

class CutsceneRelay implements ICutsceneRelay {
	private installed = false;
	/** True while WE start a relayed event locally — the sender hook must not
	 * re-broadcast it (the relayed start never touches EventTrigger.update, but
	 * keep the guard cheap and absolute). */
	private applying = false;

	constructor(private getMain: () => Multiplayer | undefined) { }

	public install(): void {
		if (this.installed) return;
		this.installed = true;
		try {
			const ET: any = (ig.ENTITY as any).EventTrigger;
			if (!ET || typeof ET.inject !== 'function') return;
			const self = this;
			ET.inject({
				init: function (this: any, a: any, b: any, c: any, e: any) {
					this.parent(a, b, c, e);
					// Keep the raw settings so a relayed start can rebuild the
					// event even when this client's load-condition skipped it.
					try { this._mpCsSettings = e ? JSON.parse(JSON.stringify(e)) : null; }
					catch (_) { this._mpCsSettings = null; }
				},
				update: function (this: any) {
					let was = false;
					try { was = !!(this.eventCall && this.eventCall.isRunning()); } catch (_) { /* ignore */ }
					this.parent();
					try {
						const now = !!(this.eventCall && this.eventCall.isRunning());
						if (!was && now) self.onLocalTriggerStart(this);
					} catch (_) { /* ignore */ }
				},
			});
			console.log('[cutscenerelay] hooks installed');
		} catch (e) { console.warn('[cutscenerelay] install failed', e); }
	}

	private storySyncActive(): boolean {
		try {
			const ctl: any = (window as any).__mpStory;
			return !!(ctl && typeof ctl.isStorySyncActive === 'function' && ctl.isStorySyncActive());
		} catch (_) { return false; }
	}

	/** A trigger qualifies for relay only when it is a persistent one-shot
	 * story cutscene gated by a real condition (see module header). */
	private qualifies(trig: any): boolean {
		try {
			if (!trig || trig._killed) return false;
			const EVT: any = (ig as any).EVENT_TYPE || {};
			if (trig.eventType !== EVT.CUTSCENE && trig.eventType !== EVT.COMBAT_CUTSCENE) return false;
			if (typeof trig.triggerVar !== 'string' || trig.triggerVar.indexOf('map._entity') !== 0) return false;
			const cond = trig.startCondition;
			if (!cond || typeof cond.condition !== 'string' || !cond.condition.trim()) return false;
			return true;
		} catch (_) { return false; }
	}

	private onLocalTriggerStart(trig: any): void {
		try {
			if (this.applying) return;
			if (this.storySyncActive()) return; // story sync owns trigger authority
			if (!this.qualifies(trig)) return;
			const m: any = this.getMain();
			const conn: any = m && m.connection;
			if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return;
			if (typeof conn.sendCutsceneTrigger !== 'function') return;
			const me = m && m.name;
			const members: string[] = (m && m.partyMembers) || [];
			let hasOther = false;
			for (const n of members) { if (n && n !== me) { hasOther = true; break; } }
			if (!hasOther) return;
			const player: any = ig.game && ig.game.playerEntity;
			if (!player || !player.coll) return;
			const map: string = (ig.game as any).mapName || '';
			const mi = trig.mapId || 0;
			if (!map || !mi) return;
			conn.sendCutsceneTrigger(map, mi, [
				Math.round(player.coll.pos.x),
				Math.round(player.coll.pos.y),
				Math.round(player.coll.pos.z),
			]);
			console.log('[cutscenerelay] relayed trigger map=' + map + ' mi=' + mi
				+ ' name=' + (trig.name || '(none)'));
		} catch (_) { /* never break the local cutscene */ }
	}

	public onRelay(data: ICutsceneRelayPacket): void {
		try {
			if (!data || typeof data.map !== 'string' || typeof data.mi !== 'number') return;
			if (!Array.isArray(data.p) || data.p.length !== 3) return;
			if (this.storySyncActive()) return;
			const g: any = ig.game;
			if (!g || !g.playerEntity || g.isTeleporting()) return;
			if ((g.mapName || '') !== data.map) return; // different block — not for us
			if (typeof g.isEventStartReady === 'function' && !g.isEventStartReady()) return;
			const trig = this.findTrigger(data.mi);
			if (!trig) return;
			// We already consumed it (we were standing in the zone ourselves, or
			// saw it in an earlier session) — no teleport, no replay.
			if (trig.triggerVar && ig.vars.get(trig.triggerVar)) return;
			if (trig.eventCall && trig.eventCall.isRunning()) return;
			const ev = this.eventOf(trig);
			if (!ev) {
				console.warn('[cutscenerelay] no event object for trigger mi=' + data.mi);
				return;
			}
			// 1) gather: jump to the triggerer's exact coordinates.
			try { g.playerEntity.setPos(data.p[0], data.p[1], data.p[2]); } catch (_) { /* ignore */ }
			// 2) start the same cutscene locally and mark the trigger consumed.
			this.applying = true;
			try {
				(sc as any).Cutscene.startEvent(trig.eventType, ev);
				if (trig.triggerVar) { try { ig.vars.set(trig.triggerVar, true); } catch (_) { /* ignore */ } }
				console.log('[cutscenerelay] started relayed trigger mi=' + data.mi
					+ ' from=' + (data.from || '?'));
			} finally { this.applying = false; }
		} catch (e) { console.warn('[cutscenerelay] relay failed', e); }
	}

	private findTrigger(mi: number): any {
		try {
			const ET: any = (ig.ENTITY as any).EventTrigger;
			const list: any[] = (ig.game as any).entities || [];
			for (const e of list) {
				if (e && !e._killed && ET && e instanceof ET && e.mapId === mi) return e;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	private eventOf(trig: any): any {
		try {
			if (trig.event) return trig.event;
			const raw = trig._mpCsSettings;
			if (raw && raw.event) return new (ig as any).Event({ name: trig.name || undefined, steps: raw.event });
		} catch (_) { /* ignore */ }
		return null;
	}
}
