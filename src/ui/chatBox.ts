import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';

/**
 * ROUND 93/94 — MMO-STYLE CHANNEL CHAT (world / party / private).
 *
 * TWO presentation modes, driven by whether the chat INPUT is open:
 *
 *  CLOSED (normal play)
 *    Nothing is docked on the screen. Incoming messages render as transient
 *    POPUP bubbles anchored to the BOTTOM-LEFT. Every bubble carries a channel
 *    prefix — [世界] white, [小队] blue, [私聊] pink. The stack grows from the
 *    BOTTOM upward (newest at the bottom; older bubbles are pushed up and fade
 *    out after ~8s), so the first message never appears at the top of a box.
 *
 *  OPEN (Enter pressed)
 *    A full MMO panel appears at the bottom-left with the channel tabs/cards
 *    (世界 / 小队 / closable private tabs), the message list (newest pinned to
 *    the bottom) and the input strip. Popups are hidden while the panel is open;
 *    incoming messages land in their channel tab (unread badge when inactive).
 *
 * The Enter hook is a CAPTURE-phase window keydown listener (never a rebind of
 * ig.KEY.ENTER / sc.control). While the input is open it consumes every key not
 * aimed at a text-entry element so game bindings never fire; while closed, a
 * bare Enter opens the input. IME composition events are never treated as send
 * (keyCode 229 / isComposing pass untouched).
 *
 * History is per-channel, per-ACCOUNT (localStorage key includes the username so
 * one login's messages never leak into another) and capped at 50 persisted rows
 * per channel. System lines are shown but never persisted.
 */

type ChatKind = 'world' | 'party' | 'private';

interface ChatMessage {
    from: string;   // '' => system line
    text: string;
    ts: number;
}

interface ChatChannel {
    id: string;
    kind: ChatKind;
    /** private recipient username (the OTHER side of the conversation) */
    target?: string;
    messages: ChatMessage[];
    unread: number;
}

export interface IChatMessage {
    from: string;
    text: string;
    channel?: string;
    target?: string;
}

export interface IChatError {
    reason?: string;
    channel?: string;
    target?: string;
}

let getMain: () => Multiplayer | undefined = () => undefined;

let installed = false;                       // once-per-process keydown capture guard
let captureKeydown: ((e: KeyboardEvent) => void) | null = null;

let chatOpen = false;                        // input strip (and the full panel) visible
let panel: HTMLElement | null = null;        // the channel panel (hidden unless .open)
let tabsEl: HTMLElement | null = null;
let msgsEl: HTMLElement | null = null;
let inputRowEl: HTMLElement | null = null;
let inputEl: HTMLInputElement | null = null;
let chatFocusListener: (() => void) | null = null;

let popupHost: HTMLElement | null = null;    // transient bubble stack (chat closed)
interface IPop { el: HTMLElement, timer: number }
let pops: IPop[] = [];

let channels: ChatChannel[] = [];
let activeId = 'world';

// X1: the engine's ig.input.keydown/keyup saved once at install and replaced with
// wrappers that no-op while the chat input is open (game bindings must never fire
// while typing). The engine's own window listener is bound to the ORIGINAL at
// input-init time, so the capture-phase suppression in captureKeydown is the real
// gate; these wrappers are belt-and-braces for code paths that call them directly.
let origInputKeydown: ((a: any) => void) | null = null;
let origInputKeyup: ((a: any) => void) | null = null;

const WORLD_ID = 'world';
const PARTY_ID = 'party';
const PRIVATE_PREFIX = 'pm:';
const MAX_MESSAGES = 80;        // live rows kept per channel
const PERSIST_MAX = 50;         // persisted rows kept per channel
const PERSIST_PREFIX = 'mpChatChannelsV2:';
const MAX_POPS = 5;             // transient bubbles kept at once
const POP_TTL_MS = 8000;        // each bubble lives ~8s

/** True when the keydown event target is a text-entry element — the chat hook
 * must never hijack keys while the player is typing somewhere else. */
