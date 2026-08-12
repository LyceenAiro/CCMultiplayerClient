import { IConnection } from '../connection';

/**
 * Round 23: chunked, rate-limited save UPLOAD queue.
 *
 * The server enforces a per-socket upload cap (config.saveUploadKbS, default
 * 1024 kb/s) using a token bucket. Instead of blasting a whole ~MB save as one
 * packet (which would either trip the cap or move a large JSON string in a single
 * frame), we split the save into 8192-char parts and pace them at ~640 kb/s (one
 * 8192-char part per 100ms drain tick) — still under the server's 1024 kb/s cap —
 * via a 100ms draining interval.
 *
 * submit() ABORTS any in-flight upload (a generation counter is bumped, so a stale
 * stream's remaining parts are never sent and the server discards it on gen) and
 * then streams the newest save. Rapid map switching therefore keeps only the
 * newest save, exactly as required.
 *
 * The connection is attached/detached per session (attach on connect, abort+detach
 * on logout/server loss). The drain loop self-aborts when the socket is closed so a
 * disconnected client can't build up a stale queue.
 */

/** Server-visible reason codes (see protocol.js saveChunk — drives the area-save
 *  anti-spam gate; non-area reasons bypass it). */
export type SaveReason = 'area' | 'landmark' | 'manual' | 'exit' | 'other';

/** Size of one wire chunk (must match the server's assembly, protocol.js). */
const PART_SIZE = 8192;
/** Drain cadence: emit up to a 100ms worth of bytes every 100ms. */
const DRAIN_INTERVAL_MS = 100;
/** Client-side pace (~640 kb/s = 80 kB/s — one 8192-char part per 100ms tick,
 * under the server's 1024 kb/s cap). bytes per 100ms drain tick. */
const BYTES_PER_TICK = Math.floor((512 * 1024) / 8 / (1000 / DRAIN_INTERVAL_MS)); // ≈ 6553

interface IStream {
	gen: number;
	slot: string;
	parts: string[];
	seq: number;
	reason: SaveReason;
}

export class SaveUploadQueue {
	private conn: IConnection | null = null;
	private gen = 0;
	private stream: IStream | null = null;
	private timer: any = null;

	/** Point the queue at the CURRENT connection (re-run on every connect — the
	 * connection object is recreated per session). */
	public attach(conn: IConnection): void {
		this.conn = conn;
	}

	/** Abort any in-flight upload and forget the connection (logout / server loss). */
	public detach(): void {
		this.abort();
		this.conn = null;
	}

	/** Abort any in-flight upload (bumps the generation counter) and start streaming
	 * the new save. `data` is the serialized save (normally the ENCRYPTED slot
	 * payload, exactly what the old saveUpload sent). A tiny save (≤1 chunk) still
	 * goes through the same path and emits exactly one saveChunk. */
	public submit(slot: string, data: string, reason: SaveReason): void {
		const parts: string[] = [];
		if (typeof data === 'string' && data.length) {
			for (let i = 0; i < data.length; i += PART_SIZE) {
				parts.push(data.substring(i, i + PART_SIZE));
			}
		}
		this.gen++;
		this.stream = { gen: this.gen, slot, parts, seq: 0, reason };
		this.start();
		// Emit the first chunk immediately (a manual save shouldn't feel laggy) — the
		// interval then paces out the rest. Guarded: if not connected, drain aborts.
		try { this.drain(); } catch (_) { /* ignore */ }
	}

	public abort(): void {
		this.gen++;
		this.stream = null;
		if (this.timer !== null) {
			try { clearInterval(this.timer); } catch (_) { /* ignore */ }
			this.timer = null;
		}
	}

	/** Emit ALL remaining parts synchronously (no pacing) — used by the exit-save
	 * path right before the socket closes, so a final save lands in one burst (a
	 * ~60KB burst is far under the server's ~1MB token bucket). No-op when the
	 * socket is closed (a dead upload aborts instead). */
	public flush(): void {
		const conn = this.conn;
		if (!conn || !conn.isOpen || !conn.isOpen()) { this.abort(); return; }
		const st = this.stream;
		if (!st) return;
		while (st.seq < st.parts.length) {
			const part = st.parts[st.seq];
			conn.saveChunk({ gen: st.gen, slot: st.slot, total: st.parts.length, seq: st.seq, part, reason: st.reason });
			st.seq++;
		}
		if (this.timer !== null) {
			try { clearInterval(this.timer); } catch (_) { /* ignore */ }
			this.timer = null;
		}
		this.stream = null;
	}

	private start(): void {
		if (this.timer !== null) return;
		this.timer = setInterval(() => {
			try { this.drain(); } catch (_) { /* a save must never throw */ }
		}, DRAIN_INTERVAL_MS);
	}

	private drain(): void {
		const conn = this.conn;
		const st = this.stream;
		if (!conn || !conn.isOpen || !conn.isOpen()) {
			// Socket went away mid-stream — abort so a reconnect can't resume a
			// stale upload (the next save trigger re-submits the whole save).
			this.abort();
			return;
		}
		if (!st) {
			if (this.timer !== null) { try { clearInterval(this.timer); } catch (_) { /* ignore */ } this.timer = null; }
			return;
		}
		const gen = st.gen;
		let budget = BYTES_PER_TICK;
		while (budget > 0 && st.seq < st.parts.length) {
			const part = st.parts[st.seq];
			conn.saveChunk({ gen, slot: st.slot, total: st.parts.length, seq: st.seq, part, reason: st.reason });
			st.seq++;
			budget -= part.length;
		}
		if (st.seq >= st.parts.length) {
			// Stream fully drained — stop the timer until the next submit.
			if (this.timer !== null) { try { clearInterval(this.timer); } catch (_) { /* ignore */ } this.timer = null; }
			this.stream = null;
		}
	}
}

/** Module-level singleton shared by every upload call site. */
export const saveUploadQueue = new SaveUploadQueue();
