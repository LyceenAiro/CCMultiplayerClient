import { IBallInfo } from '../ballInfo';
import { IConnection, IChangeMapResult, IPlayerProfile, IBotStateEntry, ILootDrop, INetQuality, NetTier } from '../connection';
import { Multiplayer, MP_VERSION } from '../multiplayer';
import { IServer } from '../server';

import type { Socket } from 'socket.io-client';

// The socket.io client library is fetched from the server at runtime (see
// `load()`), which exposes the global `io`. We can't bundle the import under
// CCLoader v2 because the mod is a classic (non-module) script.
declare const io: typeof import('socket.io-client').io;

/** Round 25: derive the badge color tier from loss % + median RTT. Loss takes
 * precedence (it's the more telling metric), then latency. Thresholds per the
 * round-23 wave-5 spec: green good; yellow >5% loss or >75ms; orange >20% loss or
 * >150ms; red >50% loss or >300ms. `ping` may be -1 (no answered probes yet) — the
 * loss thresholds alone still tier correctly. */
function computeNetTier(ping: number, lossPct: number): NetTier {
	if (lossPct > 50 || ping > 300) return 'red';
	if (lossPct > 20 || ping > 150) return 'orange';
	if (lossPct > 5 || ping > 75) return 'yellow';
	return 'green';
}

export class SocketIoConnector implements IConnection {
	private readonly PATH = 'socket.io/socket.io.js';

	private main: Multiplayer;
	private address: string;
	private socket!: Socket;

	private username?: string;
	private map?: string;
	private marker?: string | null;
	private setHost?: (isHost: boolean) => void;

	// ---- Round 16: client-side latency probe ----
	// The server echoes our `mpPing {t: Date.now()}` payload back verbatim
	// (rate-limited 10/s per socket; we send 1/s), so RTT is trivially measurable.
	private pingTimer: any = null;
	/** Latest smoothed round-trip latency to the server in ms; -1 when unknown
	 * (never connected / disconnected). Read by the options tag display. */
	public pingMs = -1;

	// ---- Round 25: netPing/netPong quality probe ----
	// Separate from the mpPing echo (which folds into pingMs): netPing carries a
	// monotonically-increasing seq, so a pong maps unambiguously to its probe (a
	// duplicate/stale mpPing echo can't be misattributed). The server echoes
	// {t, seq} verbatim as netPong (auth-gated, ~4/s). We keep a sliding window of
	// the last 15 probes; a probe unanswered for >2s counts LOST. getNetQuality()
	// folds the window into median RTT + loss % + a tier for the HUD badges.
	private netProbeTimer: any = null;
	private netProbeSeq = 0;
	private netProbes: Array<{ seq: number, t: number, got: boolean, rtt?: number }> = [];

	// ---- Round 21: network debug stats ----
	// The socket.io engine emits 'packetCreate' (outgoing) and 'packet' (incoming);
	// each 'message' packet's payload length approximates its wire size. We count
	// bits per second + all-time totals, plus a packet-loss % from the mpPing probe
	// window (last 10 probes). Read by the options HUD overlay via getNetStats().
	/** Tracks engine objects already hooked so a reconnect (new engine) re-hooks. */
	private _engStatsHooked: WeakSet<object> = new WeakSet();
	/** 1s window that folds the accumulators into the readable per-second rates. */
	private statsTimer: any = null;
	private upBitsAccum = 0;
	private downBitsAccum = 0;
	private upBitsSec = 0;
	private downBitsSec = 0;
	private upBitsTotal = 0;
	private downBitsTotal = 0;
	/** Rolling last-10-probe window for the packet-loss %. Entries are marked got on
	 * the matching mpPing echo; the window is capped so only recent probes count. */
	private probeWindow: Array<{ t: number, got: boolean }> = [];
	/** Round 22 (EXTRA 2): entityState block counts for the observed server tick rate
	 * (blocks/sec — whichever direction is active: the host sends, the member receives).
	 * Folded into `tickRate` by the same 1s window as the bit rates, zeroed on
	 * disconnect. Read by the network-debug HUD overlay via getNetStats(). */
	private upBlockAccum = 0;
	private downBlockAccum = 0;
	private tickRate = 0;
	// ITEM 3: the host streams TWO entityState cadences (a fixed 15Hz BASE stream for
	// idle enemies + the option-driven HOSTILE stream). The connector can't tell which
	// stream a block belongs to, so instead of summing them (which double-counts) we
	// expose the CONFIGURED hostile cadence directly and report the 15Hz base stream
	// separately — the HUD then shows the real per-stream rates, never 60+15=75.
	private hostileTickRate = 0;
	private readonly BASE_TICK_HZ = 15;
	/** Item 3: netSync calls this with the option's hostile block cadence (Hz) so the
	 * HUD can display the true hostile tick instead of a double-counted sum. */
	public setHostileTickHz(hz: number): void {
		this.hostileTickRate = (isFinite(hz) && hz > 0) ? hz : 0;
	}

	// ---- Round 23: streamed save DOWNLOAD (saveDownload parts) ----
	// The server no longer embeds the save in handshakeResponse; it streams it in
	// 8192-char parts paced at config.saveDownloadKbS right after the handshake.
	// The internal socket handler (registered in open()) reassembles parts from the
	// moment they arrive (even before multiplayer wires the callback — a slow
	// listener must not lose parts), and fires the registered callback ONCE.
	private saveDownloadCb: ((result: { slot: string, data: string } | null) => void) | null = null;
	/** Round 24: registered by the multiplayer layer (onceGameReady) so its restore
	 * watchdog is ACTIVITY-based — every part that arrives during reassembly resets
	 * the "15s of no parts" idle window (see onSaveDownloadProgress). Round 27: the
	 * callback now also receives {received, total, bytes} so the blocking download
	 * overlay can render a real progress bar. */
	private saveDownloadProgressCb: ((progress: { received: number, total: number, bytes: number }) => void) | null = null;
	private saveDownloadStream: { slot: string, total: number, parts: string[], fired: boolean } | null = null;
	/** Round 27: true once the save-download stream fired its completion callback
	 * (or the server signaled "no save" via total:0) — lets launchGame skip its
	 * blocking overlay when the download settled before the game even started. */
	private _saveDownloadFired = false;
	/** Max number of saveDownload parts we accept (sanity cap — the server splits a
	 * save into 8192-char parts and never exceeds this for a real save). */
	private readonly SAVE_DOWNLOAD_MAX_TOTAL = 256;

	constructor(main: Multiplayer, server: IServer) {
		this.main = main;
		this.address = server.type + '://' + server.hostname + ':' + server.port + '/';
	}

	public load(): Promise<void> {
		// Pull the matching socket.io client from the server itself, so client
		// and server library versions always agree.
		return simplify.loadScript(this.address + this.PATH);
	}