function isTypingTarget(e: Event): boolean {
    const t = e.target as any;
    if (!t) return false;
    const tag = String(t.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (t.isContentEditable) return true;
    return false;
}

/** The F8 command box and the login panel are DOM modals; when either is up the
 * Enter key belongs to them, not to chat. Same detection the modules themselves
 * use (gamecodeMessage / mpLogin class names). */
function modalPanelOpen(): boolean {
    try {
        if (document.querySelector('.mpLogin')) return true;             // login panel
        if (document.querySelector('.gamecodeMessage')) return true;     // F8 command box
    } catch (_) { /* ignore */ }
    return false;
}

/** ALL open conditions must hold: connected, in-game, no menu, no cutscene,
 * interact unblocked, no mod modal, chat not already open. */
function canOpenChat(): boolean {
    try {
        const main = getMain();
        if (!main) return false;
        const conn: any = main.connection;
        if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return false;
        if (!main.inGameOk()) return false;
        if (main.anyMenuOpen()) return false;
        const mdl: any = (sc as any).model;
        if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) return false;
        // Board/private/tutorial message boxes also block interact.
        const msg: any = mdl && mdl.message;
        if (msg && typeof msg.isBlocking === 'function' && msg.isBlocking()) return false;
        const inter: any = (ig as any).interact;
        if (inter && typeof inter.isBlocked === 'function' && inter.isBlocked()) return false;
        if (modalPanelOpen()) return false;
        return true;
    } catch (_) { return false; }
}

// ---- keydown capture (opening) ----

/** Install the capture-phase Enter hook exactly once per client process (there is
 * no mod teardown path — the mod lives for the whole process, so no removal). */
export function installChatBox(gm: () => Multiplayer | undefined): void {
    getMain = gm;
    if (installed) return;
    installed = true;
    captureKeydown = (e: KeyboardEvent): void => {
        try {
            const code = e.keyCode || e.which;
            const typing = isTypingTarget(e);

            // IME (CJK user base): while a text composition is in progress the
            // keydowns are composition events (keyCode 229 / isComposing) — never
            // treat the composition-commit Enter as "send" nor run any chat
            // open/close logic mid-composition.
            if (e.isComposing || code === 229) return;

            // X1: while the chat input is open, game key bindings must never fire.
            if (chatOpen) {
                if (code === 27) { // Escape cancels — consume in every case
                    e.preventDefault();
                    e.stopPropagation();
                    closeInput();
                    return;
                }
                if (code === 13 || code === 108) { // Enter / keypad Enter
                    // Enter NOT aimed at the chat input must never reach the game —
                    // consume it. When it IS aimed at the input (typing=true) the
                    // input's own submit handler sends it.
                    if (!typing) { e.preventDefault(); e.stopPropagation(); }
                    return;
                }
                // Any other key: let it through only when aimed at a text input
                // (typing works), otherwise swallow it so no game binding fires.
                if (!typing) { e.preventDefault(); e.stopPropagation(); }
                return;
            }

            if (typing) return; // never hijack typing in another input/textarea
            if (code === 13 || code === 108) { // Enter / keypad Enter opens the chat
                if (canOpenChat()) {
                    e.preventDefault();
                    e.stopPropagation();
                    openInput();
                }
                return;
            }
        } catch (_) { /* a key handler must never break input */ }
    };
    window.addEventListener('keydown', captureKeydown, true);

    // X1 belt-and-braces: wrap ig.input.keydown/keyup so game bindings cannot fire
    // while the chat input is open, for any code path that reaches them directly.
    const inp: any = (ig as any).input;
    if (inp && typeof inp.keydown === 'function' && !origInputKeydown) {
        const origKeydown: (a: any) => void = inp.keydown;
        origInputKeydown = origKeydown;
        inp.keydown = function (this: any, a: any): void {
            if (chatOpen) return;
            origKeydown.apply(this, arguments as any);
        };
    }
    if (inp && typeof inp.keyup === 'function' && !origInputKeyup) {
        const origKeyup: (a: any) => void = inp.keyup;
        origInputKeyup = origKeyup;
        inp.keyup = function (this: any, a: any): void {
            if (chatOpen) return;
            origKeyup.apply(this, arguments as any);
        };
    }
}

// ---- persistent per-channel history (per account) ----

function persistKey(): string {
    try {
        const main = getMain();
        const name = main && main.name ? String(main.name) : 'default';
        return PERSIST_PREFIX + name;
    } catch (_) { return PERSIST_PREFIX + 'default'; }
}

