/**
 * Minecraft-style multiplayer server list (连接服务器 screen).
 *
 * Replaces the old approach that reused the game's save-slot "load" screen (whose
 * top-left title read "读取" and which only mirrored the config file's servers).
 * This is a self-contained DOM overlay with:
 *   - a scrollable server list (name + host:port + a live connectivity indicator),
 *   - Add Server / Delete Server (persisted through MultiplayerConfig),
 *   - Direct Connect (a one-shot host:port entry that is NOT added to the list),
 *   - per-server reachability probing (socket.io client script fetch, with a ping).
 *
 * Visual language matches the login panel / comm dialog (dark navy + cyan, CJK-safe
 * font stack) and is driven by jQuery exactly like the rest of the mod UI.
 */
import type { MultiplayerConfig } from '../config';
import { IServer } from '../server';
import { t } from '../i18n';

const PROBE_TIMEOUT_MS = 2000;
const DEFAULT_PORT = 15151;

interface IProbeResult { ok: boolean; pingMs: number; }

/** ROUND 79 (feature): probe a server's mod version via its /version endpoint
 * (the SAME config.version the login handshake reports). Returns '' when the
 * endpoint is missing / times out (an older server without the route). */
function probeVersion(server: IServer): Promise<string> {
	return new Promise((resolve) => {
		const url = server.type + '://' + server.hostname + ':' + server.port + '/version?_=' + Date.now();
		let settled = false;
		const timer = setTimeout(() => { if (!settled) { settled = true; resolve(''); } }, PROBE_TIMEOUT_MS);
		const done = (v: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(v);
		};
		try {
			$.ajax({
				url,
				dataType: 'json',
				timeout: PROBE_TIMEOUT_MS,
				cache: false,
				success: (data: any) => done((data && typeof data.version === 'string' && data.version) ? data.version : ''),
				error: () => done(''),
			});
		} catch (_) { done(''); }
	});
}

function serverName(server: IServer): string {
	return (server.display && server.display.trim()) ? server.display.trim() : server.hostname;
}

function serverAddress(server: IServer): string {
	return server.hostname + ':' + server.port;
}

/** Strip an optional http:// or https:// scheme, returning the remainder + scheme. */
function stripScheme(raw: string): { rest: string; type: string } {
	let rest = String(raw || '').trim();
	let type = 'http';
	if (/^https?:\/\//i.test(rest)) {
		const m = /^(https?):\/\//i.exec(rest);
		type = (m && m[1].toLowerCase() === 'https') ? 'https' : 'http';
		rest = rest.replace(/^https?:\/\//i, '');
	}
	return { rest, type };
}

/** Parse a bare hostname (scheme allowed, port ignored — the Add form has its own
 * port field). Returns null when there is no usable hostname. */
function parseHost(raw: string): { hostname: string; type: string } | null {
	const { rest, type } = stripScheme(raw);
	const colon = rest.indexOf(':');
	const hostname = (colon > 0 ? rest.substring(0, colon) : rest).trim();
	return hostname ? { hostname, type } : null;
}

/** Parse a host[:port] / scheme://host[:port] entry (Direct Connect). Returns null
 * when there is no usable hostname or the port is out of range. */
function parseAddress(raw: string): { hostname: string; port: number; type: string } | null {
	const { rest, type } = stripScheme(raw);
	let hostname = rest;
	let port = DEFAULT_PORT;
	const lastColon = rest.lastIndexOf(':');
	if (lastColon > 0 && lastColon === rest.indexOf(':')) {
		const maybePort = rest.substring(lastColon + 1);
		if (/^\d+$/.test(maybePort)) {
			hostname = rest.substring(0, lastColon);
			port = parseInt(maybePort, 10);
		}
	}
	hostname = hostname.trim();
	if (!hostname) return null;
	if (!(port >= 1 && port <= 65535)) return null;
	return { hostname, port, type };
}

/** Probe a server by loading its socket.io client script — the SAME resource the
 * connector fetches on connect (SocketIOConnector.load), so a successful load is a
 * strong signal that a multiplayer server is listening there. onload -> reachable
 * (returns the load latency as an approximate ping); onerror/timeout -> unreachable. */
function probeServer(server: IServer): Promise<IProbeResult> {
	return new Promise((resolve) => {
		const url = server.type + '://' + server.hostname + ':' + server.port + '/socket.io/socket.io.js';
		const started = Date.now();
		let settled = false;
		let timer: any = null;
		const el = document.createElement('script');
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			try { el.remove(); } catch (_) { /* ignore */ }
			resolve({ ok, pingMs: ok ? Math.max(1, Date.now() - started) : -1 });
		};
		el.type = 'text/javascript';
		el.onload = () => finish(true);
		el.onerror = () => finish(false);
		el.src = url;
		try {
			(document.head || document.documentElement).appendChild(el);
		} catch (_) {
			return finish(false);
		}
		timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
	});
}