	public async open(hostname: string, port: number, type?: string): Promise<void> {
		this.socket = io(type + '://' + hostname + ':' + port + '/', {
			transports: ['websocket'],
		});

		// Round 21: hook the socket.io engine's packet events for the network debug
		// stats. The engine is only reachable after connect and is swapped on every
		// reconnect, so hook it from a persistent 'connect' listener (idempotent per
		// engine object — see hookEngineStats).
		this.socket.on('connect', () => { try { this.hookEngineStats(); } catch (_) { /* ignore */ } });

		// Round 23: reassemble the streamed save DOWNLOAD (saveDownload parts). The
		// server emits these right after handshakeResponse, paced at 200 kb/s; this
		// handler runs from the moment the socket exists so no parts are lost while
		// the multiplayer layer wires its onSaveDownload callback. Fires the callback
		// ONCE when the last part arrives (or with null when the server signals "no
		// save" via total:0). See fireSaveDownload / onSaveDownload.
		this.socket.on('saveDownload', (data: any) => {
			try { this.consumeSaveDownload(data); } catch (_) { /* never break the socket */ }
		});

		// Round 16: the server echoes our `mpPing {t: Date.now()}` back; measure
		// the round-trip. Guarded (finite, >=0, <5s) so a skewed clock or a late
		// stale echo can't poison the display; an EMA (α≈0.3) keeps it from jitter.
		this.socket.on('mpPing', (data: any) => {
			if (!data || typeof data.t !== 'number') return;
			// Round 21: mark the matching probe as received (network-debug loss %).
			try {
				for (let i = 0; i < this.probeWindow.length; i++) {
					if (this.probeWindow[i].t === data.t) { this.probeWindow[i].got = true; break; }
				}
			} catch (_) { /* ignore */ }
			const rtt = Date.now() - data.t;
			if (!isFinite(rtt) || rtt < 0 || rtt > 5000) return;
			this.pingMs = this.pingMs < 0 ? Math.round(rtt) : Math.round(this.pingMs * 0.7 + rtt * 0.3);
		});

		// Round 25: the server echoes our `netPing {t, seq}` back as `netPong`
		// (both validated integers). Match it to the in-flight probe by seq and
		// record the round-trip; the sliding window + loss % are folded by
		// getNetQuality(). Registered here (like mpPing) so a reconnect reuses the
		// same socket without stacking a second handler.
		this.socket.on('netPong', (data: any) => {
			if (!data || typeof data.t !== 'number' || typeof data.seq !== 'number') return;
			const w = this.netProbes;
			for (let i = 0; i < w.length; i++) {
				if (w[i].seq === data.seq && !w[i].got) {
					w[i].got = true;
					const rtt = Date.now() - w[i].t;
					if (isFinite(rtt) && rtt >= 0 && rtt <= 5000) w[i].rtt = Math.round(rtt);
					break;
				}
			}
		});

		// Round 35 (void-creature): the server used to push mpForceStripNextLoad when it
		// made this client the lone host of a fresh party instance (a party member crossed
		// a map exit into `party:<pid>:<map>` ahead of the leader). The old fear was that
		// such a lone host would spawn "enemies nobody else can see". That reasoning is
		// STALE under the current block sync (USE_NET_SYNC): the lone host IS the
		// authoritative host of that instance and streams every live enemy over the
		// entityState block, so a teammate who crosses in later receives them all as typed
		// puppets (spawnTypedPuppet fallback) — they are NOT invisible. Force-stripping
		// here instead left the whole map empty until the leader followed, which is wrong:
		// whether a room has monsters should depend only on whether you're the instance
		// host, never on the leader. The server no longer emits this event; this handler
		// is kept only as a harmless no-op listener so an older server can't wedge the
		// client if it still sends it (we deliberately do NOT set the flag).
		this.socket.on('mpForceStripNextLoad', (data: any) => {
			try {
				console.log('[multiplayer] ignoring stale mpForceStripNextLoad from server'
					+ (data && data.map ? ' (' + data.map + ')' : '') + ' — instance host keeps its enemies');
			} catch (_) { /* never break the socket */ }
		});

		this.socket.on('reconnect', async () => {
			if (this.username && this.setHost) {
				let result;
				try {
					result = await this.identify(this.username);
				} catch (e) {
					// Re-identify failed (server bounced mid-handshake, or rejected us
					// because our old session was still online). Without this we'd stay
					// in-game but offline on the server with no fallback — treat it as a
					// lost connection so the grace-then-title path runs.
					console.warn('[multiplayer] re-identify after reconnect failed', e);
					this.main.onConnectionLost();
					return;
				}
				if (result && result.success) {
					this.setHost(result.host);

					// Re-join our map instance even when there's no marker: a position
					// teleport (or any teleport whose marker didn't resolve) leaves
					// this.marker null, and skipping changeMap here stranded us in the
					// server's old instance (stale mirrors, wrong host). changeMap
					// accepts a null marker, so only require the map name.
					if (this.map) {
						// Re-derive the area from the map name (currentPlayerArea may
						// not be reliable during reconnect).
						const idx = this.map.indexOf('.');
						const areaPath = idx === -1 ? this.map : this.map.substring(0, idx);
						const area = (sc.map as any).areas[areaPath];
						const areaType = area && typeof area.areaType === 'number' ? area.areaType : 1;
						// Round 19: the server cleared a PVP-duel isolation override on
						// disconnect. If we were isolated (or a duel is still running),
						// re-assert isolated:true so the duel stays in its own solo
						// instance after the rejoin.
						const pvp: any = (sc as any).pvp;
						const duelStillOn = this.main.isolated === true || !!(pvp && pvp.isActive && pvp.isActive());
						this.changeMap(this.map, this.marker ?? null, areaPath, areaType, duelStillOn ? true : undefined);
					}
				}
			}
		});

		// Detect the server going away. socket.io auto-reconnects forever in the
		// background; we give it a short grace window (in case the server is just
		// restarting) and then drop the player back to the title screen instead of
		// leaving them stranded in a dead session.
		this.socket.on('disconnect', (reason: string) => {
			// Round 16: offline for any reason — stop pinging and drop the stale
			// RTT so the tag display reverts to the plain name. Restarts on the
			// reconnect path because identify() runs again (startPing).
			this.stopPing();
			// Round 21: offline for any reason — stop the debug stats and zero every
			// counter (the HUD overlay shows nothing while disconnected).
			this.stopNetStats();
			// Round 25: offline for any reason — stop the netPing quality probe and
			// drop the window (the badges hide while disconnected).
			this.stopNetProbe();
			// 'io server disconnect' = server told us to go away; others = transport lost.
			if (reason === 'io client disconnect') return; // we closed it ourselves
			this.main.onConnectionLost();
		});

		await new Promise<void>((resolve, reject) => {
			if (!this.socket) {
				return reject(new Error('[multiplayer] No socket created.'));
			}

			if (this.socket.connected) {
				return resolve();
			}

			this.socket.once('connect', () => {
				resolve();
			});

			// Surface the real reason (CORS, server down, bad port, ...) instead of
			// an empty rejection, so the console shows something actionable.
			this.socket.once('connect_error', (err: Error) => {
				reject(new Error('[multiplayer] Could not connect to ' + this.address + ' — ' + (err && err.message ? err.message : 'connection failed')));
			});
		});
	}

	public isReady(): boolean {
		return !!this.socket;
	}

	public isOpen(): boolean {
		if (!this.socket) {
			return false;
		}

		return this.socket.connected;
	}