function loadPersisted(): { [id: string]: Array<{ from: string, text: string, ts: number }> } {
    try {
        const raw = window.localStorage.getItem(persistKey());
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const out: { [id: string]: Array<{ from: string, text: string, ts: number }> } = {};
        for (const id of Object.keys(parsed)) {
            if (typeof id !== 'string' || !Array.isArray(parsed[id])) continue;
            const rows: Array<{ from: string, text: string, ts: number }> = [];
            for (const h of parsed[id]) {
                if (!h || typeof h !== 'object' || typeof h.text !== 'string') continue;
                rows.push({
                    from: typeof h.from === 'string' ? h.from : '',
                    text: h.text,
                    ts: typeof h.ts === 'number' ? h.ts : Date.now(),
                });
            }
            out[id] = rows.slice(-PERSIST_MAX);
        }
        return out;
    } catch (_) { return {}; /* storage/JSON failed — start empty */ }
}

function savePersisted(): void {
    try {
        const out: { [id: string]: Array<{ from: string, text: string, ts: number }> } = {};
        for (const ch of channels) {
            const rows = ch.messages.filter((m) => m.from).slice(-PERSIST_MAX);
            if (rows.length) out[ch.id] = rows;
        }
        window.localStorage.setItem(persistKey(), JSON.stringify(out));
    } catch (_) { /* a history write must never break the frame */ }
}

function removePersisted(id: string): void {
    try {
        const all = loadPersisted();
        if (Object.prototype.hasOwnProperty.call(all, id)) {
            delete all[id];
            window.localStorage.setItem(persistKey(), JSON.stringify(all));
        }
    } catch (_) { /* ignore */ }
}

// ---- channel state ----

function privateId(name: string): string {
    return PRIVATE_PREFIX + String(name);
}

function getChannel(id: string): ChatChannel | undefined {
    for (const ch of channels) if (ch.id === id) return ch;
    return undefined;
}

function activeChannel(): ChatChannel {
    return getChannel(activeId) || getChannel(WORLD_ID) || channels[0];
}

function ensureChannel(id: string, kind: ChatKind, target?: string): ChatChannel {
    let ch = getChannel(id);
    if (ch) return ch;
    ch = { id, kind, target, messages: [], unread: 0 };
    channels.push(ch);
    return ch;
}

/** Seed the two permanent tabs plus every private tab found in persisted history. */
function ensureChannels(): void {
    if (channels.length) return;
    ensureChannel(WORLD_ID, 'world');
    ensureChannel(PARTY_ID, 'party');
    const saved = loadPersisted();
    for (const id of Object.keys(saved)) {
        if (id === WORLD_ID || id === PARTY_ID) continue;
        if (id.indexOf(PRIVATE_PREFIX) === 0) {
            const ch = ensureChannel(id, 'private', id.slice(PRIVATE_PREFIX.length));
            ch.messages = (saved[id] || []).slice();
        }
    }
}

// ---- CSS ----

