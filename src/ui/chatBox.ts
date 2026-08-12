import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';

/**
 * Round 23 wave 4 — PARTY CHAT.
 *
 * Press Enter in-game to open a bottom-center chat input (same navy/cyan visual
 * language as the login panel — see ensureChatStyle). Chat is PARTY-ONLY: the
 * server relays a `chat {text}` to every OTHER party member in the SAME map
 * instance, and the sender echoes locally (the server never echoes).
 *
 * Incoming messages render as a look-alike NPC dialogue box: an sc.ArrowBoxGui
 * (POINTER.TOP_RIGHT speech-bubble) + sc.TextGui (IMMEDIATE text speed) + a green
 * sender-name plate, stacked bottom-left in a persistent ig.gui overlay (zIndex
 * 7 — above the name tags / net-HUD). Messages auto-fade after ~8s and the stack
 * is capped at MAX_CHAT_MSGS (oldest dropped).
 *
 * The Enter hook is a CAPTURE-phase window keydown listener (never a rebind of
 * ig.KEY.ENTER / sc.control). It consumes the keypress — preventDefault +
 * stopPropagation — ONLY when it opens the chat or while the chat is open;
 * otherwise the event passes to the game untouched. It also refuses to fire when
 * the event target is an input/textarea/select/contentEditable (so typing in the
 * login/F8/add-friend boxes is never hijacked).
 *
 * Round 24 wave — HISTORY + FLIPPED BUBBLE.
 *  - The bubble pointer is vertically flipped (BOTTOM_RIGHT) so the tail points
 *    DOWN instead of up.
 *  - Chat history (last 50, client-local, persisted to localStorage) is recorded
 *    for every message that passes through displayChat — incoming and own-sent —
 *    and shown in a small panel above the input strip while the chat is open.
 *    The panel shows the newest 3 rows, scrolls smoothly on mouse wheel over it
 *    (capture-phase, so the game camera/menu never reacts), and pins to the
 *    bottom while the user is at the newest message.
 *  - Pressing Enter with an empty box now CLOSES the chat (previously a no-op).
 */

let getMain: () => Multiplayer | undefined = () => undefined;

let overlay: any = null;                 // persistent ig.GuiElementBase added to ig.gui
let messages: any[] = [];                // live message wrappers, newest LAST
let installed = false;                   // once-per-process keydown capture guard
let captureKeydown: ((e: KeyboardEvent) => void) | null = null;

// X1: the engine's ig.input.keydown/keyup saved once at install and replaced with
// wrappers that no-op while the chat input is open (game bindings must never fire
// while typing). The engine's own window listener is bound to the ORIGINAL at
// input-init time, so the capture-phase suppression in captureKeydown is the real
// gate; these wrappers are belt-and-braces for code paths that call them directly.
let origInputKeydown: ((a: any) => void) | null = null;
let origInputKeyup: ((a: any) => void) | null = null;

let chatOpen = false;                    // chat input currently shown
let inputBox: JQuery | null = null;      // the DOM strip
let inputEl: JQuery | null = null;       // the text input inside it
let chatFocusListener: (() => void) | null = null;

// Round 24 — persistent client-local chat history + the history panel shown above
// the input strip while the chat is open. History survives restarts (localStorage,
// write-through on every append). Rows are stored RAW and sanitized/escaped only
// at render time.
const HISTORY_KEY = 'mpChatHistory';
const MAX_HISTORY = 50;
const HIST_PANEL_ROWS = 3;               // rows visible in the panel at once
const HIST_ROW_H = 21;                   // px per history row (line-height)
const HIST_ROW_GAP = 1;                  // px gap between rows
const HIST_ROW_STEP = HIST_ROW_H + HIST_ROW_GAP;
const HIST_PANEL_H = HIST_PANEL_ROWS * HIST_ROW_STEP;
let history: { n: string, t: string, ts: number }[] = []; // newest LAST
let histPanel: HTMLElement | null = null;   // fixed container above the input strip
let histColumn: HTMLElement | null = null;  // scrollable inner column (newest at bottom)
let histWheelHandler: ((e: any) => void) | null = null;
let histOffset = 0;                      // float scroll offset, clamped to [0, maxHistOffset()]