	public identify(username: string): Promise<IIdentifyResult> {
		return new Promise<IIdentifyResult>((resolve, reject) => {
			this.socket.once('handshakeResponse', (data: {
                success: boolean,
                username: string,
                host: boolean,
                mapName: string | null,
                save?: { slot: string, data: string } | null,
                failed?: string,
                // Round 17: version-mismatch rejections carry the human-readable
                // reason in `message` (the older rejections use `failed`).
                message?: string,
                hpScale?: number,
            }) => {
				this.username = username;

				if (data.success) {
					resolve({success: data.success, host: data.host, mapName: data.mapName, save: data.save ?? null, hpScale: data.hpScale});
					// Round 16: start the 1/s latency probe once authenticated. This
					// also covers reconnects (identify runs again in the reconnect
					// handler; stopPing cleared the previous timer on disconnect).
					this.startPing();
					// Round 25: start the 1/s netPing quality probe alongside it
					// (same reconnect story; stopNetProbe cleared the timer on
					// disconnect).
					this.startNetProbe();
				} else {
					// The server rejects with {failed: "..."} (older style) or
					// {message: "..."} (round-17 version mismatches) — no `success`.
					reject(new Error('[multiplayer] Login rejected: ' + (data.failed || data.message || 'unknown reason')));
				}
			});

			this.socket.emit('handshake', {
				username,
				// Round 17: send the MOD version (not the game version). The server
				// rejects the connection unless it matches its own version — on the
				// first connect AND every reconnect (both re-run this handshake).
				version: MP_VERSION,
				client: 'multiplayer',
			});
		});
	}

	// ---- Round 16: latency probe ----

	/** Starts the 1/s mpPing probe (idempotent). Each tick emits only while the
	 * socket is actually connected; the server echoes the payload back and the
	 * mpPing handler above folds it into pingMs. */
	private startPing(): void {
		if (this.pingTimer) return;
		this.pingTimer = setInterval(() => {
			if (!this.isOpen() || !this.socket) return;
			const now = Date.now();
			this.socket.emit('mpPing', { t: now });
			// Round 21: record the probe for the packet-loss window (last 10 probes).
			this.probeWindow.push({ t: now, got: false });
			if (this.probeWindow.length > 10) this.probeWindow.shift();
			// Round 17: report our smoothed RTT to the server once per second (same
			// cadence as the probe). The server relays it to the instance as
			// `playerPing` so every player there can show our ping on their name tag.
			// Only when we have a valid sample (pingMs >= 0).
			if (this.pingMs >= 0) this.socket.emit('pingReport', { ms: this.pingMs });
		}, 1000);
	}

	/** Stops the probe and clears the last RTT sample (offline = unknown). */
	private stopPing(): void {
		if (this.pingTimer) {
			try { clearInterval(this.pingTimer); } catch (_) { /* ignore */ }
			this.pingTimer = null;
		}
		this.pingMs = -1;
		this.probeWindow = [];
	}

	// ---- Round 25: netPing/netPong quality probe ----

	/** Starts the 1/s netPing probe (idempotent). Each tick emits only while the
	 * socket is actually connected; the netPong handler above matches the echo by
	 * seq. The window is capped to the most recent 15 probes; a probe whose 2s
	 * answer window has elapsed without a pong counts LOST in getNetQuality(). */
	private startNetProbe(): void {
		if (this.netProbeTimer) return;
		// Z2: reset the sliding window BEFORE a fresh probe session — a session after
		// an outage must not inherit stale loss. netProbeSeq stays monotonic across
		// sessions so a stale pong from the old session can never be misattributed to
		// a new probe (getNetQuality matches pongs by seq inside the window).
		this.netProbes = [];
		this.netProbeTimer = setInterval(() => {
			if (!this.isOpen() || !this.socket) return;
			const now = Date.now();
			const seq = this.netProbeSeq++;
			this.socket.emit('netPing', { t: now, seq });
			this.netProbes.push({ seq, t: now, got: false });
			if (this.netProbes.length > 15) this.netProbes.shift();
		}, 1000);
	}

	/** Stops the probe and drops the window (offline = unknown quality). Clears the
	 * interval id so a reconnect's startNetProbe begins fresh; netProbeSeq is kept
	 * monotonic (never reset) so a stale pong can't collide with a new probe's seq. */
	private stopNetProbe(): void {
		if (this.netProbeTimer) {
			try { clearInterval(this.netProbeTimer); } catch (_) { /* ignore */ }
			this.netProbeTimer = null;
		}
		this.netProbes = [];
	}

	// ---- Round 21: network debug stats ----

	/** Count one engine packet toward the debug stats. `out` = packetCreate
	 * (outgoing), else `packet` (incoming). Only 'message' packets with a payload
	 * are counted: bits = (String(p.data).length + 1) * 8 (the engine's wire payload
	 * is a JSON string; +1 approximates the message-type byte). */
	private countPacket(p: any, out: boolean): void {
		if (!p) return;
		const bits = (p.type === 'message' && p.data != null) ? (String(p.data).length + 1) * 8 : 0;
		if (bits <= 0) return;
		if (out) { this.upBitsAccum += bits; this.upBitsTotal += bits; }
		else { this.downBitsAccum += bits; this.downBitsTotal += bits; }
	}

	/** Hook the current socket.io engine's packet events (idempotent per engine
	 * object — the engine is swapped on every reconnect, so this is re-run from the
	 * 'connect' listener). Typedefs don't know the engine internals, so everything
	 * is `any`-cast and try/catch'd. */
	private hookEngineStats(): void {
		try {
			const sock: any = this.socket;
			const eng: any = sock && sock.io && sock.io.engine;
			if (!eng) return;
			if (this._engStatsHooked.has(eng)) return;
			this._engStatsHooked.add(eng);
			eng.on('packetCreate', (p: any) => { try { this.countPacket(p, true); } catch (_) { /* ignore */ } });
			eng.on('packet', (p: any) => { try { this.countPacket(p, false); } catch (_) { /* ignore */ } });
			this.startNetStats();
		} catch (_) { /* engine internals are untyped — never break connect */ }
	}

	/** 1s window: fold the accumulated bits into the readable per-second rates. */
	private startNetStats(): void {
		if (this.statsTimer) return;
		this.statsTimer = setInterval(() => {
			try {
				this.upBitsSec = this.upBitsAccum;
				this.downBitsSec = this.downBitsAccum;
				this.upBitsAccum = 0;
				this.downBitsAccum = 0;
				// Round 22 (EXTRA 2): fold the entityState block counts into the observed
				// server tick rate (blocks/sec). Host side sends, member side receives —
				// the inactive direction simply contributes 0.
				// ITEM 3 FIX: the old combined `tickRate` double-counted the two streams
				// the host now sends (the fixed 15Hz BASE stream + the option-driven
				// HOSTILE stream), so at a 60Hz hostile setting it read ~75 (60+15) — a
				// display artifact, not an over-send. We now keep the combined count as an
				// internal total, but the HUD derives the per-stream rates from
				// hostileTickRate (the option) + BASE_TICK_HZ (fixed 15) instead.
				this.tickRate = this.upBlockAccum + this.downBlockAccum;
				this.upBlockAccum = 0;
				this.downBlockAccum = 0;
			} catch (_) { /* ignore */ }
		}, 1000);
	}