function ensureChatStyle(): void {
    if (document.getElementById('mpChatStyle')) return;
    const style = document.createElement('style');
    style.id = 'mpChatStyle';
    style.textContent = `
/* Full channel panel — only rendered while the input is open (.open). */
.mpChatBox {
    display: none;
    position: fixed; left: 12px; bottom: 12px;
    width: 380px; max-width: calc(100vw - 24px);
    z-index: 9000;
    color: #eaf7ff;
    font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    user-select: none;
}
.mpChatBox.open { display: block; }
.mpChatTabs {
    display: flex; align-items: stretch; gap: 3px;
    overflow-x: auto; overflow-y: hidden;
    padding: 4px 4px 0 4px;
    background: rgba(6, 18, 30, 0.94);
    border: 1px solid rgba(111, 199, 255, 0.55);
    border-bottom: none;
    border-radius: 7px 7px 0 0;
}
.mpChatTab {
    flex: 0 0 auto;
    display: inline-flex; align-items: center;
    padding: 3px 9px;
    font-size: 12px; line-height: 16px;
    color: #a9d8f2; background: rgba(13, 42, 66, 0.75);
    border: 1px solid rgba(111, 199, 255, 0.35);
    border-bottom: none;
    border-radius: 6px 6px 0 0;
    cursor: pointer;
}
.mpChatTab:hover { color: #eaf7ff; background: rgba(27, 70, 104, 0.85); }
.mpChatTab.active {
    color: #ffffff; background: rgba(41, 98, 140, 0.95);
    border-color: #6fc7ff;
    box-shadow: inset 0 -2px 0 #6fc7ff;
}
.mpChatTab.unread { color: #ffd76f; border-color: rgba(255, 215, 111, 0.7); }
.mpChatUnread {
    margin-left: 6px; min-width: 15px; padding: 0 4px;
    background: #d64545; color: #fff;
    border-radius: 8px; font-size: 10px; line-height: 14px; text-align: center;
}
.mpChatClose {
    margin-left: 7px; width: 15px; height: 15px;
    line-height: 13px; text-align: center;
    color: #9fc7e0; border: 1px solid rgba(159, 199, 224, 0.35);
    border-radius: 8px; font-size: 12px;
}
.mpChatClose:hover { color: #fff; background: rgba(214, 69, 69, 0.8); border-color: #ff9a9a; }
.mpChatMsgs {
    height: 132px;
    overflow-y: auto;
    padding: 4px 6px;
    background: rgba(4, 12, 20, 0.72);
    border: 1px solid rgba(111, 199, 255, 0.55);
    border-top: none;
}
.mpChatRow {
    display: flex; align-items: flex-start;
    padding: 1px 2px;
    font-size: 12.5px; line-height: 16px;
    word-break: break-word;
}
.mpChatName { color: #7dffa0; flex: 0 0 auto; margin-right: 5px; }
.mpChatText { color: #eaf7ff; flex: 1 1 auto; white-space: pre-wrap; }
.mpChatSysRow { padding: 1px 2px; font-size: 12px; line-height: 16px;
    color: #8fd6ff; font-style: italic; opacity: 0.9; word-break: break-word; }
.mpChatInputRow {
    display: flex;
    align-items: center; gap: 7px;
    padding: 6px;
    background: rgba(6, 18, 30, 0.94);
    border: 1px solid rgba(111, 199, 255, 0.55); border-top: none;
    border-radius: 0 0 7px 7px;
}
.mpChatInput {
    flex: 1 1 auto; min-width: 0; box-sizing: border-box;
    padding: 7px 9px;
    background: rgba(8, 26, 44, 0.9); color: #eaf7ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 13px; font-family: inherit; outline: none;
    user-select: text;
}
.mpChatInput:focus { box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpChatSend {
    flex: 0 0 auto; padding: 7px 13px; cursor: pointer;
    background: rgba(31, 111, 74, 0.9); color: #eafff2;
    border: 1px solid #7dffa8; border-radius: 4px;
    font-size: 12.5px; font-family: inherit; letter-spacing: 2px;
}
.mpChatSend:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }

/* Transient popup bubbles — the ONLY thing visible while the input is closed. */
.mpChatPops {
    position: fixed; left: 12px; bottom: 12px;
    display: flex; flex-direction: column; justify-content: flex-end;
    align-items: flex-start; gap: 6px;
    width: 440px; max-width: calc(100vw - 24px);
    z-index: 8999; pointer-events: none;
    font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
}
.mpChatPop {
    max-width: 100%;
    display: flex; align-items: flex-start;
    padding: 5px 9px;
    font-size: 12.5px; line-height: 17px;
    color: #eaf7ff;
    background: rgba(6, 18, 30, 0.82);
    border: 1px solid rgba(111, 199, 255, 0.4);
    border-radius: 5px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
    word-break: break-word;
    animation: mpChatPopIn 0.16s ease-out;
}
@keyframes mpChatPopIn { from { opacity: 0; transform: translateY(8px); }
                        to   { opacity: 1; transform: translateY(0); } }
.mpChatPop.mpPopWorld { border-left: 3px solid #ffffff; }
.mpChatPop.mpPopParty { border-left: 3px solid #6fc7ff; }
.mpChatPop.mpPopPrivate { border-left: 3px solid #ff9dd6; }
.mpPopTag { flex: 0 0 auto; margin-right: 6px; }
.mpChatPop.mpPopWorld .mpPopTag { color: #ffffff; }
.mpChatPop.mpPopParty .mpPopTag { color: #6fc7ff; }
.mpChatPop.mpPopPrivate .mpPopTag { color: #ff9dd6; }
.mpPopName { color: #9fe6b0; flex: 0 0 auto; margin-right: 5px; }
.mpPopText { flex: 1 1 auto; white-space: pre-wrap; }
.mpChatPop.mpPopSys .mpPopText { color: #8fd6ff; font-style: italic; }
`;
    document.head.appendChild(style);
}