let styleInstalled = false;

function ensureStyle(): void {
	if (styleInstalled) return;
	styleInstalled = true;
	const style = document.createElement('style');
	style.id = 'mpServerListStyle';
	style.textContent = `
/* ---- Minecraft-style server list overlay ---- */
.mpServerScrim {
	position: fixed; left: 0; top: 0; width: 100%; height: 100%;
	background: rgba(3, 10, 18, 0.82);
	display: flex; align-items: center; justify-content: center;
	z-index: 20050;
}
.mpServerPanel {
	width: 720px; max-width: 96vw; max-height: 90vh;
	display: flex; flex-direction: column;
	background: rgba(6, 18, 30, 0.96);
	border: 2px solid #6fc7ff; border-radius: 6px;
	box-shadow: 0 0 22px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
	color: #eaf7ff; font-family: 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
	animation: mpServerIn 0.2s ease-out;
}
@keyframes mpServerIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }
.mpServerHead { display: flex; align-items: center; padding: 14px 16px 10px 16px; }
.mpServerTitle { font-size: 16px; letter-spacing: 2px; color: #dff3ff; }
.mpServerClose { margin-left: auto; width: 26px; height: 26px; cursor: pointer;
	background: rgba(18, 50, 72, 0.9); color: #dff3ff; font-size: 18px; line-height: 1;
	border: 1px solid #6fc7ff; border-radius: 4px; }
.mpServerClose:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpServerBody { flex: 1 1 auto; min-height: 220px; overflow-y: auto; padding: 6px 12px 10px 12px; }
.mpServerRow { display: flex; align-items: center;
	padding: 10px 12px; margin: 4px 0; cursor: pointer;
	background: rgba(12, 32, 50, 0.7); border: 1px solid rgba(111, 199, 255, 0.22); border-radius: 4px; }
.mpServerRow:hover { background: rgba(24, 56, 84, 0.85); }
.mpServerRow.selected { border-color: #7fd0ff; box-shadow: 0 0 10px rgba(127, 208, 255, 0.45); background: rgba(30, 66, 98, 0.9); }
.mpServerDot { flex: 0 0 12px; width: 12px; height: 12px; border-radius: 50%; margin-right: 14px;
	background: #8899a8; box-shadow: 0 0 6px rgba(136,153,168,0.6); }
.mpServerDot.online { background: #54e07a; box-shadow: 0 0 8px rgba(84,224,122,0.8); }
.mpServerDot.offline { background: #ff6b6b; box-shadow: 0 0 8px rgba(255,107,107,0.8); }
.mpServerDot.checking { background: #f4c95d; box-shadow: 0 0 8px rgba(244,201,93,0.8); }
.mpServerMeta { flex: 1 1 auto; min-width: 0; }
.mpServerName { font-size: 14px; color: #eaf7ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mpServerAddr { font-size: 11px; color: #8fd6ff; margin-top: 3px; }
/* ROUND 79 (feature): the server's mod version, probed via /version. */
.mpServerVer { font-size: 11px; color: #b9c9d8; margin-top: 2px; }
.mpServerStatus { flex: 0 0 auto; font-size: 12px; color: #8fd6ff; margin-left: 14px; }
.mpServerStatus.online { color: #a9f7c0; }
.mpServerStatus.offline { color: #ff9d9d; }
.mpServerEmpty { padding: 24px 10px; text-align: center; font-size: 13px; color: #8fd6ff; }
.mpServerFoot { display: flex; flex-wrap: wrap; padding: 14px 12px 18px 12px; border-top: 1px solid rgba(111,199,255,0.25); }
.mpServerBtn { flex: 1 1 auto; min-width: 104px; padding: 8px 12px; cursor: pointer; margin: 5px 6px;
	background: rgba(18, 50, 72, 0.9); color: #dff3ff;
	border: 1px solid #6fc7ff; border-radius: 4px; font-size: 13px; font-family: inherit; }
.mpServerBtn:hover:not(:disabled) { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpServerBtn:disabled { opacity: 0.4; cursor: default; }
.mpServerBtnPrimary { background: rgba(20, 96, 64, 0.9); border-color: #7fd0a0; color: #eafff1; }
.mpServerBtnPrimary:hover:not(:disabled) { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }

/* ---- sub-modal (add / direct / confirm) ---- */
.mpServerModal { position: fixed; left: 0; top: 0; width: 100%; height: 100%;
	background: rgba(3, 10, 18, 0.5); display: flex; align-items: center; justify-content: center; z-index: 20060; }
.mpServerForm { width: 380px; max-width: 92vw; padding: 16px 18px 14px 18px;
	background: rgba(6, 18, 30, 0.98); border: 2px solid #6fc7ff; border-radius: 6px;
	box-shadow: 0 0 22px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
	color: #eaf7ff; font-family: 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
	animation: mpServerIn 0.18s ease-out; }
.mpServerFormTitle { font-size: 14px; letter-spacing: 1px; color: #dff3ff; margin-bottom: 12px; }
.mpServerField { display: block; font-size: 12px; color: #8fd6ff; margin-bottom: 8px; }
.mpServerInput { width: 100%; box-sizing: border-box; padding: 7px 9px; margin-top: 3px;
	background: rgba(8, 26, 44, 0.9); color: #eaf7ff; border: 1px solid #6fc7ff; border-radius: 4px;
	font-size: 13px; font-family: inherit; }
.mpServerInput:focus { outline: none; box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpServerHint { font-size: 12px; color: #ff9d9d; min-height: 15px; margin: 6px 0; }
.mpServerFormBtns { display: flex; justify-content: flex-end; margin-top: 10px; }
.mpServerFormBtns .mpServerBtn { flex: 0 0 auto; min-width: 96px; margin: 0; }
.mpServerFormBtns .mpServerBtn + .mpServerBtn { margin-left: 10px; }
.mpServerConfirmMsg { font-size: 13px; line-height: 1.55; color: #eaf7ff; margin-bottom: 14px; }
`;
	try {
		if (document.head) document.head.appendChild(style);
		else if (document.documentElement) document.documentElement.appendChild(style);
	} catch (_) { /* document not ready — the overlay would fail anyway */ }
}