	/** Stop measuring and zero every counter (offline = all-zero display). */
	private stopNetStats(): void {
		if (this.statsTimer) {
			try { clearInterval(this.statsTimer); } catch (_) { /* ignore */ }
			this.statsTimer = null;
		}
		this.upBitsAccum = 0; this.downBitsAccum = 0;
		this.upBitsSec = 0; this.downBitsSec = 0;
		this.upBitsTotal = 0; this.downBitsTotal = 0;
		this.probeWindow = [];
		this.upBlockAccum = 0; this.downBlockAccum = 0;
		this.tickRate = 0;
		this.hostileTickRate = 0;
	}

	/** Round 21: current network debug stats for the HUD overlay. Loss % is over the
	 * last 10 mpPing probes (0 when none sent yet). Round 22 (EXTRA 2): `tickRate` is
	 * the observed entityState block rate (blocks/sec; host sends, member receives).
	 * ITEM 3: `tickRateHostile` = the option's configured hostile cadence (Hz) so the
	 * HUD reports the REAL active tick, and `tickRateBase` = the fixed 15Hz idle stream.
	 * Displaying the summed `tickRate` would double-count both streams (60+15=75). */
	public getNetStats(): { upBitsSec: number; downBitsSec: number; lossPct: number; upBitsTotal: number; downBitsTotal: number; tickRate: number; tickRateHostile: number; tickRateBase: number } {
		const w = this.probeWindow;
		let lossPct = 0;
		if (w.length) {
			let got = 0;
			for (let i = 0; i < w.length; i++) if (w[i].got) got++;
			lossPct = ((w.length - got) / w.length) * 100;
		}
		return {
			upBitsSec: this.upBitsSec,
			downBitsSec: this.downBitsSec,
			lossPct,
			upBitsTotal: this.upBitsTotal,
			downBitsTotal: this.downBitsTotal,
			tickRate: this.tickRate,
			tickRateHostile: this.hostileTickRate,
			tickRateBase: this.BASE_TICK_HZ,
		};
	}

	// ---- Round 25: netPing/netPong quality ----

	/** Send one netPing probe {t, seq} (exposed for completeness; the connector's
	 * own 1/s loop uses it). */
	public netPing(t: number, seq: number): void {
		if (this.socket && this.socket.connected) this.socket.emit('netPing', { t, seq });
	}

	/** Register a netPong echo handler (t + seq echoed verbatim, both validated
	 * server-side). Only register while isReady(). */
	public onNetPong(callback: (t: number, seq: number) => void): void {
		this.socket.on('netPong', (data: any) => {
			if (data && typeof data.t === 'number' && typeof data.seq === 'number') callback(data.t, data.seq);
		});
	}

	/** Round 25: current network quality for the HUD badges. Folds the sliding
	 * netPing window: `ping` = median RTT of the answered probes (-1 when none),
	 * `lossPct` = unanswered / resolved (0..100; a probe whose 2s answer window has
	 * elapsed without a pong counts lost), `tier` = the derived color tier. `known`
	 * stays false until at least one probe has resolved — badges hide until then. */
	public getNetQuality(): INetQuality {
		const cutoff = Date.now() - 2000;
		const w = this.netProbes;
		const rtts: number[] = [];
		let resolved = 0;
		let answered = 0;
		for (let i = 0; i < w.length; i++) {
			const p = w[i];
			if (p.t > cutoff) continue; // still in flight — answer window not elapsed
			resolved++;
			if (p.got && typeof p.rtt === 'number') { answered++; rtts.push(p.rtt); }
		}
		let ping = -1;
		if (rtts.length) {
			rtts.sort((a, b) => a - b);
			const mid = Math.floor(rtts.length / 2);
			ping = rtts.length % 2 ? rtts[mid] : Math.round((rtts[mid - 1] + rtts[mid]) / 2);
		}
		const lossPct = resolved ? Math.round(((resolved - answered) / resolved) * 100) : 0;
		return { ping, lossPct, tier: computeNetTier(ping, lossPct), known: resolved > 0 };
	}
	// Serialize changeMap calls: each registers a socket.once('changeMapResponse')
	// listener, so two in flight at once would resolve BOTH promises with the FIRST
	// response (the second once-listener eats it). A leader's re-assert can overlap an
	// acceptor's regroup changeMap — chaining them guarantees 1 request : 1 response.
	private changeMapChain: Promise<any> = Promise.resolve();
	public changeMap(name: string, marker: string | null, areaPath: string, areaType: number, isolated?: boolean): Promise<IChangeMapResult> {
		const run = () => this.doChangeMap(name, marker, areaPath, areaType, isolated);
		const result = this.changeMapChain.then(run, run);
		// Keep the chain alive regardless of this call's own resolution.
		this.changeMapChain = result.catch(() => { /* swallow */ });
		return result;
	}
	private doChangeMap(name: string, marker: string | null, areaPath: string, areaType: number, isolated?: boolean): Promise<IChangeMapResult> {
		this.map = name;
		this.marker = marker;
		const pos = ig.game.playerEntity ? { x: ig.game.playerEntity.coll.pos.x, y: ig.game.playerEntity.coll.pos.y, z: ig.game.playerEntity.coll.pos.z } : { x: 0, y: 0, z: 0 };
		const payload: any = { name, marker, areaPath, areaType, pos };
		// Round 19: PVP-duel isolation — STICKY on the client. The server treats an
		// absent `isolated` as "unchanged", so an ordinary teleport/reassert while
		// main.isolated (a duel in progress) must re-send isolated:true to keep the
		// override; only the explicit exit path sends isolated:false. Present-true
		// and absent-without-isolation both map to the tri-state the server expects.
		if (isolated === true || (isolated === undefined && this.main.isolated)) {
			payload.isolated = true;
		} else if (isolated === false) {
			payload.isolated = false;
		}
		return new Promise<IChangeMapResult>((resolve) => {
			this.socket.once('changeMapResponse', (data: IChangeMapResult) => resolve(data));
			this.socket.emit('changeMap', payload);
		});
	}
	public updatePersition(position: Vec3): void {
		this.socket.emit('updatePosition', position);
	}
	public updateAnimation(face: Vec2, anim: string): void {
		this.socket.emit('updateAnimation', {face, anim});
	}
	public updateTimer(timer: number): void {
		// Must match the event the server relays ('updateAnimationTimer') — the old
		// 'updateTimer' name never reached anyone, so remote anim timers never synced.
		this.socket.emit('updateAnimationTimer', timer);
	}

	public spawnEntity(type: string, x: number, y: number, z: number, settings?: object, showEffects?: boolean): void {
		this.socket.emit('spawnEntity', {type, x, y, z, settings, showAppearEffects: showEffects});
	}
	public registerEntity(id: number, type: string, pos: Vec3, settings: object): void {
		this.socket.emit('registerEntity', {id, type, pos, settings});
	}
	public killEntity(id: number): void {
		this.socket.emit('killEntity', {id});
	}

	public throwBall(ballInfo: IBallInfo): void {
		this.socket.emit('throwBall', ballInfo);
	}