// ---- panel DOM (hidden until the input opens) ----

function ensurePanel(): HTMLElement {
    if (panel) return panel;
    ensureChatStyle();
    ensureChannels();

    const root = document.createElement('div');
    root.className = 'mpChatBox';

    tabsEl = document.createElement('div');
    tabsEl.className = 'mpChatTabs';

    msgsEl = document.createElement('div');
    msgsEl.className = 'mpChatMsgs';

    inputRowEl = document.createElement('div');
    inputRowEl.className = 'mpChatInputRow';

    const form = document.createElement('form');
    form.className = 'mpChatForm';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'mpChatInput';
    input.autocomplete = 'off';
    const send = document.createElement('button');
    send.type = 'submit';
    send.className = 'mpChatSend';
    send.textContent = t('chatSend');
    form.appendChild(input);
    form.appendChild(send);
    inputRowEl.appendChild(form);

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        sendActive();
    });
    input.addEventListener('keydown', (e) => {
        if (!e) return;
        const anyE = e as any;
        if (anyE.isComposing || e.keyCode === 229) return;
        if (e.keyCode === 27) {
            e.preventDefault();
            closeInput();
        }
    });

    root.appendChild(tabsEl);
    root.appendChild(msgsEl);
    root.appendChild(inputRowEl);
    document.body.appendChild(root);

    panel = root;
    inputEl = input;
    renderTabs();
    renderMessages();
    return root;
}

// ---- rendering ----

/** Strip game text-command sequences (\c[..] colors, \i[..] icons, ...) so chat
 * text can't spoof system styling. textContent handles HTML escaping. */
function sanitizeChatText(text: string): string {
    return String(text || '').replace(/\\[a-zA-Z]\[[^\]]*\]/g, '');
}

function renderTabs(): void {
    if (!tabsEl) return;
    while (tabsEl.firstChild) tabsEl.removeChild(tabsEl.firstChild);
    for (const ch of channels) {
        const tab = document.createElement('div');
        tab.className = 'mpChatTab';
        if (ch.id === activeId) tab.className += ' active';
        if (ch.unread > 0) tab.className += ' unread';

        const label = document.createElement('span');
        label.textContent = ch.kind === 'private' ? String(ch.target || ch.id) : (ch.kind === 'party' ? t('chatParty') : t('chatWorld'));
        tab.appendChild(label);

        if (ch.unread > 0) {
            const badge = document.createElement('span');
            badge.className = 'mpChatUnread';
            badge.textContent = ch.unread > 99 ? '99+' : String(ch.unread);
            tab.appendChild(badge);
        }
        if (ch.kind === 'private') {
            const close = document.createElement('span');
            close.className = 'mpChatClose';
            close.textContent = '×';
            close.title = t('chatClosePrivate');
            close.addEventListener('click', (e) => {
                e.stopPropagation();
                const keepInput = chatOpen;
                closeChannel(ch.id);
                if (keepInput && inputEl) inputEl.focus();
            });
            tab.appendChild(close);
        }

        tab.addEventListener('click', () => {
            // Switching tabs always works; the input only opens when the game is in
            // a typeable state (never steal the keyboard mid-cutscene/menu).
            setActiveChannel(ch.id, canOpenChat());
            if (!chatOpen) {
                try { if (document.activeElement === tab) (tab as HTMLElement).blur(); } catch (_) { /* ignore */ }
                try { (ig as any).system.regainFocus(); } catch (_) { /* ignore */ }
            }
        });
        tabsEl.appendChild(tab);
    }
}

function renderMessages(): void {
    if (!msgsEl) return;
    while (msgsEl.firstChild) msgsEl.removeChild(msgsEl.firstChild);
    const ch = activeChannel();
    if (!ch) return;
    for (const m of ch.messages) {
        if (!m.from) {
            const row = document.createElement('div');
            row.className = 'mpChatSysRow';
            row.textContent = sanitizeChatText(m.text);
            msgsEl.appendChild(row);
            continue;
        }
        const row = document.createElement('div');
        row.className = 'mpChatRow';
        const name = document.createElement('span');
        name.className = 'mpChatName';
        name.textContent = sanitizeChatText(m.from) + ':';
        const text = document.createElement('span');
        text.className = 'mpChatText';
        text.textContent = sanitizeChatText(m.text);
        row.appendChild(name);
        row.appendChild(text);
        msgsEl.appendChild(row);
    }
    // Newest row always sits at the BOTTOM; older rows scroll away upward.
    msgsEl.scrollTop = msgsEl.scrollHeight;
}