/** Show the server-list overlay. Resolves with the chosen IServer (a saved entry or
 * a direct-connect address); rejects with 'cancelled' when dismissed. */
export function showServerList(config: MultiplayerConfig): Promise<IServer> {
	return new Promise((resolve, reject) => {
		ensureStyle();

		let settled = false;
		let selected = config.servers.length ? 0 : -1;
		let probeSeq = 0;
		let body: JQuery;
		let joinBtn: JQuery;
		let delBtn: JQuery;
		let modalEl: JQuery | null = null;

		const scrim = $('<div class="mpServerScrim"></div>');
		const panel = $('<div class="mpServerPanel"></div>');

		const cleanup = (): void => {
			if (settled) return;
			settled = true;
			try { if (modalEl) modalEl.remove(); } catch (_) { /* ignore */ }
			try { scrim.remove(); } catch (_) { /* ignore */ }
			try { ig.system.regainFocus(); } catch (_) { /* ignore */ }
			try { (ig.interact as any).setBlockDelay(0.2); } catch (_) { /* ignore */ }
		};
		const finish = (server: IServer): void => {
			if (settled) return;
			cleanup();
			resolve(server);
		};
		const cancel = (): void => {
			if (settled) return;
			cleanup();
			reject('cancelled');
		};

		// Head.
		const head = $('<div class="mpServerHead"></div>');
		head.append($('<span class="mpServerTitle"></span>').text(t('serverListTitle')));
		const closeBtn = $('<button type="button" class="mpServerClose" title="' + t('serverClose') + '">&times;</button>');
		closeBtn.on('click', cancel);
		head.append(closeBtn);
		panel.append(head);

		// Body (list).
		body = $('<div class="mpServerBody"></div>');
		panel.append(body);

		// Footer buttons.
		const foot = $('<div class="mpServerFoot"></div>');
		joinBtn = $('<button type="button" class="mpServerBtn mpServerBtnPrimary"></button>').text(t('serverJoin'));
		const directBtn = $('<button type="button" class="mpServerBtn"></button>').text(t('serverDirect'));
		const addBtn = $('<button type="button" class="mpServerBtn"></button>').text(t('serverAdd'));
		delBtn = $('<button type="button" class="mpServerBtn"></button>').text(t('serverDelete'));
		const refreshBtn = $('<button type="button" class="mpServerBtn"></button>').text(t('serverRefresh'));
		foot.append(joinBtn, directBtn, addBtn, delBtn, refreshBtn);
		panel.append(foot);

		scrim.append(panel);
		$(document.body).append(scrim);
		try { ig.system.setFocusLost(); } catch (_) { /* ignore */ }

		// ---- rendering ----
		const applyStatus = (i: number, r: IProbeResult): void => {
			if (settled) return;
			const row = body.children('.mpServerRow').eq(i);
			if (!row.length) return;
			const dot = row.find('.mpServerDot');
			const status = row.find('.mpServerStatus');
			if (r.ok) {
				dot.attr('class', 'mpServerDot online');
				status.attr('class', 'mpServerStatus online');
				status.text(t('serverOnline') + ' · ' + t('serverPing').replace('{n}', String(r.pingMs)));
			} else {
				dot.attr('class', 'mpServerDot offline');
				status.attr('class', 'mpServerStatus offline');
				status.text(t('serverOffline'));
			}
		};

		const updateSelection = (): void => {
			body.children('.mpServerRow').each((i: number, el: any) => {
				$(el).toggleClass('selected', i === selected);
			});
			joinBtn.prop('disabled', selected < 0 || selected >= config.servers.length);
			delBtn.prop('disabled', selected < 0 || selected >= config.servers.length);
		};

		const renderRows = (): void => {
			body.empty();
			if (!config.servers.length) {
				body.append($('<div class="mpServerEmpty"></div>').text(t('serverEmpty')));
				updateSelection();
				return;
			}
			config.servers.forEach((server, i) => {
				const row = $('<div class="mpServerRow"></div>');
				row.append($('<span class="mpServerDot checking"></span>'));
				const meta = $('<div class="mpServerMeta"></div>');
				meta.append($('<div class="mpServerName"></div>').text(serverName(server)));
				meta.append($('<div class="mpServerAddr"></div>').text(serverAddress(server)));
				// ROUND 79 (feature): version line - filled once the /version probe answers.
				meta.append($('<div class="mpServerVer"></div>'));
				row.append(meta);
				row.append($('<div class="mpServerStatus checking"></div>').text(t('serverChecking')));
				// Selecting a row only moves the highlight — it must NOT rebuild the list
				// (which would reset every status to "checking") or re-probe.
				row.on('click', () => { selected = i; updateSelection(); });
				row.on('dblclick', () => { selected = i; updateSelection(); finish(config.servers[i]); });
				body.append(row);
			});
			updateSelection();
		};

		const refreshProbes = (): void => {
			probeSeq++;
			const seq = probeSeq;
			body.find('.mpServerDot').attr('class', 'mpServerDot checking');
			body.find('.mpServerStatus').attr('class', 'mpServerStatus checking').text(t('serverChecking'));
			body.find('.mpServerVer').text('');
			config.servers.forEach((server, i) => {
				probeServer(server).then((r) => {
					if (seq !== probeSeq || settled) return;
					applyStatus(i, r);
				});
				// ROUND 79 (feature): the version arrives independently of the socket.io
				// script probe - fill the card's version line whenever it lands.
				probeVersion(server).then((v) => {
					if (seq !== probeSeq || settled) return;
					const row = body.children('.mpServerRow').eq(i);
					if (!row.length) return;
					row.find('.mpServerVer').text(v ? 'MP v' + v : '');
				});
			});
		};

		// ---- sub-modals ----
		const openModal = (
			title: string,
			fields: { label: string; ph: string; value?: string; type?: string; inputmode?: string }[],
			submit: (values: string[], hint: JQuery) => boolean,
		): void => {
			const modal = $('<div class="mpServerModal"></div>');
			modalEl = modal;
			const form = $('<div class="mpServerForm"></div>');
			form.append($('<div class="mpServerFormTitle"></div>').text(title));
			const inputs: JQuery[] = [];
			for (const f of fields) {
				const label = $('<label class="mpServerField"></label>').text(f.label);
				const input = $('<input class="mpServerInput" />').attr('type', f.type || 'text').attr('placeholder', f.ph);
				if (f.inputmode) input.attr('inputmode', f.inputmode);
				if (f.value !== undefined) input.val(f.value);
				label.append(input);
				form.append(label);
				inputs.push(input);
			}
			const hint = $('<div class="mpServerHint"></div>');
			form.append(hint);
			const btns = $('<div class="mpServerFormBtns"></div>');
			const saveBtn = $('<button type="button" class="mpServerBtn mpServerBtnPrimary"></button>').text(t('serverSave'));
			const cancelBtn = $('<button type="button" class="mpServerBtn"></button>').text(t('serverCancel'));
			btns.append(cancelBtn, saveBtn);
			form.append(btns);
			modal.append(form);
			$(document.body).append(modal);

			const closeModal = (): void => {
				try { modal.remove(); } catch (_) { /* ignore */ }
				modalEl = null;
			};
			const submitForm = (): void => {
				const values = inputs.map((inp) => String(inp.val() || '').trim());
				if (submit(values, hint)) closeModal();
			};
			cancelBtn.on('click', closeModal);
			saveBtn.on('click', submitForm);
			if (inputs[0]) inputs[0].focus();
			inputs.forEach((inp) => {
				inp.on('keydown', (e: any) => {
					if (e && e.which === 13) submitForm();
					else if (e && e.which === 27) closeModal();
				});
			});
		};

		const openConfirm = (title: string, message: string, onYes: () => void): void => {
			const modal = $('<div class="mpServerModal"></div>');
			modalEl = modal;
			const form = $('<div class="mpServerForm"></div>');
			form.append($('<div class="mpServerFormTitle"></div>').text(title));
			form.append($('<div class="mpServerConfirmMsg"></div>').text(message));
			const btns = $('<div class="mpServerFormBtns"></div>');
			const okBtn = $('<button type="button" class="mpServerBtn mpServerBtnPrimary"></button>').text(t('confirmOk'));
			const cancelBtn = $('<button type="button" class="mpServerBtn"></button>').text(t('confirmCancel'));
			btns.append(cancelBtn, okBtn);
			form.append(btns);
			modal.append(form);
			$(document.body).append(modal);
			const closeModal = (): void => {
				try { modal.remove(); } catch (_) { /* ignore */ }
				modalEl = null;
			};
			cancelBtn.on('click', closeModal);
			okBtn.on('click', () => { closeModal(); onYes(); });
		};

		// ---- actions ----
		joinBtn.on('click', () => {
			if (selected < 0 || selected >= config.servers.length) return;
			finish(config.servers[selected]);
		});

		directBtn.on('click', () => {
			openModal(t('serverDirect'), [
				{ label: t('serverHostLabel'), ph: t('serverDirectPh') },
			], (values, hint) => {
				const raw = String(values[0] || '').trim();
				if (!parseHost(raw)) {
					hint.text(t('serverRequiredHost'));
					return false;
				}
				const parsed = parseAddress(raw);
				if (!parsed) {
					hint.text(t('serverInvalidPort'));
					return false;
				}
				finish({ hostname: parsed.hostname, port: parsed.port, type: parsed.type });
				return true;
			});
		});

		addBtn.on('click', () => {
			openModal(t('serverAdd'), [
				{ label: t('serverNameLabel'), ph: t('serverNamePh') },
				{ label: t('serverHostLabel'), ph: t('serverHostPh') },
				// 1.71.9 (issue 1): NOT type=number — in the NW.js game shell a number
				// input only reacts to its up/down spinners and swallows typed digits.
				// A plain text field with numeric inputmode accepts the keyboard and
				// is still validated against /^\d+$/ below.
				{ label: t('serverPortLabel'), ph: String(DEFAULT_PORT), value: String(DEFAULT_PORT), type: 'text', inputmode: 'numeric' },
			], (values, hint) => {
				const name = values[0];
				const host = parseHost(values[1]);
				if (!host) {
					hint.text(t('serverRequiredHost'));
					return false;
				}
				const rawPort = values[2];
				if (!/^\d{1,5}$/.test(rawPort)) {
					hint.text(t('serverInvalidPort'));
					return false;
				}
				const port = parseInt(rawPort, 10);
				if (!(port >= 1 && port <= 65535)) {
					hint.text(t('serverInvalidPort'));
					return false;
				}
				config.addServer({ display: name || undefined, hostname: host.hostname, port, type: host.type });
				selected = config.servers.length - 1;
				renderRows();
				refreshProbes();
				return true;
			});
		});

		delBtn.on('click', () => {
			if (selected < 0 || selected >= config.servers.length) return;
			const server = config.servers[selected];
			openConfirm(t('serverDeleteTitle'), t('serverDeleteConfirm').replace('{name}', serverName(server)), () => {
				config.removeServer(selected);
				selected = config.servers.length ? Math.min(selected, config.servers.length - 1) : -1;
				renderRows();
				refreshProbes();
			});
		});

		refreshBtn.on('click', refreshProbes);

		renderRows();
		refreshProbes();
	});
}