	public combatHit(hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number, monster?: boolean, perfect?: boolean, regular?: boolean, knockback?: boolean, attackType?: number }): void {
		this.socket.emit('combatHit', hit);
	}

	public partyRegroup(target?: string): void {
		this.socket.emit('partyRegroup', target ? { target } : {});
	}

	// ---- round 23 wave 4: PARTY CHAT ----
	public chat(text: string): void {
		if (!this.socket || !this.socket.connected) return;
		this.socket.emit('chat', { text });
	}
	public onChat(callback: (msg: { from: string, text: string }) => void): void {
		this.socket.on('chat', (data: any) => {
			if (data && typeof data.from === 'string' && typeof data.text === 'string') {
				callback({ from: data.from, text: data.text });
			}
		});
	}

	// Round 11: host broadcasts the native party BOTS in the roster so member
	// clients can spawn their own follower copies. Round 27 (item 2): `maps` tags
	// each bot with the HOST's current map for the off-map HUD hide/grey.
	public partyBots(bots: string[], maps?: { [botName: string]: string }): void {
		this.socket.emit('partyBots', { bots, maps: maps || {} });
	}
	public onPartyBots(callback: (bots: string[], maps?: { [botName: string]: string }) => void): void {
		this.socket.on('partyBots', (data: any) => callback((data && data.bots) || [], (data && data.maps) || undefined));
	}

	// Round 13: the party leader streams live bot state (pos/anim/hp/level); members
	// apply it to their local puppet copies.
	public botState(state: { map: string, bots: IBotStateEntry[] }): void {
		this.socket.emit('botState', state);
	}
	public onBotState(callback: (data: { map?: string, from?: string, bots: IBotStateEntry[] }) => void): void {
		this.socket.on('botState', (data: any) => callback(data));
	}

	// Round 27 (item 2): tell the party which map WE are on so off-map teammates'
	// HUD bars hide + net diamonds grey. Tiny packet, ~1/s while partied.
	public memberMap(map: string): void {
		this.socket.emit('memberMap', { map });
	}
	public onMemberMap(callback: (name: string, map: string) => void): void {
		this.socket.on('memberMap', (data: any) => {
			if (!data || typeof data.from !== 'string') return;
			callback(data.from, typeof data.map === 'string' ? data.map : '');
		});
	}

	// Round 20: GHOST CHESTS — we tell the party which chests on the current map we
	// opened. Emitting is gated on being connected AND on party size > 1 (the
	// feature is party-only; a solo player has nothing to announce and the server
	// would ignore it anyway — this just avoids the pointless packets).
	public emitChestOpened(list: Array<{ map: string, id: number }>): void {
		if (!this.socket || !this.socket.connected) return;
		const partied = !!(this.main.partyMembers && this.main.partyMembers.length > 1);
		if (!partied) return;
		this.socket.emit('chestOpened', { list: (list || []).slice(0, 128) });
	}
	/** Round 20: a party teammate opened a chest (server-relayed chestOpenedBy). */
	public onChestOpenedBy(callback: (chestKey: string, by: string) => void): void {
		this.socket.on('chestOpenedBy', (data: any) => {
			if (data && typeof data.key === 'string' && typeof data.by === 'string') {
				callback(data.key, data.by);
			}
		});
	}
	/** Round 20: the party's opened-chest snapshot for a map we just joined. */
	public onChestState(callback: (opened: { [chestKey: string]: string[] }) => void): void {
		this.socket.on('chestState', (data: any) => {
			callback((data && data.opened) || {});
		});
	}

	// Round 11: special-skill effect replay (sheet path + effect key).
	public skillFx(fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }): void {
		this.socket.emit('skillFx', fx);
	}
	public onSkillFx(callback: (player: string, fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }) => void): void {
		this.socket.on('skillFx', (data: any) => {
			if (data) callback(data.player, data);
		});
	}

	public enemyDamage(hit: { uid: number, damage: number, attacker: string, type?: number, ball?: boolean, charged?: boolean, knockback?: number, attackElement?: number, critical?: boolean }): void {
		this.socket.emit('enemyDamage', hit);
	}

	/** Round 21: a monster hit our real player LOCALLY (native damage pipeline) — report
	 * the outcome to the host for bookkeeping (same wire style as enemyDamage). */
	public emitCombatResult(hit: { uid: number, damage: number, guarded: boolean }): void {
		this.socket.emit('combatResult', hit);
	}

	/** Round 26: a counter/guard-break dramatic effect played on a SHARED enemy (uid) —
	 * relay to the instance so everyone else replays it on the same-uid entity. The
	 * server excludes the sender and rate-limits ~20/s. kind = 'counter' | 'break'. */
	public emitCombatFx(uid: number, kind: string): void {
		this.socket.emit('combatFx', { uid, kind });
	}

	/** ROUND 45 (Gap A, host origin): the host applied a member's hit to a real enemy;
	 * relay a cosmetic notice so every OTHER member replays the hurt FX on its puppet. */
	public emitEnemyHurt(hit: { uid: number, type?: number, attackElement?: number, critical?: boolean, attacker?: string }): void {
		this.socket.emit('enemyHurt', hit);
	}

	// Round 17: HOST -> all — the host's real enemy started an attack; members replay
	// it on their puppet toward the local player (member puppets no longer run local AI).
	// Round 22 (RC1): `t` = the targeted member's username (null = host/bot/unknown).
	public enemyAttack(atk: { uid: number, anim: string, t: string | null }): void {
		this.socket.emit('enemyAttack', atk);
	}

	// Round 23: HOST -> all — a host real enemy died and granted credits to the host's
	// player. Round 24 (loot fairness): the raw drop table + boosterState ride along so
	// members roll their OWN drops with their OWN stats (not the host's).
	public emitLoot(loot: { uid: number, credit: number, boosterState: number, drops: ILootDrop[] }): void {
		this.socket.emit('loot', loot);
	}

	// Round 33 (item 2b): HOST -> all — one of the host's real enemies played a sound;
	// members replay it positioned on their same-uid puppet (member puppets run no AI, so
	// they are silent without this relay).
	public emitEnemySound(s: { uid: number, path: string, volume?: number, variance?: number, loop?: boolean, global?: boolean, radius?: number, speed?: number }): void {
		this.socket.emit('enemySound', s);
	}

	// ROUND 34 (item 3): any client -> its instance — the local player's own attack sound
	// (melee swing / ball throw); every other same-instance client replays it on the mirror.
	public emitPlayerSound(s: { path: string, volume?: number, variance?: number, loop?: boolean, radius?: number, speed?: number }): void {
		this.socket.emit('playerSound', s);
	}

	// ROUND 43 (skill-release sound): any client -> its instance — the local player fired a
	// skill whose launch sound we silenced locally; every other client replays it on the mirror.
	public emitSkillSound(s: { player: string, path: string, volume?: number, variance?: number, radius?: number, speed?: number }): void {
		this.socket.emit('skillSound', s);
	}

	// ROUND 39 (item 1): any client -> its instance — the local player released a sustained
	// (looped) sound (the skill charge-up); every other client cuts its handle.
	public emitSoundStop(): void {
		this.socket.emit('soundStop', {});
	}

	public updateEntityPosition(id: number, pos: Vec3): void {
		this.socket.emit('updateEntityPosition', {id, pos});
	}
	public updateEntityAnimation(id: number, face: Vec2, anim: string): void {
		this.socket.emit('updateEntityAnimation', {id, face, anim});
	}
	public updateEntityHealth(id: number | null, health: number, maxHp?: number): void {
		this.socket.emit('updateEntityHealth', {id, hp: health, maxHp});
	}
	public updatePlayerStats(stats: { hp?: number, maxHp?: number, sp?: number, maxSp?: number }): void {
		this.socket.emit('updatePlayerStats', stats);
	}
	// ---- NEW sync system ----
	public updatePlayerState(state: any): void {
		this.socket.emit('playerState', state);
	}
	public updateEntityStateBlock(map: string, entities: any[], combat?: boolean, full?: boolean): void {
		// Round 22 (EXTRA 2): count host->member enemy blocks for the observed tick rate.
		this.upBlockAccum++;
		// Round 24: a force-full block ships f:1 (the ~1s heartbeat). Normal blocks omit
		// it so the member's full-block counter only counts genuine full-roster reports.
		const payload: any = { map, e: entities, cb: !!combat };
		if (full) payload.f = 1;
		this.socket.emit('entityState', payload);
	}
	// Round 19: cutscene-spawned monster stream (see applyCutsceneEntity). The server
	// relays it to the instance stamped with the sender as `from` (protocol.js).
	public updateCutsceneEntityBlock(state: { map: string, list: any[] }): void {
		this.socket.emit('cutsceneEntity', state);
	}
	// Round 62: host-only stream of enemy projectiles (Ball/Stone). The server relays it
	// as `projectileState` via broadcastHostState (no-op unless the sender is the instance
	// host); the payload is whitelisted server-side.
	public updateProjectileState(map: string, list: any[]): void {
		this.socket.emit('projectileState', { map, e: list });
	}
	public onPlayerState(callback: (player: string, state: any) => void): void {
		this.socket.on('playerState', (data: any) => callback(data.player, data));
	}
	public onEntityState(callback: (map: string, entities: any[], combat: boolean, full: boolean) => void): void {
		this.socket.on('entityState', (data: any) => {
			// Round 22 (EXTRA 2): count member-received enemy blocks for the tick rate.
			this.downBlockAccum++;
			callback(data.map, data.e, !!data.cb, data.f === 1);
		});
	}
	public onCutsceneEntity(callback: (from: string, data: { map: string, list: any[] }) => void): void {
		this.socket.on('cutsceneEntity', (data: any) => {
			if (!data || typeof data.map !== 'string' || !Array.isArray(data.list)) return;
			callback(data.from, data);
		});
	}
	// Round 62: enemy-projectile stream (see applyProjectileState). Host-only relay like
	// entityState; entries are the host's own projectile snaps (validated server-side).
	public onProjectileState(callback: (map: string, list: any[]) => void): void {
		this.socket.on('projectileState', (data: any) => {
			if (!data || typeof data.map !== 'string' || !Array.isArray(data.e)) return;
			callback(data.map, data.e);
		});
	}
	public updateEntityState(id: number, state: string): void {
		this.socket.emit('updateEntityState', {id, state});
	}
	public updateEntityTarget(id: number, target: string | number | null): void {
		this.socket.emit('updateEntityTarget', {id, target});
	}
	public updatePlayerProfile(profile: IPlayerProfile): void {
		this.socket.emit('updatePlayerProfile', profile);
	}

	public onSetHost(callback: (isHost: boolean, map?: string) => void): void {
		this.setHost = callback;
		this.socket.on('setHost', (data: { isHost: boolean, map?: string } | boolean) => {
			// Tolerate the legacy bare-boolean form.
			if (typeof data === 'boolean') {
				callback(data);
			} else {
				callback(data.isHost, data.map);
			}
		});
	}

	public onPlayerChangeMap(callback:
        (player: string, enters: boolean, position: Vec3, map: string, marker: string | null) => void): void {
		this.socket.on('onPlayerChangeMap', (data: any) => {
			callback(data.player, data.enters, data.position, data.map, data.marker);
		});
	}
	public onUpdatePostion(callback: (player: string, pos: Vec3) => void): void {
		this.socket.on('updatePosition', (data: any) => {
			callback(data.player, data.pos);
		});
	}
	public onUpdateAnimation(callback: (player: string, face: Vec2, anim: string) => void): void {
		this.socket.on('updateAnimation', (data: any) => {
			callback(data.player, data.face, data.anim);
		});
	}
	public onUpdateAnimationTimer(callback: (player: string, timer: number) => void): void {
		this.socket.on('updateAnimationTimer', (data: any) => {
			callback(data.player, data.timer);
		});
	}
	public onThrowBall(callback: (ballInfo: IBallInfo) => void): void {
		this.socket.on('throwBall', (data: IBallInfo) => {
			callback(data);
		});
	}
	public onCombatHit(callback: (hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number, monster?: boolean, perfect?: boolean, regular?: boolean, knockback?: boolean, attackType?: number }) => void): void {
		this.socket.on('combatHit', (data: any) => {
			callback(data);
		});
	}
	public onEnemyDamage(callback: (hit: { uid: number, damage: number, attacker: string, type?: number, ball?: boolean, charged?: boolean, knockback?: number, attackElement?: number, critical?: boolean }) => void): void {
		this.socket.on('enemyDamage', (data: any) => {
			callback(data);
		});
	}
	public onEnemyAttack(callback: (uid: number, anim: string, t: string | null) => void): void {
		this.socket.on('enemyAttack', (data: any) => {
			if (data && typeof data.uid === 'number' && typeof data.anim === 'string') {
				// Round 22 (RC1): `t` is optional/absent from old hosts — normalize to null.
				callback(data.uid, data.anim, typeof data.t === 'string' ? data.t : null);
			}
		});
	}
	/** Round 21: a member reported a monster hit it detected locally (see emitCombatResult). */
	public onCombatResult(callback: (hit: { uid: number, damage: number, guarded: boolean }) => void): void {
		this.socket.on('combatResult', (data: any) => {
			callback(data);
		});
	}
	/** Round 26: a shared enemy (uid) had a counter/guard-break FX elsewhere — replay it
	 * locally (see NetSync.replayCombatFx). kind = 'counter' | 'break'. */
	public onCombatFx(callback: (uid: number, kind: string) => void): void {
		this.socket.on('combatFx', (data: any) => {
			if (data && typeof data.uid === 'number' && typeof data.kind === 'string') {
				callback(data.uid, data.kind);
			}
		});
	}
	/** ROUND 45 (Gap A, host origin): the host relayed a member's hit on a real enemy —
	 * replay the hurt FX on our same-uid puppet (cosmetic only). */
	public onEnemyHurt(callback: (hit: { uid: number, type?: number, attackElement?: number, critical?: boolean, attacker?: string }) => void): void {
		this.socket.on('enemyHurt', (data: any) => {
			if (data && typeof data.uid === 'number') callback(data);
		});
	}
	/** Round 23: the host killed a real enemy — grant the relayed credits to our own
	 * player and roll the RAW drop table with our stats (Round 24 loot fairness).
	 * Server-relayed via broadcastHostState; data is validated server-side. */
	public onLoot(callback: (loot: { uid: number, credit: number, boosterState: number, drops: ILootDrop[] }) => void): void {
		this.socket.on('loot', (data: any) => {
			if (data && typeof data.uid === 'number' && Array.isArray(data.drops)) {
				callback(data);
			}
		});
	}
	/** Round 33 (item 2b): the host relayed an enemy sound — replay it locally (see
	 * NetSync.applyEnemySound). Server validates the payload field-by-field. */
	public onEnemySound(callback: (s: { uid: number, path: string, volume?: number, variance?: number, loop?: boolean, global?: boolean, radius?: number, speed?: number }) => void): void {
		this.socket.on('enemySound', (data: any) => {
			if (data && typeof data.uid === 'number' && typeof data.path === 'string') {
				callback(data);
			}
		});
	}
	/** ROUND 34 (item 3): a same-instance player's attack sound — replay it locally on
	 * that player's mirror (see NetSync.applyPlayerSound). Server whitelists the payload. */
	public onPlayerSound(callback: (s: { player: string, path: string, volume?: number, variance?: number, loop?: boolean, radius?: number, speed?: number }) => void): void {
		this.socket.on('playerSound', (data: any) => {
			if (data && typeof data.player === 'string' && typeof data.path === 'string') {
				callback(data);
			}
		});
	}
	/** ROUND 43 (skill-release sound): a same-instance player fired a skill's launch sound —
	 * replay it on that player's mirror (see NetSync.applySkillSound). Server whitelists it. */
	public onSkillSound(callback: (s: { player: string, path: string, volume?: number, variance?: number, radius?: number, speed?: number }) => void): void {
		this.socket.on('skillSound', (data: any) => {
			if (data && typeof data.player === 'string' && typeof data.path === 'string') {
				callback(data);
			}
		});
	}
	/** ROUND 39 (item 1): a same-instance player released a sustained sound — cut our
	 * looped handle for them (see NetSync.applySoundStop). */
	public onSoundStop(callback: (player: string) => void): void {
		this.socket.on('soundStop', (data: any) => {
			if (data && typeof data.player === 'string') callback(data.player);
		});
	}
	public onRegisterEntity(callback: (id: number, type: string, pos: Vec3, settings: object) => void): void {
		this.socket.on('registerEntity', (data: any) => {
			callback(data.id, data.type, data.pos, data.settings);
		});
	}
	public onKillEntity(callback: (id: number) => void): void {
		this.socket.on('killEntity', (data: any) => {
			callback(data.id);
		});
	}
	public onUpdateEntityPosition(callback: (id: number, pos: Vec3) => void): void {
		this.socket.on('updateEntityPosition', (data: any) => {
			callback(data.id, data.pos);
		});
	}
	public onUpdateEntityAnimation(callback: (id: number, face: Vec2, anim: string) => void): void {
		this.socket.on('updateEntityAnimation', (data: any) => {
			callback(data.id, data.face, data.anim);
		});
	}
	public onUpdateEntityState(callback: (id: number, state: string) => void): void {
		this.socket.on('updateEntityState', (data: any) => {
			callback(data.id, data.state);
		});
	}
	public onUpdateEntityTarget(callback: (id: number, target: string | number | null) => void): void {
		this.socket.on('updateEntityTarget', (data: any) => {
			callback(data.id, data.target);
		});
	}
	public onUpdateEntityHealth(callback: (id: number | string, health: number, maxHp?: number) => void): void {
		this.socket.on('updateEntityHealth', (data: any) => {
			callback(data.id, data.hp, data.maxHp);
		});
	}
	public onPlayerProfile(callback: (player: string, profile: IPlayerProfile) => void): void {
		this.socket.on('updatePlayerProfile', (data: any) => {
			callback(data.player, data.profile);
		});
	}
	public onPlayerStats(callback: (player: string, stats: { hp?: number, maxHp?: number, sp?: number, maxSp?: number }) => void): void {
		this.socket.on('updatePlayerStats', (data: any) => {
			callback(data.player, data);
		});
	}
	// Round 17: a player in our instance reported its own RTT (server-relayed
	// `playerPing`); the multiplayer instance caches it for the name-tag display.
	// Round 20: the relay also carries `isHost` (true when the reporter is the
	// map-instance host) — pass it through for the " (Host)" tag label.
	public onPlayerPing(callback: (name: string, ping: number, isHost?: boolean) => void): void {
		this.socket.on('playerPing', (data: any) => {
			if (data && typeof data.name === 'string' && typeof data.ping === 'number') callback(data.name, data.ping, !!data.isHost);
		});
	}

	// ---- social (lobby architecture) ----
	public friendAdd(name: string): void {
		this.socket.emit('friendAdd', { name });
	}
	public friendAccept(name: string): void {
		this.socket.emit('friendAccept', { name });
	}
	public friendDecline(name: string): void {
		this.socket.emit('friendDecline', { name });
	}
	public friendRemove(name: string): void {
		this.socket.emit('friendRemove', { name });
	}
	/** Round 23 wave 3: search known players by name (search-first add-friend flow). */
	public searchPlayers(query: string): void {
		this.socket.emit('searchPlayers', { query });
	}
	/** Round 23 wave 3: withdraw an outgoing friend request (requester-side decline). */
	public friendRequestWithdraw(name: string): void {
		this.socket.emit('friendRequestWithdraw', { name });
	}
	public friendList(): void {
		this.socket.emit('friendList');
	}
	public friendRequests(): void {
		this.socket.emit('friendRequests');
	}
	public partyInvite(name: string): void {
		this.socket.emit('partyInvite', { to: name });
	}
	public partyAccept(partyId: string): void {
		this.socket.emit('partyAccept', { partyId });
	}
	public partyDecline(partyId: string): void {
		this.socket.emit('partyDecline', { partyId });
	}
	public partyLeave(): void {
		this.socket.emit('partyLeave');
	}
	public partyKick(target: string): void {
		this.socket.emit('partyKick', { target });
	}
	public saveUpload(slot: string, data: string): void {
		this.socket.emit('saveUpload', { slot, data });
	}
	/** Round 23: emit one chunked save-upload part (see saveUploadQueue). The server
	 * reassembles parts in order and confirms with saveSaved when the stream ends. */
	public saveChunk(chunk: { gen: number, slot: string, total: number, seq: number, part: string, reason: string }): void {
		this.socket.emit('saveChunk', chunk);
	}

	// ---- Round 23: streamed save DOWNLOAD ----

	/** Reassemble one saveDownload part. Order-validated (seq must equal the parts
	 * count received so far) and capped (total ≤ SAVE_DOWNLOAD_MAX_TOTAL). Fires the
	 * registered callback once the LAST part arrives. */
	private consumeSaveDownload(data: any): void {
		if (!data || typeof data.slot !== 'string' || !data.slot) return;
		// total:0 is the server's "no save" signal — deliver null once.
		if (data.total === 0) {
			this.saveDownloadStream = { slot: data.slot, total: 0, parts: [], fired: true };
			this.fireSaveDownload(null);
			return;
		}
		const total = Number(data.total);
		const seq = Number(data.seq);
		if (!Number.isInteger(total) || total < 1 || total > this.SAVE_DOWNLOAD_MAX_TOTAL) return;
		if (!Number.isInteger(seq) || seq < 0) return;
		if (typeof data.part !== 'string') return;
		const st = this.saveDownloadStream;
		// A stream for a different slot/total (or already-fired) starts a fresh one.
		if (!st || st.slot !== data.slot || st.total !== total || st.fired) {
			this.saveDownloadStream = { slot: data.slot, total, parts: [], fired: false };
		}
		const cur = this.saveDownloadStream as { slot: string, total: number, parts: string[], fired: boolean };
		if (cur.total === 0) return;
		// Out-of-order part (corrupt stream) — drop it; the client's 15s restore
		// timeout falls back to starting fresh rather than restoring a bad save.
		if (seq !== cur.parts.length) return;
		cur.parts.push(data.part);
		// Round 24: every valid part resets the multiplayer layer's restore watchdog
		// (activity-based "15s of no parts", not a flat timer from game start).
		// Round 27: the callback now carries reassembly progress so the blocking
		// download overlay can render a real bar (parts + reassembled chars).
		if (this.saveDownloadProgressCb) {
			try {
				this.saveDownloadProgressCb({
					received: cur.parts.length,
					total: cur.total,
					bytes: cur.parts.reduce((acc: number, p: string) => acc + p.length, 0),
				});
			} catch (_) { /* ignore */ }
		}
		if (cur.parts.length === cur.total) {
			cur.fired = true;
			this.fireSaveDownload({ slot: cur.slot, data: cur.parts.join('') });
		}
	}

	/** Deliver a completed download to the registered callback exactly once. */
	private fireSaveDownload(result: { slot: string, data: string } | null): void {
		// Round 27: the stream is settled regardless of whether anyone listens —
		// launchGame reads this to skip its blocking overlay for already-settled streams.
		this._saveDownloadFired = true;
		if (!this.saveDownloadCb) return;
		const cb = this.saveDownloadCb;
		this.saveDownloadCb = null;
		try { cb(result); } catch (_) { /* ignore */ }
	}

	/** Round 23: register the save-download completion callback. Fires ONCE with the
	 * full reassembled save string, or null when the server has no save. If the
	 * download already completed before this registration (fast stream / slow
	 * listener), the buffered result is delivered immediately. */
	public onSaveDownload(callback: (result: { slot: string, data: string } | null) => void): void {
		this.saveDownloadCb = callback;
		const st = this.saveDownloadStream;
		if (st && st.fired) {
			this.saveDownloadStream = null;
			this.fireSaveDownload(st.total === 0 ? null : { slot: st.slot, data: st.parts.join('') });
		}
	}

	/** Round 24: register a callback fired for EVERY valid save-download part the
	 * connector appends while reassembling (before the stream completes). Lets the
	 * multiplayer layer arm an ACTIVITY-based restore watchdog — "give up only after
	 * 15s with NO new parts" — instead of a flat timer from game start, which
	 * abandoned a large-but-valid save that streamed slower than the window.
	 * Round 27: the callback argument carries reassembly progress ({received, total,
	 * bytes}) so the blocking download overlay can render a real progress bar. */
	public onSaveDownloadProgress(callback: (progress: { received: number, total: number, bytes: number }) => void): void {
		this.saveDownloadProgressCb = callback;
	}

	/** Round 27: true once the save-download stream has completed (or the server
	 * signaled "no save" via total:0) — the multiplayer layer skips its blocking
	 * overlay when the download already settled before launchGame ran. */
	public get saveDownloadSettled(): boolean { return this._saveDownloadFired; }

	/** Round 23: a save upload finished persisting on the server — show the toast. */
	public onSaveSaved(callback: (slot: string, bytes: number) => void): void {
		this.socket.on('saveSaved', (data: any) => {
			if (data && typeof data.slot === 'string') callback(data.slot, Number(data.bytes) || 0);
		});
	}

	/** Round 27 (item 5): the server dropped/rejected a save upload — resolve the
	 * exit-to-title upload dialog as FAILED so the player exits without the full wait. */
	public onSaveFailed(callback: (slot: string, reason: string) => void): void {
		this.socket.on('saveFailed', (data: any) => {
			if (data && typeof data.slot === 'string') callback(data.slot, String(data.reason || ''));
		});
	}

	public logout(): void {
		this.socket.emit('logout');
	}

	// ---- lobby queries (Social-menu "房间玩家" tab + online counter) ----
	public roomPlayers(): void {
		this.socket.emit('roomPlayers');
	}
	public onlineCount(): void {
		this.socket.emit('onlineCount');
	}

	public onPresence(callback: (player: string, online: boolean) => void): void {
		this.socket.on('presence', (data: any) => callback(data.player, data.online));
	}
	public onPartyUpdate(callback: (party: { partyId: string, leader: string, members: string[], lastLeft?: { name: string, reason: string } } | null) => void): void {
		this.socket.on('partyUpdate', (data: any) => callback(data));
	}
	public onPartyInvite(callback: (from: string, partyId: string) => void): void {
		this.socket.on('partyInvite', (data: any) => callback(data.from, data.partyId));
	}
	public onPartyMove(callback: (data: { leader?: string, map?: string, pos?: Vec3 }) => void): void {
		this.socket.on('partyMove', (data: any) => callback(data));
	}
	public onPartyReSync(callback: () => void): void {
		this.socket.on('partyReSync', () => callback());
	}
	public onFriendList(callback: (friends: Array<{ name: string, online: boolean }>) => void): void {
		this.socket.on('friendList', (data: any) => callback(data.friends));
	}
	public onFriendActionResult(callback: (result: any) => void): void {
		this.socket.on('friendActionResult', (data: any) => callback(data));
	}
	public onFriendRequest(callback: (from: string) => void): void {
		this.socket.on('friendRequest', (data: any) => callback(data.from));
	}
	public onFriendRequests(callback: (requests: {
		incoming: Array<{ name: string, online: boolean }>,
		outgoing: Array<{ name: string, online: boolean }>,
	}) => void): void {
		this.socket.on('friendRequests', (data: any) => callback(data.requests));
	}
	/** Round 23 wave 3: server replies to the requester only (capped, exact first). */
	public onSearchPlayersResult(callback: (result: { query: string, players: Array<{ name: string, online: boolean, level?: number }> }) => void): void {
		this.socket.on('searchPlayersResult', (data: any) => {
			if (data && typeof data.query === 'string' && Array.isArray(data.players)) callback(data);
		});
	}
	/** Round 23 wave 3: friendship established — `name` is the OTHER user. */
	public onFriendAdded(callback: (name: string) => void): void {
		this.socket.on('friendAdded', (data: any) => {
			if (data && typeof data.name === 'string') callback(data.name);
		});
	}
	/** Round 23 wave 3: my outgoing request was withdrawn by the other side. */
	public onFriendRequestWithdrawn(callback: (name: string) => void): void {
		this.socket.on('friendRequestWithdrawn', (data: any) => {
			if (data && typeof data.name === 'string') callback(data.name);
		});
	}
	/** Round 23 wave 3: my outgoing request was declined by the target. */
	public onFriendRequestDeclined(callback: (name: string) => void): void {
		this.socket.on('friendRequestDeclined', (data: any) => {
			if (data && typeof data.name === 'string') callback(data.name);
		});
	}
	/** Round 23 wave 3: party action outcomes (invite accepted/declined/busy/full). */
	public onPartyActionResult(callback: (result: any) => void): void {
		this.socket.on('partyActionResult', (data: any) => callback(data));
	}
	// ---- lobby query callbacks ----
	public onRoomPlayers(callback: (players: string[], host?: string) => void): void {
		this.socket.on('roomPlayers', (data: any) => callback(data.players, data.host));
	}
	public onOnlineCount(callback: (count: number) => void): void {
		this.socket.on('onlineCount', (data: any) => callback(data.count));
	}
}