/** Switch the active tab. `focus` opens (or re-focuses) the input strip so the
 * player can type right away — used by tab clicks and the 联系 buttons. */
function setActiveChannel(id: string, focus: boolean): void {
    const ch = getChannel(id);
    if (!ch) return;
    activeId = id;
    ch.unread = 0;
    if (panel) {
        renderTabs();
        renderMessages();
        updatePlaceholder();
    }
    if (focus) openInput();
    else if (chatOpen && inputEl) inputEl.focus();
}

// ---- transient popup bubbles (chat closed) ----

function channelTag(kind: ChatKind): string {
    return kind === 'party' ? t('chatParty') : kind === 'private' ? t('chatPrivate') : t('chatWorld');
}

function ensurePopupHost(): HTMLElement {
    if (popupHost) return popupHost;
    ensureChatStyle();
    const host = document.createElement('div');
    host.className = 'mpChatPops';
    document.body.appendChild(host);
    popupHost = host;
    return host;
}

function removePop(p: IPop): void {
    const idx = pops.indexOf(p);
    if (idx !== -1) pops.splice(idx, 1);
    try { if (p.timer) window.clearTimeout(p.timer); } catch (_) { /* ignore */ }
    try { if (p.el && p.el.parentNode) p.el.parentNode.removeChild(p.el); } catch (_) { /* ignore */ }
}

function clearPops(): void {
    for (const p of pops.slice()) removePop(p);
    pops = [];
    try { if (popupHost) popupHost.style.display = 'none'; } catch (_) { /* ignore */ }
}

/** Render one transient bottom-left bubble with its colored [世界]/[小队]/[私聊]
 * prefix. `from` empty => system line. The host is a bottom-anchored flex column:
 * appending the newest bubble keeps it at the BOTTOM and pushes older ones UP. */
function showPopup(kind: ChatKind, from: string, text: string): void {
    try {
        if (chatOpen) return; // the full panel is showing — no popups while it is
        const clean = sanitizeChatText(text);
        if (!clean) return;
        const host = ensurePopupHost();
        host.style.display = 'flex';
        const pop = document.createElement('div');
        pop.className = 'mpChatPop mpPop' + (kind === 'world' ? 'World' : kind === 'party' ? 'Party' : 'Private');
        if (!from) pop.className += ' mpPopSys';

        const tag = document.createElement('span');
        tag.className = 'mpPopTag';
        tag.textContent = '[' + channelTag(kind) + ']';
        pop.appendChild(tag);
        if (from) {
            const name = document.createElement('span');
            name.className = 'mpPopName';
            name.textContent = sanitizeChatText(from) + ':';
            pop.appendChild(name);
        }
        const body = document.createElement('span');
        body.className = 'mpPopText';
        body.textContent = clean;
        pop.appendChild(body);

        host.appendChild(pop);
        const p: IPop = { el: pop, timer: 0 };
        pops.push(p);
        while (pops.length > MAX_POPS) removePop(pops[0]);
        p.timer = window.setTimeout(() => removePop(p), POP_TTL_MS);
    } catch (_) { /* a popup must never break the frame */ }
}

// ---- input strip (the only time the full panel is visible) ----

function updatePlaceholder(): void {
    if (!inputEl) return;
    const ch = activeChannel();
    if (ch && ch.kind === 'private' && ch.target) {
        inputEl.placeholder = t('chatPrivatePh').replace('{name}', ch.target);
    } else {
        inputEl.placeholder = t('chatPlaceholder');
    }
}

/** Open the full panel + input. Popups are hidden (the panel replaces them).
 * Suppresses game key handling via ig.system.setFocusLost() (the login-panel
 * pattern); the focus listener keeps it while focus stays inside the panel and
 * closes the input if focus escapes the panel entirely. */