const MAX_CHAT_MSGS = 4;
const CHAT_MSG_TTL_MS = 8000;
const CHAT_FADE_MS = 0.3;
const MSG_GAP = 8;
const MSG_MARGIN_X = 12;
const MSG_MARGIN_Y = 12;
const MSG_MAX_WIDTH = 340;

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
 * Enter key belongs to them, not to party chat. Same detection the modules
 * themselves use (gamecodeMessage / mpLogin class names). */
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
        // Board/private/tutorial message boxes (NOT cutscene-driven) also block
        // interact — but ig.interact.isBlocked() only covers blockTimer>0, which
        // expires ~0.1s after the box shows, so gate on the message model itself
        // (sc.model.message.isBlocking()).
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
    loadHistory(); // Round 24: restore the client-local history once per process
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
            // The engine routes DOM keys through ig.input.keydown (a window bubble
            // listener bound at input init), gated by hasFocusLost + a.target.type —
            // but the mod forces ig.system.hasFocusLost to ()=>false (disableFocus in
            // multiplayer.ts), which defeats the engine's text-input gate for any key
            // whose target ISN'T a text element. So we suppress here, in the capture
            // phase (which runs BEFORE the engine's bubble-phase window listener):
            // swallow every key not aimed at a text-entry element while the chat is
            // open. Typing in the chat input itself (target = the text input) still
            // passes through untouched, so the input element handles it normally.
            if (chatOpen) {
                if (code === 27) { // Escape cancels (X2) — consume in every case
                    e.preventDefault();
                    e.stopPropagation();
                    closeChatInput();
                    return;
                }
                if (code === 13 || code === 108) { // Enter / keypad Enter (X3)
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
                    openChat();
                }
                return;
            }
        } catch (_) { /* a key handler must never break input */ }
    };
    window.addEventListener('keydown', captureKeydown, true);

    // X1 belt-and-braces: wrap ig.input.keydown/keyup so game bindings cannot fire
    // while the chat input is open, for any code path that reaches them directly.
    // The engine's own window listener was bound to the ORIGINAL at input-init, so
    // the capture-phase suppression above is the primary gate; these wrappers are
    // harmless if the engine never calls them. When the chat closes (chatOpen=false)
    // they pass straight through to the originals — the suppression restores itself.
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

// ---- history (persistent client-local + the panel above the input strip) ----

/** Restore persisted history from localStorage (try/catch — storage may throw or
 * hold malformed data; any failure just starts empty). Called once at install. */