function openInput(): void {
    try {
        ensurePanel();
        if (!panel || !inputRowEl || !inputEl) return;
        if (chatOpen) {
            updatePlaceholder();
            inputEl.focus();
            return;
        }
        clearPops(); // panel replaces transient bubbles
        panel.classList.add('open');
        updatePlaceholder();
        renderTabs();
        renderMessages();

        const onFocus = (): void => {
            if (!chatOpen) return;
            try {
                const ae = document.activeElement;
                if (ae && panel && panel.contains(ae)) {
                    (ig as any).system.setFocusLost();
                    return;
                }
            } catch (_) { /* fall through to closing */ }
            closeInput();
        };
        // Register BEFORE chatOpen flips true (the login-panel pattern): if the
        // engine invokes the focus listener synchronously on registration, the
        // input isn't "open" yet and the callback is a harmless no-op.
        chatFocusListener = onFocus;
        try { (ig as any).system.addFocusListener(onFocus); } catch (_) { /* ignore */ }
        chatOpen = true;
        try { (ig as any).system.setFocusLost(); } catch (_) { /* ignore */ }
        inputEl.focus();
    } catch (_) { /* an open must never break the frame */ }
}

/** Close the input and hide the full panel again — back to popup-only mode.
 * Restores game focus exactly like showLogin — regainFocus + a block delay so
 * the closing key/click can't hit a game button. */
function closeInput(): void {
    if (!chatOpen) return;
    chatOpen = false;
    try {
        if (chatFocusListener) { (ig as any).system.removeFocusListener(chatFocusListener); chatFocusListener = null; }
    } catch (_) { /* ignore */ }
    try { if (panel) panel.classList.remove('open'); } catch (_) { /* ignore */ }
    try { if (inputEl) inputEl.blur(); } catch (_) { /* ignore */ }
    try { (ig as any).system.regainFocus(); } catch (_) { /* ignore */ }
    try { (ig as any).interact.setBlockDelay(0.2); } catch (_) { /* ignore */ }
}

function sendActive(): void {
    try {
        const main = getMain();
        const ch = activeChannel();
        if (!ch || !inputEl) { closeInput(); return; }
        const text = String(inputEl.value || '').trim();
        if (!text) { closeInput(); return; } // Enter with an empty box closes
        const conn: any = main && main.connection;
        if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) {
            addMessage(ch, '', t('chatNotConnected'), true);
            inputEl.value = '';
            inputEl.focus();
            return;
        }
        if (ch.kind === 'party' && (!main || !main.partyMembers || main.partyMembers.length <= 1)) {
            addMessage(ch, '', t('chatNotInParty'), true);
            inputEl.value = '';
            inputEl.focus();
            return;
        }
        if (ch.kind === 'private') {
            if (!ch.target || (main && ch.target === main.name)) {
                addMessage(ch, '', t('chatSelf'), true);
                inputEl.value = '';
                inputEl.focus();
                return;
            }
        }
        // Local echo; the server never echoes back to the sender.
        addMessage(ch, main ? main.name || '' : '', text, false);
        try { conn.chat(text, ch.kind, ch.target); } catch (_) { /* ignore */ }
        inputEl.value = '';
        inputEl.focus(); // MMO-style: stay open for the next message
    } catch (_) { /* a send must never break the frame */ }
}

// ---- messages / channels ----

function addMessage(ch: ChatChannel, from: string, text: string, system: boolean): void {
    ch.messages.push({ from: from || '', text: String(text || ''), ts: Date.now() });
    while (ch.messages.length > MAX_MESSAGES) ch.messages.shift();
    if (!system) savePersisted();
    if (chatOpen && panel && activeId === ch.id) renderMessages();
    else if (chatOpen && panel) renderTabs();
    else if (!chatOpen) showPopup(ch.kind, from || '', text);
}

function closeChannel(id: string): void {
    const idx = channels.findIndex((ch) => ch.id === id);
    if (idx === -1) return;
    const ch = channels[idx];
    if (ch.kind !== 'private') return;
    channels.splice(idx, 1);
    removePersisted(id);
    if (activeId === id) activeId = WORLD_ID;
    if (panel) {
        renderTabs();
        renderMessages();
        updatePlaceholder();
    }
    if (chatOpen && inputEl) inputEl.focus();
}

/**
 * Open (or create + focus) the private channel with `name`. This is the 联系
 * button path: quick-menu friend row and social-menu option both land here.
 */
export function openPrivateChannel(name: string, openInputNow = true): void {
    try {
        const clean = String(name || '').trim();
        if (!clean) return;
        ensureChannels();
        const main = getMain();
        if (main && main.name === clean) {
            addMessage(activeChannel(), '', t('chatSelf'), true);
            return;
        }
        const id = privateId(clean);
        ensureChannel(id, 'private', clean);
        setActiveChannel(id, openInputNow);
    } catch (_) { /* a channel open must never break the frame */ }
}

/** An incoming server-relayed chat message. While the panel is closed it becomes
 * a colored popup bubble; while open it lands in the matching channel tab (and
 * creates a private tab on demand when a new person messages us). */
export function receiveChat(msg: IChatMessage): void {
    try {
        if (!msg || typeof msg.text !== 'string' || !msg.text) return;
        const main = getMain();
        if (msg.from === (main && main.name)) return; // server never echoes; belt-and-braces
        const kind: ChatKind = msg.channel === 'world' || msg.channel === 'party' || msg.channel === 'private'
            ? msg.channel : 'party';
        ensureChannels();
        let id: string;
        let target: string | undefined;
        if (kind === 'private') {
            if (!msg.from) return;
            id = privateId(msg.from);
            target = msg.from;
        } else {
            id = kind;
        }
        const ch = ensureChannel(id, kind, target);
        const isActive = activeId === id;
        if (!isActive) ch.unread++;
        addMessage(ch, msg.from, msg.text, false);
        if (panel && !isActive) renderTabs();
    } catch (_) { /* a message must never break the socket */ }
}

/** Server rejection of an outgoing message -> a system line (popup or tab). */
export function receiveChatError(err: IChatError): void {
    try {
        let text = t('chatSendFailed');
        if (err && err.reason === 'rate') text = t('chatRateLimited');
        else if (err && err.reason === 'notInParty') text = t('chatNotInParty');
        else if (err && err.reason === 'offline') text = t('chatPrivateOffline').replace('{name}', err.target || '?');
        else if (err && err.reason === 'invalidTarget') text = t('chatInvalidTarget');
        let id = (err && err.channel) || activeId;
        if (id === 'private') id = (err && err.target) ? privateId(err.target) : activeId;
        ensureChannels();
        let ch = getChannel(id);
        if (!ch && id.indexOf(PRIVATE_PREFIX) === 0) {
            ch = ensureChannel(id, 'private', id.slice(PRIVATE_PREFIX.length));
        } else if (!ch) {
            ch = ensureChannel(id, id === PARTY_ID ? 'party' : 'world');
        }
        addMessage(ch, '', text, true);
    } catch (_) { /* an error must never break the socket */ }
}

/** Compatibility + internal system-line helper: show a message in the active tab
 * (or as a popup when the panel is closed). `from` empty => system line. */
export function displayChat(from: string, text: string): void {
    try {
        if (!text) return;
        ensureChannels();
        addMessage(activeChannel(), from || '', text, !from);
    } catch (_) { /* a message must never break the frame */ }
}

/** Party disbanded/kicked — keep world/private history intact; just annotate the
 * (permanent) party tab with a system line (popup when the panel is closed). A
 * player who has never used chat never sees this — the panel/popups only come
 * into existence after their first message. */
export function chatPartyDisbanded(): void {
    try {
        if (!channels.length && !panel && !popupHost) return; // chat never used
        ensureChannels();
        const ch = getChannel(PARTY_ID) || ensureChannel(PARTY_ID, 'party');
        addMessage(ch, '', t('chatPartyDisbanded'), true);
    } catch (_) { /* ignore */ }
}

/** Full session reset (logout / server loss): close the input, remove the DOM
 * panel + popup stack and drop every in-memory channel. Persisted per-account
 * history survives for the next login of the same account. */
export function clearChat(): void {
    try { closeInput(); } catch (_) { /* ignore */ }
    clearPops();
    try { if (panel && panel.parentNode) panel.parentNode.removeChild(panel); } catch (_) { /* ignore */ }
    try { if (popupHost && popupHost.parentNode) popupHost.parentNode.removeChild(popupHost); } catch (_) { /* ignore */ }
    panel = null;
    popupHost = null;
    tabsEl = null;
    msgsEl = null;
    inputRowEl = null;
    inputEl = null;
    channels = [];
    activeId = WORLD_ID;
}