function loadHistory(): void {
    try {
        const raw = window.localStorage.getItem(HISTORY_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        const out: { n: string, t: string, ts: number }[] = [];
        for (let i = 0; i < parsed.length; i++) {
            const h = parsed[i];
            if (!h || typeof h !== 'object' || typeof h.t !== 'string') continue;
            out.push({
                n: typeof h.n === 'string' ? h.n : '',
                t: h.t,
                ts: typeof h.ts === 'number' ? h.ts : Date.now(),
            });
        }
        history = out.slice(-MAX_HISTORY);
    } catch (_) { history = []; /* storage/JSON failed — start empty */ }
}

/** Persist history (write-through on every append; the payload is tiny). */
function saveHistory(): void {
    try { window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) { /* ignore */ }
}

/** Record a message in history (RAW text; sanitization happens at render time),
 * cap at MAX_HISTORY (drop oldest), persist, and refresh the live panel so a new
 * message is reflected while the chat is open. Capture whether the panel was pinned
 * to the newest row BEFORE the append — history mutates first, so the pin check has
 * to run against the pre-append max offset. */
function appendHistory(from: string, text: string): void {
    try {
        const wasAtBottom = chatOpen && histOffset >= maxHistOffset() - 0.5;
        history.push({ n: from || '', t: String(text || ''), ts: Date.now() });
        if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
        saveHistory();
        if (chatOpen) refreshHistoryPanel(wasAtBottom);
    } catch (_) { /* a history write must never break the frame */ }
}

/** Highest scroll offset the panel can show: 0 when everything fits in the panel,
 * otherwise (total column height − panel height), so the newest row can rest at
 * the bottom of the panel. */
function maxHistOffset(): number {
    const rows = history.length;
    if (rows <= HIST_PANEL_ROWS) return 0;
    return Math.max(0, rows * HIST_ROW_STEP - HIST_PANEL_H);
}

/** Build ONE history row: green sender name (or nothing for a system line) + the
 * sanitized/HTML-escaped text. textContent handles HTML escaping; sanitizeChatText
 * strips any game \c[\..\] / \i[\..\] styling the sender might have typed. */
function renderHistoryRow(h: { n: string, t: string, ts: number }): HTMLElement {
    const row = document.createElement('div');
    row.className = 'mpChatHistRow';
    if (h.n) {
        const nm = document.createElement('span');
        nm.className = 'mpChatHistName';
        nm.textContent = sanitizeChatText(h.n) + ' ';
        row.appendChild(nm);
    }
    const tx = document.createElement('span');
    tx.className = 'mpChatHistText';
    tx.textContent = sanitizeChatText(h.t);
    row.appendChild(tx);
    return row;
}

/** Ease the inner column toward its scroll offset (CSS transition on translateY). */
function applyHistOffset(): void {
    const col = histColumn;
    if (!col) return;
    try {
        col.style.transition = 'transform 0.16s ease-out';
        col.style.transform = 'translateY(' + (-histOffset) + 'px)';
    } catch (_) { /* ignore */ }
}

/** Rebuild the inner column from history (newest LAST, i.e. newest at the bottom),
 * clamp the scroll offset, and — when the view is already at the newest row — pin it
 * to the new bottom so the live tail stays in view. `forcePin` is supplied by
 * appendHistory (pre-append state); when omitted (fresh panel build) it's derived
 * from the current offset. */
function refreshHistoryPanel(forcePin?: boolean): void {
    const col = histColumn;
    if (!col) return;
    try {
        const wasAtBottom = forcePin !== undefined ? forcePin : (histOffset >= maxHistOffset() - 0.5);
        while (col.firstChild) col.removeChild(col.firstChild);
        for (let i = 0; i < history.length; i++) col.appendChild(renderHistoryRow(history[i]));
        const mOff = maxHistOffset();
        if (wasAtBottom) histOffset = mOff; // pinned to newest while already at the bottom
        histOffset = Math.min(mOff, Math.max(0, histOffset));
        applyHistOffset();
    } catch (_) { /* never break the frame */ }
}

/** Build the history panel DOM (fixed container above the input strip + the
 * scrollable inner column) and seed it. Default view = bottom (newest). */
function buildHistoryPanel(): HTMLElement | null {
    try {
        const panel = document.createElement('div');
        panel.className = 'mpChatHist';
        const col = document.createElement('div');
        col.className = 'mpChatHistCol';
        panel.appendChild(col);
        histPanel = panel;
        histColumn = col;
        histOffset = maxHistOffset(); // default = newest at the bottom
        refreshHistoryPanel();
        return panel;
    } catch (_) { return null; }
}

/** Capture-phase wheel handler active ONLY while the chat is open (registered in
 * openChat, removed in closeChatInput). Mirrors the party-box wheel pattern: while
 * the pointer is over the panel, consume the event so ig.input.mousewheel — and the
 * game camera/menu scrolling — never sees it. Wheel up walks toward OLDER history,
 * wheel down toward NEWER (offset grows down). */
function onHistoryWheel(e: any): void {
    try {
        if (!histPanel) return;
        const target = e.target;
        if (!(target instanceof Node) || !histPanel.contains(target)) return;
        const mOff = maxHistOffset();
        if (mOff <= 0) { e.preventDefault(); e.stopPropagation(); return; }
        // Normalize direction across the modern 'wheel' (deltaY), legacy
        // 'mousewheel' (wheelDelta) and Firefox 'DOMMouseScroll' (detail).
        let up = false;
        if (typeof e.deltaY === 'number') up = e.deltaY < 0;
        else if (e.wheelDelta != null) up = e.wheelDelta > 0;
        else up = (e.detail || 0) < 0;
        const next = Math.min(mOff, Math.max(0, histOffset + (up ? -HIST_ROW_STEP : HIST_ROW_STEP)));
        if (next === histOffset) return;
        e.preventDefault();
        e.stopPropagation(); // keep the game camera/menu from reacting to the wheel
        histOffset = next;
        applyHistOffset();
    } catch (_) { /* never throw out of a DOM listener */ }
}

/** Attach the history-panel wheel listener (active only while the chat is open). */
function attachHistoryWheel(): void {
    histWheelHandler = onHistoryWheel;
    try { window.addEventListener('wheel', onHistoryWheel, true); } catch (_) { /* ignore */ }
    try { window.addEventListener('mousewheel', onHistoryWheel, true); } catch (_) { /* ignore */ }
    try { window.addEventListener('DOMMouseScroll', onHistoryWheel, true); } catch (_) { /* ignore */ }
}

/** Tear down the history-panel wheel listener + panel DOM (panel is a child of the
 * input strip, which closeChatInput removes; here we just drop the references). */
function detachHistory(): void {
    if (histWheelHandler) {
        try { window.removeEventListener('wheel', histWheelHandler, true); } catch (_) { /* ignore */ }
        try { window.removeEventListener('mousewheel', histWheelHandler, true); } catch (_) { /* ignore */ }
        try { window.removeEventListener('DOMMouseScroll', histWheelHandler, true); } catch (_) { /* ignore */ }
        histWheelHandler = null;
    }
    histPanel = null;
    histColumn = null;
}

// ---- chat input (DOM) ----

/** Inject the bottom-center input strip stylesheet exactly once (reuses the
 *  login panel's navy/cyan visual language, prefixed .mpChat). */
function ensureChatStyle(): void {
    if (document.getElementById('mpChatStyle')) return;
    const style = document.createElement('style');
    style.id = 'mpChatStyle';
    style.textContent = `
.mpChat {
    position: fixed; left: 50%; bottom: 24px;
    transform: translateX(-50%);
    width: 420px; max-width: 94vw;
    background: rgba(6, 18, 30, 0.94);
    border: 2px solid #6fc7ff; border-radius: 6px;
    box-shadow: 0 0 18px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    z-index: 10000; padding: 10px 12px;
    animation: mpChatIn 0.18s ease-out;
}
@keyframes mpChatIn { from { opacity: 0; transform: translateX(-50%) translateY(12px); }
                      to   { opacity: 1; transform: translateX(-50%) translateY(0); } }
.mpChatForm { display: flex; gap: 8px; }
.mpChatInput { flex: 1; min-width: 0; box-sizing: border-box; padding: 8px 10px;
    background: rgba(8, 26, 44, 0.9); color: #eaf7ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 14px; font-family: inherit; outline: none; }
.mpChatInput:focus { box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpChatSend { padding: 8px 16px; cursor: pointer;
    background: rgba(31, 111, 74, 0.9); color: #eafff2;
    border: 1px solid #7dffa8; border-radius: 4px;
    font-size: 14px; font-family: inherit; letter-spacing: 2px; }
.mpChatSend:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }
.mpChatHist {
    position: absolute; left: 50%; bottom: calc(100% + 4px);
    transform: translateX(-50%);
    width: 380px; max-width: 94vw;
    height: 66px;
    overflow: hidden;
    pointer-events: auto;
    background: rgba(4, 12, 20, 0.6);
    border: 1px solid rgba(111, 199, 255, 0.55); border-radius: 5px;
    z-index: 10001;
    font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
}
.mpChatHistCol { position: absolute; top: 0; left: 0; right: 0; will-change: transform; }
.mpChatHistRow {
    display: flex; align-items: flex-start;
    height: 21px; line-height: 21px;
    font-size: 12px; color: #eaf7ff;
    background: rgba(6, 18, 30, 0.85);
    margin-bottom: 1px; padding: 0 8px;
    white-space: nowrap;
}
.mpChatHistName { color: #7dffa0; flex: 0 0 auto; }
.mpChatHistText { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
    document.head.appendChild(style);
}

/** Close the chat input (idempotent): restore game focus exactly like showLogin —
 * regainFocus + a block delay so the closing key/click can't hit a game button. */
function closeChatInput(): void {
    if (!chatOpen) return;
    chatOpen = false;
    try {
        if (chatFocusListener) { (ig as any).system.removeFocusListener(chatFocusListener); chatFocusListener = null; }
    } catch (_) { /* ignore */ }
    const box = inputBox;
    inputBox = null;
    inputEl = null;
    try { if (box) box.remove(); } catch (_) { /* ignore */ }
    detachHistory(); // Round 24: hide + teardown the history panel (wheel + DOM)
    try { (ig as any).system.regainFocus(); } catch (_) { /* ignore */ }
    try { (ig as any).interact.setBlockDelay(0.2); } catch (_) { /* ignore */ }
}

/** Open the bottom-center chat input. Suppresses game key handling via
 * ig.system.setFocusLost() (the login-panel pattern); the focus listener re-applies
 * it while the input holds focus and closes the box if focus escapes it. */
function openChat(): void {
    if (chatOpen) return;
    try {
        ensureChatStyle();
        const box = $('<div class="mpChat"></div>');
        const input = $('<input type="text" class="mpChatInput" />');
        input.attr('placeholder', t('chatPlaceholder'));
        const send = $('<button type="submit" class="mpChatSend">' + t('chatSend') + '</button>');
        const form = $('<form class="mpChatForm"></form>');

        const sendText = (): void => {
            const text = String(input.val() || '').trim();
            // Round 24: Enter with an empty box CLOSES the chat (no send, no
            // system message) instead of silently doing nothing.
            if (!text) { closeChatInput(); return; }
            const main = getMain();
            if (!main) { closeChatInput(); return; }
            const conn: any = main.connection;
            if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) { closeChatInput(); return; }
            // Party-only: outside a party, sending shows a local-only system message
            // in the chat display and nothing is emitted. Keep the box open so the
            // player reads it, then Escape cancels.
            if (!main.partyMembers || main.partyMembers.length <= 1) {
                displayChat('', t('chatNotInParty'));
                input.val('');
                input.focus();
                return;
            }
            // In a party: local echo + emit. The server never echoes to the sender.
            displayChat(main.name || '', text);
            try { conn.chat(text); } catch (_) { /* ignore */ }
            closeChatInput();
        };

        // Mirror showLogin's focus management: while the input holds focus keep the
        // game focus-lost; if focus escapes (user clicked into the world, a menu
        // stole it) close the box so the game never stays in a half-input state.
        const onFocus = (): void => {
            if (!chatOpen) return;
            if (inputEl && inputEl[0] && document.activeElement === inputEl[0]) {
                try { (ig as any).system.setFocusLost(); } catch (_) { /* ignore */ }
                return;
            }
            closeChatInput();
        };
        chatFocusListener = onFocus;
        try { (ig as any).system.addFocusListener(onFocus); } catch (_) { /* ignore */ }

        // Enter sends (form submit — implicit submission works with a single input +
        // the submit button; the capture hook above lets it through to this input).
        form.submit(() => { sendText(); return false; });
        // Escape cancels. IME (CJK) composition keydowns (229 / isComposing) pass
        // through so a composition-commit Enter never closes or sends the box.
        input.on('keydown', (e: any) => {
            if (!e) return;
            if (e.isComposing || e.keyCode === 229) return;
            if (e.keyCode === 27) { e.preventDefault(); closeChatInput(); return false; }
        });

        form.append(input).append(send);
        box.append(form);
        // Round 24: the history panel is a child of the fixed .mpChat strip, so it
        // shares its exact left/bottom anchoring automatically (sits just above it).
        const histPanelEl = buildHistoryPanel();
        if (histPanelEl) box.append(histPanelEl);
        $(document.body).append(box);

        inputBox = box;
        inputEl = input;
        chatOpen = true;
        attachHistoryWheel(); // wheel over the panel scrolls history only while open
        try { (ig as any).system.setFocusLost(); } catch (_) { /* ignore */ }
        input.focus();
    } catch (_) { /* an open must never break the frame */ }
}

// ---- message display overlay (in-canvas, NPC-dialogue look-alike) ----

/** Persistent ig.gui overlay that owns every rendered chat message. Created once;
 * zIndex 7 (above name tags' 5 and the net-HUD's 6). */
function ensureOverlay(): any {
    if (overlay) return overlay;
    overlay = new (ig as any).GuiElementBase();
    try { overlay.hook.zIndex = 7; } catch (_) { /* ignore */ }
    try { overlay.hook._visible = true; } catch (_) { /* ignore */ }
    try { (ig as any).gui.addGuiElement(overlay); } catch (_) { /* ignore */ }
    return overlay;
}

/** The speech-bubble pointer enum — Round 24: vertically flipped so the tail/
 * arrow points DOWN (it previously pointed up). The game enum (see
 * ultimate-crosscode-typedefs boxes.d.ts) is NONE=0, TOP_LEFT=1, BOTTOM_LEFT=2,
 * TOP_RIGHT=3, BOTTOM_RIGHT=4 — the vertical mirror of TOP_RIGHT is BOTTOM_RIGHT.
 * Returns BOTTOM_RIGHT when exposed, else the numeric mirror of TOP_RIGHT (top+1,
 * i.e. 4). */
function chatPointer(): any {
    const box: any = (sc as any).ArrowBoxGui;
    const ptr = box && box.POINTER;
    if (ptr && ptr.BOTTOM_RIGHT != null) return ptr.BOTTOM_RIGHT;
    const top = ptr && ptr.TOP_RIGHT;
    return top != null ? top + 1 : 4;
}

/** Build ONE chat message: an ArrowBoxGui speech bubble (IMMEDIATE text) plus a
 * green sender-name plate above it, wrapped in a gui element auto-expiring after
 * CHAT_MSG_TTL_MS (fade via the gui loop, then remove + relayout). `from` empty =>
 * system message (no name plate). */
function makeMessageEl(from: string, text: string): any {
    const msg = new (sc as any).TextGui(String(text), {
        font: (sc as any).fontsystem.font,
        maxWidth: MSG_MAX_WIDTH,
    });
    try { msg.setTextSpeed((ig as any).TextBlock.SPEED.IMMEDIATE); } catch (_) { /* ignore */ }
    const ms = msg.hook.size;
    const PAD_X = 12;
    const PAD_Y = 8;
    const boxW = ms.x + PAD_X * 2;
    const boxH = ms.y + PAD_Y * 2;

    const bubble = new (sc as any).ArrowBoxGui(boxW, boxH, chatPointer());
    bubble.addChildGui(msg);
    msg.setPos(PAD_X, PAD_Y);

    const wrap = new (ig as any).GuiElementBase();
    let name: any = null;
    let nameH = 0;
    if (from) {
        // Green sender plate above the bubble (\c[2] = the game's green text set).
        name = new (sc as any).TextGui('\\c[2]' + from, { font: (sc as any).fontsystem.smallFont });
        wrap.addChildGui(name);
        name.setPos(2, 0);
        nameH = name.hook.size.y + 3;
    }
    wrap.addChildGui(bubble);
    bubble.setPos(0, nameH);
    try {
        wrap.setSize(Math.max(name ? name.hook.size.x : 0, boxW), nameH + boxH);
    } catch (_) { /* ignore */ }
    try { wrap.hook._visible = true; } catch (_) { /* ignore */ }
    wrap._mpBubble = bubble;
    wrap._mpName = name;

    // Auto-expire after ~8s: fade out (the gui loop drives the transition), then
    // detach + relayout. Guarded so a clearChat race can't double-remove.
    wrap._mpTimer = window.setTimeout(() => {
        try {
            const spl = (window as any).KEY_SPLINES;
            if (spl && spl.EASE && typeof wrap.doTempStateTransition === 'function') {
                wrap.doTempStateTransition({ alpha: 0 }, CHAT_FADE_MS, spl.EASE, false, true, () => {
                    try { removeMessage(wrap); } catch (_) { /* ignore */ }
                });
            } else {
                try { removeMessage(wrap); } catch (_) { /* ignore */ }
            }
        } catch (_) { /* ignore */ }
    }, CHAT_MSG_TTL_MS);

    return wrap;
}

/** Detach + forget a message wrapper (idempotent), then reflow the stack. */
function removeMessage(wrap: any): void {
    const idx = messages.indexOf(wrap);
    if (idx !== -1) messages.splice(idx, 1);
    try { if (wrap._mpTimer) window.clearTimeout(wrap._mpTimer); } catch (_) { /* ignore */ }
    try { overlay && overlay.removeChildGui(wrap); } catch (_) { /* ignore */ }
    layoutMessages();
}

/** Reflow the bottom-left stack: newest at the bottom, older upward. */
function layoutMessages(): void {
    try {
        const sys: any = (ig as any).system;
        if (!sys) return;
        let y = sys.height - MSG_MARGIN_Y;
        for (let i = messages.length - 1; i >= 0; i--) {
            const el = messages[i];
            if (!el) continue;
            const h = el.hook && el.hook.size ? el.hook.size.y : 0;
            y -= h;
            try { el.setPos(MSG_MARGIN_X, y); } catch (_) { /* ignore */ }
            y -= MSG_GAP;
        }
    } catch (_) { /* never break the frame */ }
}

/** Strip game text-command sequences (\c[..] colors, \i[..] icons, \s[..] and
 * friends) from a message BODY so a party member can't spoof system styling/
 * effects. The mod's own name-plate prefix (\c[2]) is added in makeMessageEl and
 * is untouched — this only scrubs the message text itself. */
function sanitizeChatText(text: string): string {
    return String(text || '').replace(/\\[a-zA-Z]\[[^\]]*\]/g, '');
}

/** Show a chat message in the overlay. `from` empty => system message (no plate). */
export function displayChat(from: string, text: string): void {
    try {
        // Round 24: persist the RAW message (incoming AND own-sent both funnel
        // through here) before rendering — sanitization happens at render time.
        // System lines (from === '') are shown in the overlay but NOT persisted:
        // they would pollute the cap-50 cross-session log with locale-bound text.
        if (from) appendHistory(from, text);
        const ov = ensureOverlay();
        if (!ov) return;
        // Cap the stack: drop the oldest live message first.
        while (messages.length >= MAX_CHAT_MSGS) {
            const old = messages.shift();
            if (old) removeMessage(old);
        }
        const el = makeMessageEl(from || '', sanitizeChatText(text));
        messages.push(el);
        try { ov.addChildGui(el); } catch (_) { /* ignore */ }
        layoutMessages();
    } catch (_) { /* a message must never break the frame */ }
}

/** Clear every rendered message + close the input. Called on party disband /
 * logout / server loss so no chat residue leaks into the next session. */
export function clearChat(): void {
    try {
        for (let i = 0; i < messages.length; i++) {
            const w = messages[i];
            try { if (w && w._mpTimer) window.clearTimeout(w._mpTimer); } catch (_) { /* ignore */ }
            try { if (overlay) overlay.removeChildGui(w); } catch (_) { /* ignore */ }
        }
        messages = [];
    } catch (_) { /* ignore */ }
    closeChatInput();
}
