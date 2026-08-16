import { Multiplayer } from '../multiplayer';
import { dropNameTag, wipeAllNameTags } from './mpOptions';
import { t } from '../i18n';
import { showMpToast } from './toasts';
import { openPrivateChannel } from './chatBox';

/**
 * Social-menu overhaul (replaces the old L-key overlay). Injects into the game's
 * native party/social menu (sc.MENU_SUBMENU.SOCIAL) so real multiplayer players
 * show up through the game's own list/rendering pipeline:
 *
 *  1. "加好友" chip in the top bar — sends a friend REQUEST; once the target
 *     accepts, the native 朋友 (FRIEND) tab lists them on BOTH sides.
 *  2. Confirmed friends are injected into sc.party.contacts/models as
 *     pseudo-contacts so the native friends tab renders them with an online dot.
 *  3. A "房间玩家" tab lists the players currently in the same map instance.
 *  4. The server online count is shown as a chip in the top bar (上边栏).
 *
 * All injected state is scoped to the logged-in account: when the account changes
 * (someone reuses this client to log in as another user), the previous account's
 * injected models/contacts are stripped so you never see another user's friends.
 *
 * Invite/remove on an injected player is intercepted and routed to the server
 * (partyInvite / partyLeave) instead of the game's single-player SOCIAL_ACTION
 * event (which returns null for our pseudo-contacts and crashed with
 * "addEventAttached of null").
 */

// sc.PARTY_MEMBER_TYPE — keep in sync with the game.
const PARTY_MEMBER_TYPE = { UNKNOWN: 0, CONTACT: 1, FRIEND: 2 };

// ---- bot friends (round 28: re-add accidentally-removed companions) ----
// Official game companion BOTS: server-side virtual accounts (CCMultiplayerServer/
// bots.js). A removed bot friend is re-added through the normal add-friend flow;
// the server auto-accepts instantly. The story gate below decides whether the
// add button is enabled.
// BOT_ACCOUNTS MUST match the server's BOT_NAMES EXACTLY (same spelling, same
// order). BOT_CONTACT_KEY maps each bot account name to its native party
// contact key in sc.PARTY_OPTIONS — the game's contacts list is keyed by the
// INTERNAL character id, which differs from the player-facing name for some
// companions ('Glasses' = C'tron, 'Luke' = Lukas).
const BOT_ACCOUNTS: string[] = ['Emilie', "C'tron", 'Apollo', 'Joern', 'Lukas', 'Schneider', 'Shizuka', 'Buggy', 'Hlin'];
const BOT_CONTACT_KEY: { [name: string]: string } = {
    'Emilie': 'Emilie',
    "C'tron": 'Glasses',
    'Apollo': 'Apollo',
    'Joern': 'Joern',
    'Lukas': 'Luke',
    'Schneider': 'Schneider',
    'Shizuka': 'Shizuka',
    'Buggy': 'Buggy',
    'Hlin': 'Hlin',
};

/** Story gate for bot friends: a companion may only be added once the story has
 * actually reached them — i.e. their native party contact is no longer UNKNOWN
 * (sc.PARTY_MEMBER_TYPE: UNKNOWN = never met, CONTACT = met, FRIEND = party
 * member). Contacts are keyed by the internal character id (BOT_CONTACT_KEY).
 * Anything missing/unknown fails closed (button stays disabled).
 * ROUND 32 (item 6): a bot friend already on the room tab can leave a SENTINEL
 * contact under the companion's native id (status PARTY_MEMBER_TYPE_MP = 9). That
 * sentinel is a mod artifact, NOT a story unlock — never count it, or a bot the
 * player met then partied with stays "unlocked" forever even after the story
 * contact would read UNKNOWN again. Only an engine-native status counts. */
function isBotUnlocked(name: string): boolean {
    const key = BOT_CONTACT_KEY[name];
    if (!key) return false;
    try {
        const party: any = (sc as any).party;
        if (!party || !party.contacts) return false;
        const c = party.contacts[key];
        if (!c || typeof c.status !== 'number') return false;
        if (c.status === PARTY_MEMBER_TYPE_MP) return false; // our sentinel is NOT a story unlock
        return c.status > PARTY_MEMBER_TYPE.UNKNOWN;
    } catch (_) { /* the gate itself must never throw */ }
    return false;
}

// Round 27 (item 1): FUZZY search means the add action is no longer limited to the
// exact-typed name — ANY matching row can be added. Centralize the row's action
// area (add button / already-friends / pending / locked-bot) so every result row
// gets it, not just the `name === query` row. Module scope (like isBotUnlocked):
// reads state/main through the module bridges _stateRef/_mainRef.
function appendFriendRowAction(row: JQuery, p: { name: string, online: boolean, level?: number }): void {
    const state = _stateRef;
    if (state.friends.some((f) => f.name === p.name)) {
        row.append('<span class="mpDisabled">' + t('alreadyFriends') + '</span>');
    } else if ((state.requests.outgoing || []).some((r) => r.name === p.name)) {
        row.append('<span class="mpDisabled">' + t('requestPending') + '</span>');
    } else if (BOT_ACCOUNTS.indexOf(p.name) !== -1 && !isBotUnlocked(p.name)) {
        // Round 28: a BOT companion (official game follower) whose story progress
        // hasn't reached it yet — no add button until the companion is unlocked
        // (native contact != UNKNOWN).
        row.append('<span class="mpDisabled">' + t('botNotUnlocked') + '</span>');
    } else {
        const btn = $('<button class="mpBtn mpPrimary">' + t('friendAddBtn') + '</button>');
        btn.on('click', () => {
            const conn = _mainRef() && _mainRef()!.connection;
            if (conn) {
                try { conn.friendAdd(p.name); } catch (_) { /* ignore */ }
                btn.prop('disabled', true).addClass('mpDisabled');
            }
            try { (ig.interact as any).setBlockDelay(0.2); } catch (_) { /* ignore */ }
        });
        row.append(btn);
    }
}

// Custom mp pseudo-contact status. Entries live in sc.party.contacts so
// SocialEntryButton can render them (its init reads contacts[key].online), but the
// status matches NO native tab type — so room players, the local player and
// friend-request entries never leak into the native 联系人/好友 lists (only the
// room/requests tabs render them, via getMemberList). Must stay off CONTACT(1)
// and FRIEND(2).
const PARTY_MEMBER_TYPE_MP = 9;

interface IMpSocialState {
    friends: Array<{ name: string, online: boolean }>;
    roomPlayers: string[];
    /** Username hosting the caller's current block instance (round 9). */
    roomHost?: string;
    onlineCount: number;
    /** Username -> assigned face character name (a sc.PARTY_OPTIONS entry). */
    faceFor: { [username: string]: string };
    /** The account these injected models/contacts belong to (isolation key). */
    account?: string;
    /** The actual username currently shown in the info box (survives per-frame overwrites). */
    shownName?: string;
    refreshTimer?: any;
    /** Round 23 wave 3: pending friend requests (incoming = I can act on, outgoing = I sent). */
    requests: { incoming: Array<{ name: string, online: boolean }>, outgoing: Array<{ name: string, online: boolean }> };
    /** Round 23 wave 3: DOM state for the search-then-add friend window. */
    addFriendBox?: JQuery | null;
    addFriendApply?: ((players: Array<{ name: string, online: boolean, level?: number }>) => void) | null;
    addFriendFocusHandler?: (() => void) | null;
    addFriendMousedown?: ((e: MouseEvent) => void) | null;
    searchQuery?: string;
    /** Round 24: the 申请管理 tab renders through the native member list (no DOM
     * panel). requestsDirty = the cached payload changed and the requests list
     * should rebuild; requestsLoading = a friendRequests refetch is in flight
     * (guards the menu-open fetch from double-firing). */
    requestsDirty?: boolean;
    requestsLoading?: boolean;
    /** Round 27: the user has VIEWED the requests tab since the last NEW incoming
     * request arrived — its native star is served its purpose and stays down
     * until a genuinely new incoming request arrives (outgoing never counts). */
    requestsViewed?: boolean;
}

// Character names that provide a face/head + model. Mirrored from
// sc.PARTY_OPTIONS at runtime if available (fallback to a safe subset).
function partyFaceOptions(): string[] {
    const opts = (sc as any).PARTY_OPTIONS;
    if (opts && opts.length) return opts.slice();
    return ['Lea', 'Emilie', 'Sergey', 'Schneider', 'Hlin', 'Grumpy', 'Buggy', 'Glasses', 'Apollo', 'Joern', 'Triblader1', 'Luke'];
}

/** ROUND 32 (item 6): is `name` an ENGINE-owned NATIVE contact id — a key the game
 * itself registered in sc.party.contacts (a companion like Emilie/Glasses/Apollo),
 * regardless of whether that contact is currently met (status UNKNOWN) or not. This
 * is the acid test for "this contact belongs to the engine, not to our mod": a mod
 * bot account whose display name happens to equal a companion still renders as an
 * mp entry, but the underlying native contact is NEVER rewritten/stamped. Distinct
 * from isEngineOwnedContact (which also treats currentParty members + the
 * PARTY_OPTIONS roster as engine-owned). Reads the live sc.PARTY_OPTIONS set so a
 * companion alias ('Glasses', 'Luke') and its account id ('C'tron', 'Lukas') both
 * resolve. */
function isNativeContactKey(name: string): boolean {
    if (!name) return false;
    try {
        const opts: string[] = (sc as any).PARTY_OPTIONS || [];
        if (opts.indexOf(name) !== -1) return true;
    } catch (_) { /* never throw */ }
    // The bot ACCOUNT ids that alias to a native contact (a companion's display
    // name). A native contact ALWAYS exists under its internal id, so if the account
    // id maps to one, treat the account id as native-owned too.
    try { if (BOT_CONTACT_KEY[name]) return true; } catch (_) { /* ignore */ }
    return false;
}

// Module-level bridges: the real state object and main accessor live inside the
// installSocialMenuButton closure; isOnlineMp/partyIsFull (module scope) reach
// them through these, wired once at install time.
let _mainRef: () => Multiplayer | undefined = () => undefined;
let _stateRef: IMpSocialState = { friends: [], roomPlayers: [], onlineCount: 0, faceFor: {}, requests: { incoming: [], outgoing: [] } };

// Round 27: the 申请管理 TabButton instance (stashed when the SocialList builds
// it) — the requests-tab star overlay lives on it. Read by updateRequestsStar.
let _requestsTabBtn: any = null;

// Round 23 review: module-level teardown/confirm bridges into the install
// closure — multiplayer.ts calls closeMpWindows() on logout/server-loss so an
// open mp window can't survive into the next session, and quickMenuInject routes
// its friend-remove through the same confirm window used here.
let _mpWindowTeardown: (() => void) | null = null;
let _confirmRemoveRef: ((name: string, onConfirm: () => void) => void) | null = null;
let _showMpWindowRef: ((opts: { title: string, content: string, buttons: Array<{ label: string, style?: string, cb: () => void }> }) => (() => void) | null) | null = null;
let _showStartModeWindowRef: ((opts: {
	title: string;
	body: string;
	options: Array<{ mode: 'fresh' | 'bridge'; title: string; description: string; tag: string; recommended: boolean }>;
	onPick: (mode: 'fresh' | 'bridge') => void;
}) => (() => void) | null) | null = null;

/** Close every open social-menu mp window (accept/decline, withdraw, friend-remove
 * confirm) + the add-friend box. Safe to call any time (no-ops when nothing is
 * open). Wired for logout/server-loss cleanup. */
export function closeMpWindows(): void {
    if (_mpWindowTeardown) { try { _mpWindowTeardown(); } catch (_) { /* ignore */ } }
}

/** ROUND 86: open a system dialog (disconnect / server updated) in the SAME
 * login-panel mpWin style as the social confirm windows. Wired at install time;
 * returns its close handle so the caller can dismiss it when the socket recovers. */
export function showMpWindow(opts: { title: string, content: string, buttons: Array<{ label: string, style?: string, cb: () => void }> }): (() => void) | null {
    if (_showMpWindowRef) { try { return _showMpWindowRef(opts); } catch (_) { /* ignore */ } }
    return null;
}

/** ROUND 119: first-login start-mode chooser — the two big square cards. Wired at
 * install time like showMpWindow; multiplayer.ts calls it before launching the game. */
export function showStartModeWindow(opts: {
	title: string;
	body: string;
	options: Array<{ mode: 'fresh' | 'bridge'; title: string; description: string; tag: string; recommended: boolean }>;
	onPick: (mode: 'fresh' | 'bridge') => void;
}): (() => void) | null {
    if (_showStartModeWindowRef) { try { return _showStartModeWindowRef(opts); } catch (_) { /* ignore */ } }
    return null;
}

/** Route a friend-removal through the same confirm window the social menu uses.
 * Falls back to acting directly when the social inject isn't installed. */
export function confirmRemoveFriendMp(name: string, onConfirm: () => void): void {
    if (_confirmRemoveRef) { try { _confirmRemoveRef(name, onConfirm); } catch (_) { /* ignore */ } }
    else onConfirm(); // no confirm window available — act directly
}

/** Round 23 wave 3: party-invite in-flight guard — while true the 邀请 button is
 * disabled (the server's partyActionResult hasn't arrived yet). Set when an invite
 * is sent, cleared on the result (or after a safety timeout). */
let _mpInviteGuard = false;
let _mpInviteGuardTimer: any = null;
export function setInviteGuard(on: boolean): void {
    _mpInviteGuard = on;
    if (on) {
        if (_mpInviteGuardTimer) { clearTimeout(_mpInviteGuardTimer); _mpInviteGuardTimer = null; }
        // Safety: a lost result must not leave the invite button dead forever.
        _mpInviteGuardTimer = setTimeout(() => { _mpInviteGuard = false; _mpInviteGuardTimer = null; }, 12000);
    } else if (_mpInviteGuardTimer) {
        clearTimeout(_mpInviteGuardTimer);
        _mpInviteGuardTimer = null;
    }
}
function inviteGuardActive(): boolean {
    return _mpInviteGuard;
}

/**
 * Round 23 wave 3: shared "mp window" stylesheet — the login-panel visual language
 * (dark navy rgba(6,18,30,0.94), cyan #6fc7ff accents, Noto Sans SC) factored into
 * one block reused by the add-friend window, the accept/decline + withdraw windows,
 * the friend-remove confirm, and the 申请管理 tab panel. Injected exactly once.
 */
function ensureMpWindowStyle(): void {
    if (document.getElementById('mpWinStyle')) return;
    const style = document.createElement('style');
    style.id = 'mpWinStyle';
    style.textContent = `
.mpWin { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 420px; max-width: 92vw;
    background: rgba(6, 18, 30, 0.94);
    border: 2px solid #6fc7ff; border-radius: 6px;
    box-shadow: 0 0 18px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    z-index: 10000; padding: 16px 18px 14px 18px;
    animation: mpWinIn 0.22s ease-out; }
@keyframes mpWinIn { from { opacity: 0; transform: translate(-50%, -50%) translateY(16px); }
                     to   { opacity: 1; transform: translate(-50%, -50%) translateY(0); } }
.mpWinHead { display: flex; align-items: center;
    border-bottom: 1px solid rgba(111,199,255,0.4); padding-bottom: 8px; margin-bottom: 12px; }
.mpWinTitle { font-size: 15px; letter-spacing: 2px; color: #dff3ff; }
.mpWinClose { margin-left: auto; width: 24px; height: 24px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #dff3ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 14px; line-height: 22px; text-align: center; font-family: inherit; }
.mpWinClose:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpWinInput { width: calc(100% - 96px); box-sizing: border-box; padding: 8px 10px; margin-bottom: 8px;
    background: rgba(8, 26, 44, 0.9); color: #eaf7ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 14px; font-family: inherit; outline: none; }
.mpWinInput:focus { box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpSearchForm { display: flex; gap: 8px; align-items: center; }
/* Round 25: the 搜索 button must sit on the SAME row as the input, at the SAME
   height, and be WIDER. The global .mpWinInput margin-bottom (8px) shifts the
   input off the button's row inside the flex form — zero it here (scoped so the
   input keeps its margin wherever else it is used). The button takes the
   input's exact padding + border-box height and a wider horizontal padding
   (min-width keeps the button substantial regardless of label length). */
.mpSearchForm .mpWinInput { margin-bottom: 0; }
.mpSearchForm .mpBtn { padding: 8px 20px; font-size: 14px; box-sizing: border-box; min-width: 84px; text-align: center; }
.mpWinHint { font-size: 12px; color: #ff9d9d; min-height: 15px; margin: 2px 0 8px 0; }
.mpWinBtns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
.mpWinMsg { font-size: 13px; line-height: 1.6; color: #eaf7ff; }
.mpWinName { font-size: 16px; color: #dff3ff; letter-spacing: 1px; }
.mpWinLvl { font-size: 12px; color: #8fd6ff; margin-top: 4px; }
.mpBtn { padding: 4px 12px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #dff3ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 12px; font-family: inherit; letter-spacing: 1px; }
.mpBtn:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpBtn:disabled { opacity: 0.5; cursor: default; }
.mpBtn.mpPrimary { background: rgba(31, 111, 74, 0.9); border-color: #7dffa8; color: #eafff2; }
.mpBtn.mpPrimary:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }
.mpBtn.mpBtnDanger { background: rgba(140, 58, 52, 0.9); border-color: #ff9d9d; color: #ffecec; }
.mpBtn.mpBtnDanger:hover { background: rgba(178, 74, 66, 0.95); box-shadow: 0 0 8px rgba(255,157,157,0.6); }
.mpSearchResults { max-height: 46vh; overflow-y: auto; margin-top: 4px; }
.mpRow { display: flex; align-items: center; gap: 10px; padding: 7px 10px; margin-bottom: 6px;
    background: rgba(18, 50, 72, 0.7); border: 1px solid rgba(111,199,255,0.3); border-radius: 4px; }
.mpRow.mpRowClick { cursor: pointer; }
.mpRow.mpRowClick:hover { background: rgba(46, 104, 142, 0.85); border-color: #6fc7ff; }
.mpRowName { font-size: 13px; color: #dff3ff; flex: 1 1 auto; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mpRowLvl { font-size: 12px; color: #8fd6ff; flex-shrink: 0;
    min-width: 64px; margin-right: 8px; }
.mpRowSpacer { flex: 1 1 auto; }
.mpDisabled { font-size: 12px; color: #6f93ad; opacity: 0.9; }
.mpSectionLabel { font-size: 12px; letter-spacing: 1px; color: #8fd6ff; margin: 14px 0 6px 0; }
.mpEmpty { font-size: 12px; color: #6f93ad; text-align: center; padding: 10px; }
/* ROUND 119 - first-login start choice: two BIG SQUARE cards fill most of the
   window. Each card is the button itself (title + recommendation tag + the
   explanation of what that start means). */
.mpWin.mpWinStart { width: 680px; max-width: 94vw; padding: 18px 20px 20px 20px; }
.mpWin.mpWinStart .mpWinHead { margin-bottom: 10px; }
.mpWin.mpWinStart .mpWinBtns { display: none; }
.mpWin.mpWinStart .mpWinMsg { width: 100%; }
.mpStartBody { font-size: 13px; line-height: 1.6; color: #eaf7ff;
    text-align: center; margin: 0 auto 14px auto; max-width: 560px; }
.mpStartGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; width: 100%; }
.mpStartCard { box-sizing: border-box; width: 100%; aspect-ratio: 1 / 1; min-height: 300px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; padding: 22px 20px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #eaf7ff;
    border: 2px solid #6fc7ff; border-radius: 10px;
    font-family: inherit; text-align: center;
    transition: transform 0.12s ease-out, background 0.12s ease-out, box-shadow 0.12s ease-out; }
.mpStartCard:hover { transform: translateY(-3px);
    background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 12px rgba(111,199,255,0.65); }
.mpStartCard:active { transform: translateY(0); }
.mpStartCard.mpStartRec { background: rgba(31, 111, 74, 0.9); border-color: #7dffa8; color: #eafff2; }
.mpStartCard.mpStartRec:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 12px rgba(125,255,168,0.65); }
.mpStartTag { display: block; font-size: 11px; letter-spacing: 1px;
    padding: 3px 12px; border-radius: 12px; color: #cfeaff;
    background: rgba(8, 26, 44, 0.55); border: 1px solid rgba(111,199,255,0.5); }
.mpStartCard.mpStartRec .mpStartTag { color: #d9ffe5; background: rgba(8, 42, 26, 0.55); border-color: rgba(125,255,168,0.7); }
.mpStartCardTitle { font-size: 17px; letter-spacing: 2px; line-height: 1.25; }
.mpStartCardDesc { font-size: 12px; line-height: 1.6; color: #cfeaff; max-width: 280px; }
.mpStartCard.mpStartRec .mpStartCardDesc { color: #dfffe9; }
`;
    document.head.appendChild(style);
}

/** True when `name` is one of our injected multiplayer players (not a real NPC contact). */
function isMpPlayer(name: any): boolean {
    return !!(name && (sc as any).party && (sc as any).party.models[name] && (sc as any).party.models[name]._mpName);
}

/** Round 12: is this injected player currently reachable as a real network client?
 * Room players share our instance (online by definition); friends carry the live
 * presence flag. Offline friends can't network-join — they get invited as synced
 * follower "mod bots" instead (see the inviteMember intercept). */
function isOnlineMp(name: string): boolean {
    try {
        const m: any = _mainRef();
        if (m && m.partyMembers && m.partyMembers.indexOf(name) !== -1) return true;
        if (_stateRef.roomPlayers.indexOf(name) !== -1) return true;
        if (m && m.friendPresence && typeof m.friendPresence[name] === 'boolean') return m.friendPresence[name];
        const f = _stateRef.friends.filter((x) => x.name === name)[0];
        if (f) return !!f.online;
        const c = (sc as any).party && (sc as any).party.contacts && (sc as any).party.contacts[name];
        return !!(c && c.online);
    } catch (_) { return false; }
}

/** Round 12: combined party cap — self + everyone in currentParty (network members
 * + follower bots) counts against 8 slots. */
function partyIsFull(): boolean {
    try {
        const party: any = (sc as any).party;
        return !!party && !!party.currentParty && party.currentParty.length + 1 >= 8;
    } catch (_) { return false; }
}

/** "在线 N" with the count in the game's green text color (sc.FONT_COLORS.GREEN,
 * rendered via the \c[2]...\c[0] escape). */
function onlineChipText(count: number): string {
    return t('onlineChip') + '\\c[2]' + count + '\\c[0]';
}

export function installSocialMenuButton(getMain: () => Multiplayer | undefined): void {
    if (typeof sc === 'undefined' || !(sc as any).SocialMenu) {
        console.warn('[multiplayer] sc.SocialMenu not available; social menu injection not installed');
        return;
    }

    const state: IMpSocialState = { friends: [], roomPlayers: [], onlineCount: 0, faceFor: {}, requests: { incoming: [], outgoing: [] } };
    _mainRef = getMain;
    _stateRef = state;

    // Single-active-window model (round 23 review): at most one mp MODAL
    // (accept/decline, withdraw, friend-remove confirm) is open at a time. Tracked
    // so a new window deliberately replaces the previous and menu-exit/logout can
    // close them all. The add-friend box is tracked separately via state.addFriendBox
    // but participates in the same close-everything teardown (closeMpModals).
    let activeMpWindow: { box: JQuery, done: () => void } | null = null;

    // Wire the module-level bridges. Function declarations below hoist, so these
    // can be referenced here safely.
    _mpWindowTeardown = () => {
        closeMpModals();
    };
    _confirmRemoveRef = (name, onConfirm) => confirmRemoveFriend(name, onConfirm);
    _showMpWindowRef = showMpWindow;
    _showStartModeWindowRef = showStartModeWindow;

    // ---------------------------------------------------------------- helpers

    function main(): Multiplayer | undefined { return getMain(); }

    /** Lazily wire connection callbacks (the connection only exists post-login). */
    function wireConnection(): boolean {
        const m = main();
        const conn = m && m.connection;
        if (!conn || (conn as any)._mpSocialWired) return !!conn;
        (conn as any)._mpSocialWired = true;

        // Round 27 (toast wiring fix): isolate EVERY registration below — one
        // failing registration/handler install must never silently kill the rest
        // (the friend-request-received and party-busy toasts are the last things
        // wired here, exactly like registerLobbySocial in multiplayer.ts).
        const safeWire = <A extends any[]>(reg: (fn: (...args: A) => void) => void, fn: (...args: A) => void): void => {
            try { reg(fn); } catch (e) { console.error('[multiplayer] social wiring error:', e); }
        };

        safeWire(conn.onFriendList.bind(conn), (friends) => {
            state.friends = friends || [];
            rebuildContacts();
            refreshOpenMenu();
        });
        // Round 24: a new friendship was established (accept/auto-accept). The
        // server also pushes friendList; reconcile contacts + refresh an open menu
        // so the new friend appears without reopening the backpack.
        safeWire(conn.onFriendAdded.bind(conn), () => {
            rebuildContacts();
            refreshOpenMenu();
        });
        safeWire(conn.onRoomPlayers.bind(conn), (players, host) => {
            state.roomPlayers = players || [];
            state.roomHost = host || '';
            console.log('[multiplayer] roomPlayers: ' + JSON.stringify(state.roomPlayers) + ' host=' + (host || '-'));
            rebuildContacts();
            refreshOpenMenu();
        });
        safeWire(conn.onOnlineCount.bind(conn), (count) => {
            state.onlineCount = count || 0;
            refreshOpenMenu();
        });
        safeWire(conn.onFriendRequest.bind(conn), (from) => {
            // Round 23 wave 3: requests are handled in the 申请管理 tab; the incoming
            // push is now just a notification toast (replaces the old accept/decline
            // popup box).
            showMpToast({ title: t('friendRequestReceivedToast').replace('{name}', from) });
            // The server also pushes friendRequests — refetch to keep the tab fresh.
            try { conn.friendRequests(); } catch (e) { /* ignore */ }
        });
        // Round 23 wave 3: the 申请管理 (Requests) tab renders from this payload.
        // Round 27: also drives the tab's native star (updateRequestsStar) — a
        // payload whose incoming list gained a name the user hasn't seen re-raises
        // the star even after the tab was viewed; plain refetches (tab open, post
        // accept/decline sync) must NOT re-raise it.
        safeWire(conn.onFriendRequests.bind(conn), (req) => {
            const prevIncoming = new Set((state.requests && state.requests.incoming || []).map((r: any) => r.name));
            state.requests = (req && req.incoming) ? req : { incoming: [], outgoing: [] };
            state.requestsDirty = true;
            state.requestsLoading = false;
            if ((state.requests.incoming || []).some((r: any) => !prevIncoming.has(r.name))) {
                state.requestsViewed = false; // a brand-new request — raise the star again
            }
            // Round 24: the requests tab is a native member list — rebuild its rows
            // live (and refresh chips/party box) without reopening the menu.
            updateRequestsStar();
            refreshRequestsList();
            refreshOpenMenu();
        });
        // Round 23 wave 3: friend action results (add/accept/decline/withdraw).
        safeWire(conn.onFriendActionResult.bind(conn), (result) => {
            if (!result) return;
            if (result.action === 'request') {
                if (result.ok) {
                    // Search-then-add success: close the window + toast. Only toast
                    // when the add window was the source (the quick-menu path shows its
                    // own inline "已发送" label — no double notification).
                    const hadBox = !!state.addFriendBox;
                    closeAddFriendBox();
                    if (hadBox) showMpToast({ title: t('friendRequestSentToast') });
                    try { conn.friendRequests(); } catch (e) { /* ignore */ }
                } else {
                    showAddFriendError(result.error);
                }
            } else if (!result.ok) {
                // accept/decline/withdraw failures surface as an error toast (or into
                // the add window if it's the one that caused the failure).
                showAddFriendError(result.error);
            }
            // Round 24: any successful friend action (request/accept/decline/
            // withdraw) may have changed the friends list — reconcile contacts and
            // refresh an open menu live. The server also pushes fresh
            // friendList/friendRequests payloads; this is belt-and-braces so the
            // acting side updates even before those round-trips land.
            if (result.ok) {
                rebuildContacts();
                refreshOpenMenu();
            }
        });
        // Round 23 wave 3: party action results — the invite busy-check + the
        // invite-button re-enable guard.
        safeWire(conn.onPartyActionResult.bind(conn), (result) => {
            if (!result) return;
            if (result.action === 'invite') {
                if (result.ok === false && result.error === 'busy') {
                    showMpToast({ title: t('partyInviteBusy') });
                }
                setInviteGuard(false);
                refreshOpenMenu();
            }
        });
        // Round 23 wave 3: search results for the add-friend window (one open at a
        // time; results are routed into whatever window is currently open).
        safeWire(conn.onSearchPlayersResult.bind(conn), (data) => {
            if (state.addFriendApply && data && Array.isArray(data.players)) {
                try { state.addFriendApply(data.players); } catch (e) { /* ignore */ }
            }
        });
        return true;
    }

    // Wire the connection + pull the initial friend list AS SOON as we're logged
    // in — NOT lazily on first menu open. The connection only exists after login,
    // so poll briefly until it's available, wire the callbacks, then fetch. This
    // fixes "I have to re-add a friend before they show in the list": previously
    // the friendList response arrived before the handler was wired and was dropped.
    let wiring = false;
    simplify.registerUpdate(() => {
        const m = main();
        const conn = m && m.connection;
        // Only wire once the socket actually exists (post-open). Registering the
        // onX callbacks earlier touches socket.on and crashes on the title screen.
        if (!conn || !(conn as any).isReady || !(conn as any).isReady()) return;
        if ((conn as any)._mpSocialWired || wiring) return;
        wiring = true;
        // Round 27: even with every registration isolated inside wireConnection,
        // a future throw must not leave the `wiring` latch stuck true forever
        // (the pump would then never retry) — always clear it.
        let wired = false;
        try { wired = wireConnection(); } catch (e) { console.error('[multiplayer] social wiring failed:', e); }
        if (wired) {
            try { conn.friendList(); } catch (e) { /* ignore */ }
            try { conn.onlineCount(); } catch (e) { /* ignore */ }
            try { conn.friendRequests(); } catch (e) { /* ignore */ }
        }
        wiring = false;
    });

    // -------------------------------------------------- round 23 wave 3: windows

    /** Close every open mp modal + the add-friend box. Used for the deliberate
     * replacement when a new window opens and for menu-exit/logout teardown. */
    function closeMpModals(): void {
        if (activeMpWindow) {
            try { activeMpWindow.done(); } catch (_) { /* ignore */ }
            activeMpWindow = null;
        }
        if (state.addFriendBox) closeAddFriendBox();
    }

    /** A login-panel-style centered modal with a header + content + action buttons.
     * Clicking a button runs its cb and closes the window; clicking outside or the
     * (×) closes without acting. Reused by the accept/decline window, the withdraw
     * window and the friend-remove confirm. Single-active-window: a new mp window
     * EXPLICITLY replaces any open one (closeMpModals first), so a confirm window
     * is never closed by an unrelated focus event. */
    function openMpWindow(opts: { title: string, content: JQuery, buttons: Array<{ label: string, style?: string, cb: () => void }>, windowClass?: string }): (() => void) | null {
        closeMpModals(); // deliberate replacement: only a new window closes the old one
        ensureMpWindowStyle();
        const box = $('<div class="mpWin"></div>');
        if (opts.windowClass) box.addClass(opts.windowClass);
        const head = $('<div class="mpWinHead"></div>');
        head.append('<span class="mpWinTitle">' + opts.title + '</span>');
        const close = $('<button type="button" class="mpWinClose" title="Close">&times;</button>');
        head.append(close);
        box.append(head);
        box.append(opts.content);
        const btns = $('<div class="mpWinBtns"></div>');
        for (const b of opts.buttons) {
            const btn = $('<button class="mpBtn' + (b.style ? ' ' + b.style : '') + '">' + b.label + '</button>');
            btn.on('click', () => { try { b.cb(); } catch (_) { /* ignore */ } done(); });
            btns.append(btn);
        }
        box.append(btns);
        $(document.body).append(box);
        try { ig.system.setFocusLost(); } catch (_) { /* ignore */ }

        let closed = false;
        const done = (): void => {
            if (closed) return;
            closed = true;
            if (activeMpWindow && activeMpWindow.box[0] === box[0]) activeMpWindow = null;
            try { ig.system.removeFocusListener(onFocus); } catch (_) { /* ignore */ }
            document.removeEventListener('mousedown', onMousedown, true);
            box.remove();
            try { ig.system.regainFocus(); } catch (_) { /* ignore */ }
            try { (ig.interact as any).setBlockDelay(0.2); } catch (_) { /* ignore */ }
        };
        close.on('click', done);
        // Focus moves to the clicked button — only treat focus loss OUTSIDE the
        // window as a dismiss, and ONLY while this window is the active one (a
        // focus event caused by a different window must never close us).
        const onFocus = (): void => {
            if (closed) return;
            if (!activeMpWindow || activeMpWindow.box[0] !== box[0]) return;
            if (box[0] && box[0].contains(document.activeElement)) return;
            done();
        };
        const onMousedown = (e: MouseEvent): void => {
            if (closed) return;
            if (!activeMpWindow || activeMpWindow.box[0] !== box[0]) return;
            if (box[0] && !box[0].contains(e.target as Node)) done();
        };
        ig.system.addFocusListener(onFocus);
        document.addEventListener('mousedown', onMousedown, true);
        activeMpWindow = { box, done };
        return done;
    }

    /**
     * ROUND 86: public single-content-string wrapper around openMpWindow, so the
     * multiplayer core can show system dialogs (connection lost / server updated)
     * in the SAME style as the social confirm windows. Returns the close handle so
     * a reconnected socket can dismiss the dialog again.
     */
    function showMpWindow(opts: { title: string, content: string, buttons: Array<{ label: string, style?: string, cb: () => void }> }): (() => void) | null {
        try {
            const content = $('<div class="mpWinMsg"></div>').text(opts.content);
            return openMpWindow({ title: opts.title, content, buttons: opts.buttons });
        } catch (_) {
            return null;
        }
    }

    /** ROUND 119: first-login start chooser rendered as two large square CARDS.
     * openMpWindow supplies the modal chrome, focus handling and outside-click
     * dismissal; the cards are part of the CONTENT and report their pick through
     * `onPick`, then close via the handle returned by openMpWindow. */
    function showStartModeWindow(opts: {
        title: string;
        body: string;
        options: Array<{ mode: 'fresh' | 'bridge'; title: string; description: string; tag: string; recommended: boolean }>;
        onPick: (mode: 'fresh' | 'bridge') => void;
    }): (() => void) | null {
        try {
            const content = $('<div class="mpWinMsg mpWinStart"></div>');
            content.append($('<div class="mpStartBody"></div>').text(opts.body));
            const grid = $('<div class="mpStartGrid"></div>');
            for (const o of opts.options) {
                const card = $('<button type="button" class="mpStartCard' + (o.recommended ? ' mpStartRec' : '') + '"></button>');
                card.attr('data-mode', o.mode);
                card.append($('<span class="mpStartTag"></span>').text(o.tag));
                card.append($('<span class="mpStartCardTitle"></span>').text(o.title));
                card.append($('<span class="mpStartCardDesc"></span>').text(o.description));
                grid.append(card);
            }
            content.append(grid);
            const handle = openMpWindow({ title: opts.title, content, buttons: [], windowClass: 'mpWinStart' });
            grid.find('.mpStartCard').on('click', function(this: HTMLElement) {
                try { opts.onPick($(this).attr('data-mode') as 'fresh' | 'bridge'); } catch (_) { /* ignore */ }
                try { if (handle) handle(); } catch (_) { /* ignore */ }
            });
            return handle;
        } catch (_) {
            return null;
        }
    }

    /** Best-known level for a username (profile stream wins, injected model falls back). */
    function knownLevel(name: string): number | undefined {
        try {
            const m = main();
            const prof = m && m.getPlayerProfile ? m.getPlayerProfile(name) : undefined;
            if (prof && typeof prof.level === 'number') return prof.level;
            const mdl: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[name];
            if (mdl && typeof mdl.level === 'number') return mdl.level;
        } catch (_) { /* ignore */ }
        return undefined;
    }

    /** Accept/decline window for an INCOMING request (clicked entry in 申请管理). */
    function openFriendRequestBox(name: string): void {
        const m = main();
        const conn = m && m.connection;
        if (!conn) return;
        const content = $('<div class="mpWinMsg"></div>');
        content.append('<div class="mpWinName">' + $('<i>').text(name).html() + '</div>');
        const lvl = knownLevel(name);
        if (typeof lvl === 'number') content.append('<div class="mpWinLvl">' + t('levelLabel') + lvl + '</div>');
        openMpWindow({
            title: t('reqAcceptTitle'),
            content,
            buttons: [
                { label: t('accept'), style: 'mpPrimary', cb: () => conn.friendAccept(name) },
                { label: t('decline'), style: 'mpBtnDanger', cb: () => conn.friendDecline(name) },
            ],
        });
    }

    /** Withdraw window for an OUTGOING request (clicked entry in 申请管理). */
    function openWithdrawWindow(name: string): void {
        const m = main();
        const conn = m && m.connection;
        if (!conn) return;
        const content = $('<div class="mpWinMsg"></div>');
        content.append('<div class="mpWinName">' + $('<i>').text(name).html() + '</div>');
        openMpWindow({
            title: t('reqWithdrawTitle'),
            content,
            buttons: [
                { label: t('reqWithdraw'), style: 'mpBtnDanger', cb: () => conn.friendRequestWithdraw(name) },
            ],
        });
    }

    /** Login-panel-style confirm window; only acts on 确认. */
    function confirmRemoveFriend(name: string, onConfirm: () => void): void {
        const content = $('<div class="mpWinMsg"></div>');
        content.append('<div class="mpWinText">' + t('confirmRemoveFriendMsg').replace('{name}', name) + '</div>');
        openMpWindow({
            title: t('confirmRemoveFriendTitle'),
            content,
            buttons: [
                { label: t('confirmCancel'), cb: () => { /* no-op: cancel */ } },
                { label: t('confirmOk'), style: 'mpBtnDanger', cb: onConfirm },
            ],
        });
    }

    /** Close the search-then-add friend window (any path). */
    function closeAddFriendBox(): void {
        if (state.addFriendFocusHandler) {
            try { ig.system.removeFocusListener(state.addFriendFocusHandler); } catch (_) { /* ignore */ }
            state.addFriendFocusHandler = null;
        }
        if (state.addFriendMousedown) {
            document.removeEventListener('mousedown', state.addFriendMousedown, true);
            state.addFriendMousedown = null;
        }
        state.addFriendApply = null;
        state.searchQuery = undefined;
        if (state.addFriendBox) {
            try { state.addFriendBox.remove(); } catch (_) { /* ignore */ }
            state.addFriendBox = null;
        }
        try { ig.system.regainFocus(); } catch (_) { /* ignore */ }
        try { (ig.interact as any).setBlockDelay(0.2); } catch (_) { /* ignore */ }
    }

    /** Map a server-side friend-action error string to a localized message. */
    function mapRequestError(err: string): string {
        if (!err) return t('friendActionFailed');
        if (err === 'Request already sent') return t('requestPending');
        if (err === 'Already friends') return t('alreadyFriends');
        if (err === 'Cannot add yourself') return t('friendCannotSelf');
        if (err === 'No such player') return t('searchNoResults');
        return t('friendActionFailed');
    }

    /** Surface a friend-action failure: in the add window if it's open, else toast. */
    function showAddFriendError(err: string): void {
        const msg = mapRequestError(err);
        if (state.addFriendBox) {
            state.addFriendBox.find('.mpWinHint').text(msg);
            return;
        }
        showMpToast({ title: t('friendActionFailed'), subtitle: msg });
    }

    /** Render search results into the open add-friend window. */
    function applySearchResults(box: JQuery, players: Array<{ name: string, online: boolean, level?: number }>): void {
        try {
            const results = box.find('.mpSearchResults');
            const hint = box.find('.mpWinHint');
            results.empty();
            if (!players || !players.length) {
                hint.text(t('searchNoResults'));
                return;
            }
            hint.text('');
            const q = (state.searchQuery || '').toLowerCase();
            for (const p of players) {
                const row = $('<div class="mpRow"></div>');
                // Round 27: level + name are SEPARATE block <div>s — flex items
                // that can never inline-glue, so "等级 N" and the name are visually
                // distinct in both locales even in engines without flex `gap`
                // support. The level div carries its own min-width + right margin
                // (see .mpRowLvl); the name div flexes to fill the rest before the
                // spacer/action area (see .mpRowName).
                if (typeof p.level === 'number') row.append('<div class="mpRowLvl">' + t('levelLabel') + p.level + '</div>');
                row.append('<div class="mpRowName">' + $('<i>').text(p.name).html() + '</div>');
                row.append('<span class="mpRowSpacer"></span>');
                // Round 27 (item 1): FUZZY search returns many rows; give EVERY row the
                // add action (not just the exact-typed name), so any match can be
                // friended — including a bot found by its English/Chinese name.
                appendFriendRowAction(row, p);
                results.append(row);
            }
        } catch (_) { /* never break the window from a result */ }
    }

    /** Search-then-add friend window (login-panel style, round 23 wave 3). */
    function openAddFriendBox(main: Multiplayer | undefined): void {
        if (!main || !main.connection) {
            console.warn('[multiplayer] not connected; cannot add friend');
            return;
        }
        // Single-active-window model: opening the add box replaces any open mp
        // modal (accept/decline, withdraw, confirm) and a previous add box.
        closeMpModals();
        ensureMpWindowStyle();
        const conn = main.connection;
        const box = $('<div class="mpWin"></div>');
        const head = $('<div class="mpWinHead"></div>');
        head.append('<span class="mpWinTitle">' + t('searchTitle') + '</span>');
        const close = $('<button type="button" class="mpWinClose" title="Close">&times;</button>');
        head.append(close);
        box.append(head);

        const input = $('<input type="text" class="mpWinInput" placeholder="' + t('searchPh') + '" />');
        // Round 23 review: typing in the search box must never trigger game key
        // bindings — swallow the keystrokes at the DOM level while focused.
        input.on('keydown keypress keyup', (e: any) => { try { e.stopPropagation(); } catch (_) { /* ignore */ } });
        const searchBtn = $('<button type="submit" class="mpBtn mpPrimary">' + t('searchBtn') + '</button>');
        const hint = $('<div class="mpWinHint"></div>');
        const results = $('<div class="mpSearchResults"></div>');
        const form = $('<form class="mpSearchForm"></form>');
        form.append(input).append(searchBtn);
        box.append(form).append(hint).append(results);
        $(document.body).append(box);
        try { ig.system.setFocusLost(); } catch (_) { /* ignore */ }

        // Round 28 (item 6): IME composition. Pressing Enter to CONFIRM an IME candidate
        // (Chinese/Japanese/Korean input) also fires the form's submit — searching the
        // raw pinyin/romaji the user has typed so far ("emily" for "艾米莉") instead of
        // the committed text. Track the composition lifecycle and swallow any submit
        // that happens during (or on the same event-loop turn as) a composition, so the
        // search only fires on a committed string. A committed CJK query then matches a
        // bot's Chinese alias (bots.js BOT_ALIASES) on the server.
        let imeComposing = false;
        let imeGuardUntil = 0;
        input.on('compositionstart', () => { imeComposing = true; });
        input.on('compositionend', () => { imeComposing = false; imeGuardUntil = Date.now() + 150; });
        const doSearch = (): boolean => {
            // Block while composing OR on the trailing turn right after a commit (the
            // Enter that confirmed the candidate arrives just after compositionend).
            const e: any = (typeof window !== 'undefined' && window.event) ? window.event : undefined;
            const keyConfirming = !!(e && (e.isComposing || e.keyCode === 229));
            if (imeComposing || keyConfirming || Date.now() < imeGuardUntil) return false;
            const q = String(input.val() || '').trim();
            if (!q) {
                hint.text(t('searchRequired'));
                input.focus();
                return false;
            }
            state.searchQuery = q;
            hint.text('');
            results.empty();
            results.append('<div class="mpEmpty">' + t('searching') + '</div>');
            try { conn.searchPlayers(q); } catch (_) { hint.text(t('searchFailed')); }
            return false;
        };
        form.submit(doSearch);
        searchBtn.on('click', doSearch);
        // ROUND 32 (item 6): IME Enter-to-commit arrives as a keydown with isComposing
        // true / keyCode 229. Some engines swallow that keydown so the form never
        // submits after a CJK candidate is confirmed — the user types 艾米莉, hits
        // Enter to commit, then presses Enter again and nothing fires. Listen for a
        // NON-composing Enter directly on the input and run the committed search.
        input.on('keydown', (e: any) => {
            try {
                if (!e) return;
                const composing = !!(e.isComposing || e.keyCode === 229 || (e.originalEvent && e.originalEvent.isComposing));
                if ((e.key === 'Enter' || e.keyCode === 13) && !composing && !imeComposing) {
                    e.preventDefault();
                    doSearch();
                }
            } catch (_) { /* never break the window */ }
        });
        close.on('click', () => closeAddFriendBox());

        // Focus management: the input keeps focus; any click/focus INSIDE the window
        // is ignored; focus regained outside (or an outside click) dismisses it.
        const onFocus = (): void => {
            if (!state.addFriendBox || state.addFriendBox[0] !== box[0]) return;
            if (document.activeElement === input[0] || (box[0] && box[0].contains(document.activeElement))) {
                try { ig.system.setFocusLost(); } catch (_) { /* ignore */ }
                return;
            }
            closeAddFriendBox();
        };
        const onMousedown = (e: MouseEvent): void => {
            if (state.addFriendBox && state.addFriendBox[0] === box[0] && box[0] && !box[0].contains(e.target as Node)) {
                closeAddFriendBox();
            }
        };
        try { ig.system.addFocusListener(onFocus); } catch (_) { /* ignore */ }
        document.addEventListener('mousedown', onMousedown, true);
        state.addFriendFocusHandler = onFocus;
        state.addFriendMousedown = onMousedown;
        state.addFriendBox = box;

        // The onSearchPlayersResult handler (wired once in wireConnection) routes
        // results into whatever window is currently open.
        state.addFriendApply = (players: Array<{ name: string, online: boolean, level?: number }>) => {
            if (state.addFriendBox === box) applySearchResults(box, players);
        };

        input.focus();
    }

    /**
     * Keep all injected state scoped to the current account. If the logged-in
     * username changed since we last injected (a different account reusing this
     * client), drop the previous account's injected models/contacts so its
     * friends don't leak into the new account's menu. Fixes the "I logged in as
     * test1 but see test2's friends" bug.
     */
    function ensureAccountScope(): void {
        const m = main();
        const me = m && m.name;
        if (!me) return;
        if (state.account === me) return;

        const party: any = (sc as any).party;
        if (party) {
            for (const name in party.models) {
                const model = party.models[name];
                if (model && model._mpName) {
                    if (party.isPartyMember && party.isPartyMember(name)) {
                        try { party.removePartyMember(name, null, true); } catch (e) { /* ignore */ }
                    }
                    delete party.models[name];
                }
            }
            for (const name in party.contacts) {
                const c = party.contacts[name];
                if (!c || !c._mp) continue;
                if (isEngineOwnedContact(name)) {
                    // Round 28: a NATIVE contact we marked as an mp friend (a bot
                    // account shares the companion's name). Restore the pre-friend
                    // status instead of deleting — a missing native contact breaks
                    // the engine's unguarded isFriend and would permanently hide
                    // the companion from the native social lists.
                    if (typeof c._mpPrevStatus === 'number') c.status = c._mpPrevStatus;
                    delete c._mpPrevStatus;
                    delete c._mp;
                } else {
                    delete party.contacts[name];
                }
            }
            // Belt-and-braces: sc.party.onPostUpdate iterates currentParty calling
            // models[name].update() with NO null check. If a removed _mp model is
            // still referenced in currentParty, that's a crash. Purge any currentParty
            // entry whose model no longer exists.
            if (party.currentParty && party.currentParty.length) {
                party.currentParty = party.currentParty.filter((n: string) => !!party.models[n]);
            }
        }
        state.account = me;
        state.faceFor = {};
        state.friends = [];
        state.roomPlayers = [];
        state.roomHost = '';
        // Round 23 wave 3: the previous account's requests don't belong to the new
        // one (the server pushes a fresh friendRequests right after login).
        state.requests = { incoming: [], outgoing: [] };
        state.requestsDirty = true;
        // We just wiped every _mp model/contact — including the current party
        // roster's models (applyPartyRoster injects them without an account-scope
        // check). Rebuild the roster immediately or the party box goes blank until
        // the next server partyUpdate.
        try {
            if (m.partyMembers && m.partyMembers.length && typeof (m as any).applyPartyRoster === 'function') {
                (m as any).applyPartyRoster(m.partyMembers);
            }
        } catch (e) { /* ignore */ }
    }

    /** Assign a stable, distinct face-character to each known username. */
    function assignFaces(): void {
        const opts = partyFaceOptions();
        const known: string[] = [];
        for (const f of state.friends) known.push(f.name);
        for (const p of state.roomPlayers) if (known.indexOf(p) === -1) known.push(p);
        // Round 24: request senders get faces too (their rows use buildMpModel).
        const reqs = (state.requests && state.requests.incoming || []).concat(state.requests && state.requests.outgoing || []);
        for (const r of reqs) if (known.indexOf(r.name) === -1) known.push(r.name);
        for (const name of known) {
            if (state.faceFor[name]) continue;
            const used: { [c: string]: boolean } = {};
            for (const k in state.faceFor) used[state.faceFor[k]] = true;
            let pick = opts[0];
            for (const c of opts) { if (!used[c]) { pick = c; break; } }
            state.faceFor[name] = pick;
        }
    }

    /** Build a fresh injected PartyMemberModel keyed under `storageKey`, displayed as
     * `displayName` (e.g. a friend-request entry `reqIn:Alice` shown as "Alice").
     * Shared by ensureModel (friends/room) and ensureRequestEntry (requests tab). */
    function buildMpModel(storageKey: string, displayName: string): any {
        const party: any = (sc as any).party;
        const face = state.faceFor[displayName] || partyFaceOptions()[0];
        try {
            // Reuse an existing character model so we get a fully-loaded config
            // (face, expression, proxies) without a second async load.
            let src = party.models[face];
            if (!src) {
                // Round 24: the assigned face character may not be loaded yet (e.g. a
                // friend-request sender the local game has never met). Fall back to any
                // real (non-injected) character model so the row still renders instead
                // of handing SocialEntryButton an undefined model (which would crash).
                for (const k in party.models) {
                    const m = party.models[k];
                    if (m && !m._mpName) { src = m; break; }
                }
                if (!src) src = party.models.Lea || null;
            }
            if (!src) return null;
            const model: any = Object.create(Object.getPrototypeOf(src));
            for (const k in src) model[k] = src[k];
            // Shallow copy shares the source character's mutable sub-objects; the
            // engine resets/loads EVERY model, so give ours its own copies to avoid
            // clobbering the real character's equip/params (see multiplayer.ensureMpModel).
            try { model.equip = ig.copy(src.equip); } catch (e) { model.equip = { head: -1, leftArm: -1, rightArm: -1, torso: -1, feet: -1 }; }
            try { model.params = new (sc as any).CombatParams(model); } catch (e) { /* keep shared params as fallback */ }
            try { model.healing = ig.copy(src.healing); } catch (e) { /* ignore */ }
            try { model.core = ig.copy(src.core); } catch (e) { /* ignore */ }
            try { model.baseParams = ig.copy(src.baseParams); } catch (e) { /* ignore */ }
            model.observers = []; // own observer list (don't share the source's)
            // Round 16: force the protagonist (Lea) avatar on every injected model.
            // Do NOT mutate model.config.headIdx — config is a SHARED reference with the
            // source character. Override getHeadIdx as an own property instead.
            const lea: any = (sc as any).party && (sc as any).party.models ? (sc as any).party.models.Lea : null;
            model.getHeadIdx = function (this: any) {
                try { if (lea && lea.config && typeof lea.config.headIdx === 'number') return lea.config.headIdx; } catch (_) {}
                return 0; // frame 0 of media/gui/severed-heads.png
            };
            if (lea && lea.defaultExpression) { model.defaultExpression = lea.defaultExpression; }
            model._mpName = displayName;
            model._mpFace = face;
            // Show the real username everywhere (entry name, sort, info box) instead
            // of the face-character's name (e.g. "Lea"). Instance override, so the
            // shared prototype/character models are untouched.
            model.getCharacterName = () => displayName;
            model.getCharacterRealName = () => displayName;
            party.models[storageKey] = model;
            // Seed with the real synced profile (stats + gear) so the native info
            // box reads correct values even before the explicit overwrite runs.
            const m = main();
            if (m && typeof (m as any).applyProfileToModel === 'function') (m as any).applyProfileToModel(displayName);
            // Round 24: the level for the native row + info box. applyProfileToModel
            // keys party.models by USERNAME, so a request model stored under
            // reqIn:/reqOut: never gets it — read the profile directly instead.
            try {
                const prof = m && typeof (m as any).getPlayerProfile === 'function'
                    ? (m as any).getPlayerProfile(displayName) : undefined;
                if (prof && typeof prof.level === 'number') model.level = prof.level;
            } catch (_) { /* ignore */ }
            return model;
        } catch (e) {
            return null;
        }
    }

    /** Ensure a PartyMemberModel exists for `username` (built on a real character's config). */
    function ensureModel(username: string): any {
        const party: any = (sc as any).party;
        if (party.models[username]) return party.models[username];
        return buildMpModel(username, username);
    }

    /** Ensure a model + sentinel-status contact for one friend-request entry
     * (`kind` = 'in' incoming / 'out' outgoing). Returns the synthetic member-list
     * key (`reqIn:<name>` / `reqOut:<name>`). The contact exists so
     * SocialEntryButton.init (which reads contacts[key].online) renders, but its
     * sentinel status keeps it out of the native friends/contacts lists. */
    function ensureRequestEntry(kind: 'in' | 'out', name: string): string {
        const party: any = (sc as any).party;
        const key = (kind === 'in' ? 'reqIn:' : 'reqOut:') + name;
        if (!party.models[key]) {
            const mdl = buildMpModel(key, name);
            if (mdl) mdl._mpReqKind = kind;
        } else if (party.models[key]._mpReqKind !== kind) {
            party.models[key]._mpReqKind = kind;
        }
        const c = party.contacts[key] || (party.contacts[key] = {});
        c._mp = true;
        c._mpReq = true;
        c._mpReqKind = kind;
        c.status = PARTY_MEMBER_TYPE_MP;
        c.online = true;
        c.locked = false;
        return key;
    }

    /** Ensure a model + sentinel-status contact for a room player (incl. self) so
     * the room-tab rows render, while never leaking into the native friends/contacts
     * tabs. A friend who happens to be in the room keeps FRIEND status.
     * ROUND 32 (item 6): never sentinel-stamp a NATIVE companion contact id (a bot
     * friend in the room whose name equals a companion). Overwriting its status to
     * PARTY_MEMBER_TYPE_MP corrupts the engine-owned contact (and isBotUnlocked's
     * story gate reads that same status). The injected model still renders the row;
     * the native contact is left for the engine to own. */
    function ensureRoomEntry(p: string): void {
        const party: any = (sc as any).party;
        ensureModel(p);
        if (isNativeContactKey(p)) return;
        const existing = party.contacts[p];
        if (existing && existing.status === PARTY_MEMBER_TYPE.FRIEND) return;
        const c = existing || (party.contacts[p] = {});
        c._mp = true;
        c.status = PARTY_MEMBER_TYPE_MP;
        c.online = true;
        c.locked = false;
    }

    /** Round 25: is `name` a contact the ENGINE owns (as opposed to a mod-managed
     * mp friend)? Official follower bots (sc.PARTY_OPTIONS) keep their FRIEND
     * contact forever — the engine's addPartyMember set it, and even
     * removePartyMember only splices currentParty, never downgrades the contact —
     * so they must NEVER be reconciled away, no matter what currentParty looks
     * like at that instant. The round-24 exemption (party.isPartyMember ->
     * currentParty.indexOf) failed exactly in the windows where the party is not
     * restored / not yet applied (a roomPlayers/friendList push landing before
     * the party update or the save restore): currentParty is empty, isPartyMember
     * returns false, and the bot's FRIEND contact gets deleted -> the friend tab
     * loses the followers (and with no mp friends left, renders EMPTY). Cover
     * currentParty membership DIRECTLY as well as the engine list of native
     * characters. */
    function isEngineOwnedContact(name: string): boolean {
        if (!name) return false;
        try {
            const party: any = (sc as any).party;
            const opts: string[] = (sc as any).PARTY_OPTIONS || [];
            if (opts.indexOf(name) !== -1) return true;
            if (party && party.currentParty && party.currentParty.indexOf(name) !== -1) return true;
            if (party && typeof party.isPartyMember === 'function' && party.isPartyMember(name)) return true;
        } catch (_) { /* the guard itself must never throw */ }
        return false;
    }

    /** Sync sc.party.contacts/models EXACTLY to state.friends (round 24): friends
     * get FRIEND status + the live server online flag; room players + the local
     * player get the sentinel status so they NEVER appear in the native 联系人/好友
     * lists (only the room tab renders them, via getMemberList); and stale entries
     * (a friend no longer in state.friends, or a room player who left) are dropped
     * or downgraded so the menu always matches the server without a reopen. */
    function rebuildContacts(): void {
        const party: any = (sc as any).party;
        if (!party || !party.models) return;
        // Don't inject before the game has built the real party models (title screen /
        // pre-start): there'd be no source character to clone, and injecting now would
        // create half-built models that a later game-start onReset has to clean up.
        // state.friends is already stored, so the list renders correctly once the
        // game is up and refresh()/rebuildContacts() runs again.
        if (!party.models.Lea) return;
        ensureAccountScope();
        assignFaces();

        const me = main() && main()!.name;
        const friendSet: { [name: string]: boolean } = {};
        for (const f of state.friends) {
            if (f.name === me) continue; // the local player is never a FRIEND
            friendSet[f.name] = true;
        }

        // Friends exactly as the server knows them: FRIEND status + live online flag.
        for (const f of state.friends) {
            if (f.name === me) continue;
            ensureModel(f.name);
            const c = party.contacts[f.name] || (party.contacts[f.name] = {});
            // Round 28: a bot friend's name can be a NATIVE contact key (e.g.
            // "Emilie"). The first time we shadow one, remember the engine's
            // status so the account-scope wipe can RESTORE it instead of deleting
            // the entry (the engine's isFriend reads contacts[name].status
            // UNGUARDED and would crash on a missing native contact).
            //
            // ROUND 32 (item 6): a companion whose story hasn't reached it sits at
            // status UNKNOWN — friending that bot must NOT rewrite the native contact
            // to FRIEND (that spoofs an unlock the story never granted, and the
            // engine's unguarded isFriend then treats the unmet companion as a friend).
            // Only stamp a native contact the engine has ACTUALLY unlocked
            // (status > UNKNOWN). An UNKNOWN (or absent) native contact is left
            // untouched; the friend renders through our injected model + the room tab,
            // and appendFriendRowAction's isBotUnlocked gate keeps the add button off.
            if (isNativeContactKey(f.name)) {
                const nativeUnlocked = typeof c.status === 'number' && c.status > PARTY_MEMBER_TYPE.UNKNOWN;
                if (nativeUnlocked) {
                    if (!c._mp) c._mpPrevStatus = c.status;
                    c._mp = true;
                    c.status = PARTY_MEMBER_TYPE.FRIEND;
                    c.online = !!f.online;
                    c.locked = false;
                }
                continue; // a native-key friend NEVER gets the generic stamp below
            }
            if (!c._mp && isEngineOwnedContact(f.name)) c._mpPrevStatus = c.status;
            c._mp = true;
            c.status = PARTY_MEMBER_TYPE.FRIEND;
            c.online = !!f.online; // server friendList carries the live online flag
            c.locked = false;
        }
        // Room players + self get sentinel-status entries (never native tabs). A
        // friend who happens to be in the room keeps FRIEND status (ensureRoomEntry).
        for (const p of state.roomPlayers) ensureRoomEntry(p);
        if (me) ensureRoomEntry(me);

        // Reconcile to EXACTLY the friend set: a FRIEND-status contact who is no
        // longer a friend is removed, or downgraded to a sentinel room entry if they
        // are still in the room. Request entries (_mpReq), sentinel room entries and
        // NATIVE party members (sc.party keeps follower contacts at FRIEND status —
        // addPartyMember sets it for non-temporary members; removePartyMember and
        // isFriend read contacts[name] back UNGUARDED) are owned elsewhere and left
        // untouched.
        for (const name in party.contacts) {
            const c = party.contacts[name];
            if (!c || c._mpReq) continue;
            if (c.status !== PARTY_MEMBER_TYPE.FRIEND) continue;
            if (friendSet[name]) continue;
            // Round 24 fix: never reconcile away a native party member's FRIEND
            // contact (an invited follower bot is both). Deleting it makes the
            // engine's removePartyMember/isFriend read contacts[name].locked/.status
            // off undefined and crash on kick/leave/map-change.
            // Round 25: the round-24 exemption (party.isPartyMember) still missed
            // the windows where currentParty is empty at rebuild time (party not
            // restored / roster not yet applied) — a FRIEND contact for an official
            // follower bot was deleted then, emptying the friend tab. isEngineOwnedContact
            // covers PARTY_OPTIONS names outright, plus direct currentParty
            // membership and the engine's isPartyMember.
            // ROUND 94: an INJECTED mp player still in our network party is also in
            // sc.party.currentParty (applyPartyRoster adds them for the HUD), so the
            // generic engine-ownership exemption above kept a JUST-REMOVED friend
            // stamped FRIEND forever — the 删除好友 confirm looked like a no-op while
            // teaming. Keep their contact alive for the party box but downgrade it
            // out of the friends tab (CONTACT = teammate, not friend).
            const model = party.models[name];
            const isMpInjected = !!(c && c._mp && model && model._mpName);
            if (isEngineOwnedContact(name) || (isMpInjected && c._mpInParty)) {
                if (isMpInjected && (c._mpInParty || party.currentParty.indexOf(name) !== -1)) {
                    c.status = PARTY_MEMBER_TYPE.CONTACT;
                    c.online = true;
                }
                continue;
            }
            if (state.roomPlayers.indexOf(name) !== -1) {
                // Still present in the room: downgrade, don't delete.
                c.status = PARTY_MEMBER_TYPE_MP;
                c.online = true;
            } else {
                delete party.contacts[name];
            }
        }

        // Reconcile the requests-tab entries too: drop any _mpReq contact + model
        // whose synthetic key is no longer in the current friendRequests payload, so
        // an accepted/declined/withdrawn request can't linger invisibly (round 24).
        const reqKeys: { [key: string]: boolean } = {};
        for (const r of (state.requests && state.requests.incoming) || []) reqKeys['reqIn:' + r.name] = true;
        for (const r of (state.requests && state.requests.outgoing) || []) reqKeys['reqOut:' + r.name] = true;
        for (const name in party.contacts) {
            const c = party.contacts[name];
            if (c && c._mpReq && !reqKeys[name]) {
                delete party.contacts[name];
                delete party.models[name];
            }
        }

        // Model + stale-entry cleanup. Party members keep their models (the party
        // box renders from the roster, and applyPartyRoster re-owns the entry). A
        // sentinel room entry whose player left the room (and isn't a friend) goes
        // away entirely; request models (keyed reqIn:/reqOut:) are protected via the
        // _mpReq contact flag checked above.
        for (const name in party.models) {
            const model = party.models[name];
            if (!model || !model._mpName) continue;
            // Round 25: same engine-ownership exemption as the reconcile loop —
            // never strip a model (or its contact below) for a name the engine
            // owns (official bots, currentParty members). A PARTY_OPTIONS name
            // never carries _mpName, so this is belt-and-braces; the currentParty
            // coverage is what matters (a party member's model outlives roster
            // churn and must never be dropped mid-rebuild).
            if (isEngineOwnedContact(name)) continue;
            const c = party.contacts[name];
            if (!c) { delete party.models[name]; continue; }
            if (c._mpReq || c.status === PARTY_MEMBER_TYPE.FRIEND) continue;
            if (c.status === PARTY_MEMBER_TYPE_MP && state.roomPlayers.indexOf(name) === -1) {
                delete party.contacts[name];
                delete party.models[name];
            }
        }
    }

    /** Re-pull everything from the server and rebuild. */
    function refresh(): void {
        if (!wireConnection()) return;
        ensureAccountScope();
        const conn = main()!.connection;
        conn.friendList();
        conn.roomPlayers();
        conn.onlineCount();
    }

    /** If the social menu is open, refresh its list + top-bar counter live. */
    function refreshOpenMenu(): void {
        const menu: any = (sc as any).menu;
        if (!menu || menu.currentMenu !== (sc as any).MENU_SUBMENU.SOCIAL) return;
        // currentMenu is an ENUM; resolve the real SocialMenu instance via the
        // main-menu guiReference (same fix as multiplayer.refreshOpenSocialMenu).
        const guiRef = menu.guiReference;
        const social = guiRef && typeof guiRef._getMenuFromID === 'function'
            ? guiRef._getMenuFromID(menu.currentMenu) : null;
        if (!social) return;
        try {
            // Prefer the cached count on the main instance (always current); fall
            // back to the last value this module saw.
            const m = main();
            const count = (m && typeof m.onlineCount === 'number') ? m.onlineCount : state.onlineCount;
            if (social._mpOnlineChip) social._mpOnlineChip.setText(onlineChipText(count));
            // Rebuild the visible list AND the party box. IMPORTANT: the native
            // updatePartyMembers only refreshes the online dots on EXISTING buttons
            // — after rebuildContacts deletes a contact (friend removed / reconciled
            // away) the dead-key row stays alive and the next hover crashes the
            // engine's unguarded sc.party.isFriend. sort() re-runs
            // onCreateListEntries, which clears + rebuilds the rows, dropping any
            // dead-key row (same pattern as refreshRequestsList).
            const l = social.list;
            if (l && typeof l.sort === 'function') {
                const sortVal = (l.tabContent && l.tabContent[l.currentTabIndex]
                    && l.tabContent[l.currentTabIndex].sort) || 0;
                l.sort(sortVal);
            } else if (l && typeof l.updatePartyMembers === 'function') {
                l.updatePartyMembers();
            }
            if (social.party && typeof social.party.updatePartyMembers === 'function') {
                social.party.updatePartyMembers();
            }
        } catch (e) { /* menu mid-transition; ignore */ }
    }

    /** Re-fetch the friend-request payload from the server (guarded so concurrent
     * fetches don't double-fire; the onFriendRequests handler rebuilds the list).
     * The server always answers friendRequests with a fresh payload. */
    function fetchRequests(): void {
        const conn = main() && main()!.connection;
        if (!conn) return;
        if (state.requestsLoading) return;
        state.requestsLoading = true;
        try { conn.friendRequests(); } catch (e) { state.requestsLoading = false; }
    }

    /** Round 24: the requests-tab member-list keys, built from the latest
     * friendRequests payload — incoming first, then outgoing. Ensures a model +
     * sentinel-status contact for every entry so the native SocialEntryButton rows
     * render (init reads contacts[key].online) without leaking into the native
     * 联系人/好友 tabs (sentinel status matches no native tab type). */
    function requestsMemberList(): string[] {
        const keys: string[] = [];
        const incoming = (state.requests && state.requests.incoming) || [];
        const outgoing = (state.requests && state.requests.outgoing) || [];
        for (const r of incoming) keys.push(ensureRequestEntry('in', r.name));
        for (const r of outgoing) keys.push(ensureRequestEntry('out', r.name));
        return keys;
    }

    /** Round 24: rebuild the requests-tab rows live after the payload changed, IF
     * the tab is currently visible (sort() re-runs onCreateListEntries ->
     * getMemberList, which rebuilds from the fresh state). No-op otherwise — the
     * next tab switch renders from state.requests anyway. */
    function refreshRequestsList(): void {
        const menu: any = (sc as any).menu;
        if (!menu || menu.currentMenu !== (sc as any).MENU_SUBMENU.SOCIAL) return;
        const guiRef = menu.guiReference;
        const social = guiRef && typeof guiRef._getMenuFromID === 'function'
            ? guiRef._getMenuFromID(menu.currentMenu) : null;
        const l = social && social.list;
        if (!l || typeof l.getCurrentTabKey !== 'function' || l.getCurrentTabKey() !== 'requests') return;
        if (!state.requestsDirty) return; // nothing changed since the last render
        state.requestsDirty = false;
        try {
            const sort = (l.tabContent && l.tabContent[l.currentTabIndex] && l.tabContent[l.currentTabIndex].sort) || 0;
            if (typeof l.sort === 'function') l.sort(sort);
        } catch (e) { /* list mid-transition; ignore */ }
        updateRequestsStar();
    }

    /** Round 27: show/hide the 申请管理 tab's star using the GAME'S OWN indicator
     * — sc.NewUnlockOverlay, the pulsing star sprite the native lore tabs attach
     * to mark unviewed entries (NOT a hand-built DOM star; the sprite and its
     * pulse animation are the game's). Shown while there are INCOMING requests
     * the user hasn't seen yet (outgoing never counts); hidden once the tab was
     * viewed or the last incoming request is handled (accept/decline removes it
     * from the server payload). */
    function updateRequestsStar(): void {
        try {
            const btn = _requestsTabBtn;
            const overlay = btn && btn.newUnlock;
            if (!overlay || typeof overlay.activate !== 'function' || typeof overlay.deactivate !== 'function') return;
            const show = (state.requests && state.requests.incoming && state.requests.incoming.length > 0)
                && !state.requestsViewed;
            try {
                if (show && !overlay.overlayActive) overlay.activate();
                else if (!show && overlay.overlayActive) overlay.deactivate();
            } catch (e) { /* a star must never break the list */ }
        } catch (_) { /* ignore */ }
    }

    /** Make a top-bar chip that actually renders. The top bar runs every hotkey
     * button through `doStateTransition("HIDDEN",true)` then `...("DEFAULT")` on
     * show — that requires a `hook.transitions` table, which a bare ButtonGui
     * lacks (the native hotkey buttons get one from ListInfoMenu). Give ours the
     * same transitions, or it stays invisible in the top bar. */
    function makeTopBarChip(text: string): any {
        const chip = new sc.ButtonGui(text, undefined, true, (sc as any).BUTTON_TYPE.SMALL);
        chip.keepMouseFocus = true;
        chip.hook.transitions = {
            DEFAULT: { state: {}, time: 0.2, timeFunction: KEY_SPLINES.EASE },
            HIDDEN: { state: { offsetY: -chip.hook.size.y }, time: 0.2, timeFunction: KEY_SPLINES.LINEAR },
        };
        return chip;
    }

    /** Round 12: combined party cap — real players + synced bots. */
    const MP_PARTY_CAP = 8;
    /** Member rows visible under the pinned local-player row. Self + 2 = three
     * players' height, which exactly fills the native 120px box — more rows
     * scroll instead of overflowing onto the preview pane below (round 12). */
    const PARTY_BOX_SLOTS = 2;

    /** 当前小队 N/8 — real headcount (players + bots) vs the 8-slot cap. The
     * native Lea row carries a currentValue AND a maxValue NumberGui (that's the
     * "2/3" the user saw — native max is PARTY_MAX_MEMBERS+1). */
    function updatePartyHeaderCount(box: any, m: Multiplayer, bots: string[]): void {
        const lea = box.members[0];
        if (!lea || !lea.isLea) return;
        const total = Math.min(MP_PARTY_CAP, m.partyMembers.length + bots.length);
        try {
            if (lea.currentValue) lea.currentValue.setNumber(total, true);
            if (lea.maxValue) lea.maxValue.setNumber(MP_PARTY_CAP, true);
        } catch (e) { /* ignore */ }
    }

    /** Detach the wheel listener + scrollbar from the party box (idempotent). */
    function removePartyWheel(box: any): void {
        if (!box._mpWheelOn) return;
        box._mpWheelOn = false;
        if (box._mpWheelHandler) {
            try {
                window.removeEventListener('mousewheel', box._mpWheelHandler, true);
                window.removeEventListener('DOMMouseScroll', box._mpWheelHandler, true);
            } catch (e) { /* ignore */ }
            box._mpWheelHandler = null;
        }
        if (box._mpScrollbar) { try { box._mpScrollbar.remove(); } catch (e) { /* ignore */ } box._mpScrollbar = null; }
        try { box.hook.setMouseRecord(false); } catch (e) { /* ignore */ }
    }

    /**
     * Round 13: mouse-WHEEL scrolling over the party box (replaces the round-12
     * ▲▼ buttons). CrossCode has no gui-level onMouseWheel — the engine turns the
     * wheel into one-frame key actions (ig.input.mousewheel @117954 → "scrollUp"/
     * "scrollDown"), which the NATIVE member list (sc.ButtonListBox.update) polls
     * whenever the social menu is open. Polling those too would scroll BOTH lists
     * on every tick, so we instead register a CAPTURE-phase DOM listener for the
     * same legacy events and stopPropagation() while the pointer is over the box —
     * ig.input never sees the event, the member list stays put, and the box gets
     * exclusive, per-notch scrolling. The visible scrollbar is a native sc.Slider
     * (the sc.ScrollPane pattern: 2px track at the right edge).
     *
     * Round 24: the slider is sized to ≤75% of the box and vertically centered at
     * the right edge, and its thumb can be MOUSE-DRAGGED (the sc.OptionThumb
     * press/hold protocol). scaleThumb is disabled so the thumb travel equals
     * calcThumbArea() — otherwise the drag delta would be mapped against the wrong
     * track length and fly off.
     */
    function ensurePartyWheel(box: any): void {
        if (box._mpWheelOn) return;
        box._mpWheelOn = true;
        try { box.hook.setMouseRecord(true); } catch (e) { /* ignore */ } // enables hook.mouseOver
        if (!box._mpScrollbar) {
            try {
                const sb = new (sc as any).Slider(true, null, false); // vertical, no scaleThumb (drag math relies on it)
                sb.setAlign(ig.GUI_ALIGN.X_RIGHT, ig.GUI_ALIGN.Y_CENTER);
                sb.setPos(0, 0); // flush right edge, vertically centered
                sb.setSize(2, Math.max(8, Math.floor(((box.hook && box.hook.size.y) || 120) * 0.75)));
                box.addChildGui(sb);
                box._mpScrollbar = sb;
                // Round 24: MOUSE DRAG on the thumb. The engine calls a bare
                // mouse-recorded GUI's onMouseInteract(isOver, click) — NOT mouse
                // coords — so read the live pointer from sc.control like the native
                // OptionFocusSlider/OptionThumb do. The thumb travel == calcThumbArea()
                // (scaleThumb off), so OptionFocusSlider.onDrag's mapping applies 1:1.
                sb.hook.setMouseRecord(true);
                sb.drag = false;
                sb._mpStartValue = 0;
                sb._mpStartY = 0;
                sb.onMouseInteract = function (isOver: boolean, click: boolean) {
                    if (click) return; // OptionThumb guard: act on press/hold/release only
                    try {
                        const pressed = (sc as any).control.getGuiPressed();
                        const held = (sc as any).control.getGuiHold();
                        // isOver gates the press so a click ANYWHERE doesn't start
                        // dragging the party scrollbar — _updateGuiMouse calls every
                        // mouse-recorded GUI's onMouseInteract(false,false) each frame.
                        if (pressed && isOver) {
                            sb.drag = true;
                            sb._mpStartValue = sb.value;
                            sb._mpStartY = (sc as any).control.getMouseY();
                        } else if (sb.drag && (pressed || held)) {
                            // Round 24 fix: keep dragging even when the pointer has
                            // drifted off the 2px track — the engine still calls
                            // onMouseInteract(false,false) every frame on every
                            // mouse-recorded hook, so a bare "no longer over" call
                            // must NOT end the drag. Only a released button does; the
                            // thumb maps from the ABSOLUTE mouse Y (the native
                            // OptionFocusSlider protocol), so the track width is
                            // irrelevant mid-drag.
                            const dy = (sc as any).control.getMouseY() - sb._mpStartY;
                            const delta = (sb.maxValue - sb.minValue) * dy / sb.calcThumbArea();
                            const v = Math.round(sb.range(sb._mpStartValue + delta));
                            sb.setValue(v, true);
                            // Same rebuild the wheel handler triggers: skip when
                            // the value (and therefore the window) didn't move.
                            if (v !== (box._mpScroll || 0)) {
                                box._mpScroll = v;
                                box._mpForceRebuild = true;
                                renderMpPartyBox(box);
                            }
                        } else if (sb.drag) {
                            sb.drag = false; // button genuinely released
                        }
                    } catch (err) { /* never throw out of a GUI callback */ }
                };
            } catch (e) { /* scrollbar + drag are cosmetic — wheel works without them */ }
        }
        const handler = (e: any) => {
            try {
                if (!box.hook.mouseOver) return; // only while the pointer is over the box
                const entries = box._mpEntries || [];
                const maxScroll = Math.max(0, entries.length - PARTY_BOX_SLOTS);
                if (maxScroll <= 0) return;
                // Same normalization as ig.input.mousewheel: wheelDelta/60 (Chrome/
                // Electron) or -detail/2 (Firefox); > 0 = scroll up.
                const up = (e.wheelDelta ? e.wheelDelta / 60 : -e.detail / 2) > 0;
                const next = Math.min(maxScroll, Math.max(0, (box._mpScroll || 0) + (up ? -1 : 1)));
                if (next === (box._mpScroll || 0)) return;
                e.preventDefault();
                e.stopPropagation(); // keep ig.input.mousewheel from firing -> no member-list scroll
                box._mpScroll = next;
                box._mpForceRebuild = true;
                renderMpPartyBox(box);
            } catch (err) { /* never throw out of a DOM listener */ }
        };
        window.addEventListener('mousewheel', handler, true);
        window.addEventListener('DOMMouseScroll', handler, true);
        box._mpWheelHandler = handler;
    }

    /** Push the current scroll offset into the native slider thumb (instant). */
    function updatePartyScrollbar(box: any): void {
        if (!box._mpScrollbar) return;
        try {
            const entries = box._mpEntries || [];
            const maxScroll = Math.max(0, entries.length - PARTY_BOX_SLOTS);
            box._mpScrollbar.setMinMaxValue(0, maxScroll, true);
            box._mpScrollbar.setValue(box._mpScroll || 0, true);
        } catch (e) { /* ignore */ }
    }

    /**
     * Rebuilds the native Social party box from the multiplayer roster instead of
     * sc.party.currentParty. Row 0 is the local player (pinned; carries the
     * 当前小队 N/8 header); below it a SCROLLABLE window of PARTY_BOX_SLOTS rows —
     * remote members first, then synced bots (official + round-12 mod bots). The
     * window keeps the box at its native 120px height no matter how many players
     * the party holds (up to the 8-slot cap), so it never covers the preview
     * pane below.
     */
    function renderMpPartyBox(box: any): void {
        const m = main();
        if (!m || !m.name) return; // not logged in -> leave native behaviour
        try {
            // Rebuild ONLY when the roster changes. This runs from observer
            // notifications (every HP tick of every member) — recreating all rows on
            // each call made the whole box flicker. The rows read the live models,
            // so HP/SP keep updating without any rebuild.
            const bots: string[] = (m as any).partyBots || [];
            const key = m.partyMembers.filter((n) => !!n).join('|') + '#' + bots.join('|');
            if (box._mpRosterKey === key && box.members.length && !box._mpForceRebuild) {
                updatePartyHeaderCount(box, m, bots);
                updatePartyScrollbar(box);
                return;
            }
            box._mpRosterKey = key;
            box._mpForceRebuild = false;

            // Remove existing member rows (the wheel listener + scrollbar slider are
            // persistent children — reconcile them at the end instead).
            for (let i = box.members.length; i--;) {
                try { box.members[i].remove(); } catch (e) { /* ignore */ }
            }
            box.members.length = 0;

            // Row 0: local player (pinned — also carries the N/8 header).
            const player: any = (sc as any).model && (sc as any).model.player;
            if (player) {
                const lea = new sc.SocialPartyMember(true, player);
                box.addChildGui(lea);
                box.members.push(lea);
                lea.show();
            }

            // Every other entry, in order: real members, then synced bots.
            const entries: Array<{ name: string, model: any }> = [];
            for (const name of m.partyMembers) {
                if (!name || name === m.name) continue;
                const model = (sc as any).party.models[name];
                if (!model) continue;
                entries.push({ name, model });
            }
            for (const botName of bots) {
                const model = (sc as any).party.models[botName];
                if (!model) continue;
                entries.push({ name: botName, model });
            }
            box._mpEntries = entries;
            if (typeof box._mpScroll !== 'number' || box._mpScroll < 0) box._mpScroll = 0;
            const maxScroll = Math.max(0, entries.length - PARTY_BOX_SLOTS);
            if (box._mpScroll > maxScroll) box._mpScroll = maxScroll;

            // Only the visible window gets rows this pass.
            let y = (box.members[0] ? box.members[0].hook.size.y : 44) + 3;
            const visible = entries.slice(box._mpScroll, box._mpScroll + PARTY_BOX_SLOTS);
            for (const e of visible) {
                const row = new sc.SocialPartyMember(false, e.model, e.name);
                row.setPos(0, y);
                box.addChildGui(row);
                box.members.push(row);
                row.show();
                y += row.hook.size.y + 3;
            }

            // Round 13: mouse-WHEEL scroll + native slider scrollbar (replaces the
            // round-12 ▲▼ buttons). The wheel listener is a capture-phase DOM hook
            // gated on box.hook.mouseOver, so it is only attached while there is
            // actually something to scroll.
            if (entries.length > PARTY_BOX_SLOTS) ensurePartyWheel(box);
            else removePartyWheel(box);
            updatePartyScrollbar(box);
            updatePartyHeaderCount(box, m, bots);
            // "传送到队友身边" lives in the per-player options popup (under 邀请),
            // not as a fixed button here.
        } catch (e) { /* ignore */ }
    }

    /**
     * Rebuild the friend-options SortMenu deterministically on EVERY open. The
     * SortMenu is a SHARED persistent GUI: the old ad-hoc add/remove of a 删除好友
     * button left ghost ButtonGuis behind (overwriting a buttons[] slot never
     * removes the old child) — that was the "multiple 删除好友 buttons" bug.
     * Canonical order for a multiplayer player: [邀请|踢出|离开队伍] ->
     * [传送到队友身边] -> 联系 -> [删除好友]. NPCs/official bots get ONLY the
     * vanilla base set (邀请/联系) — mp buttons must never leak onto them. The
     * base set is a CONSTANT, never snapshotted from the live buttons: the
     * SortMenu keeps whatever we last built, and the native openOptionsMenu only
     * relabels index 0 — a snapshot taken after an mp open would capture the mp
     * buttons and replay them on every later NPC card (the "删除好友/传送 showing
     * up on official bots" bug).
     */
    const NATIVE_BASE: Array<{ label: string, sortType: number }> =
        [{ label: t('optInvite'), sortType: 0 }, { label: t('optContact'), sortType: 1 }];

    /** Round 22: true when a button carries any mod option marker — used to spot a
     * stale bare native button sitting on a live party member. */
    function hasMpMarker(data: any): boolean {
        return !!(data && (data._mpKick || data._mpLeave || data._mpBotKick || data._mpRegroup || data._mpRemove));
    }

    /** Round 22: kick a live LOCAL party member/bot out of sc.party.currentParty
     * with full cleanup (tag drop + roster splice + adopted-bot delete). Shared by
     * the _mpBotKick execute path, the marker-less defense-in-depth route and the
     * removeMember intercept. Returns true when a member was actually kicked. */
    function kickLocalPartyMember(menu: any, name: string): boolean {
        const party: any = (sc as any).party;
        if (!name || !party || typeof party.isPartyMember !== 'function' || !party.isPartyMember(name)) return false;
        try { party.removePartyMember(name, null, true); } catch (e) { /* ignore */ }
        // Round 15: hard-remove the cached name tag — the hide-pass only sets
        // _visible=false, and a cached tag can be re-shown by addTagAt (bot names are
        // account usernames that can collide with a live player's tag key).
        try { dropNameTag(name); } catch (_) { /* ignore */ }
        // Round 16: also wipe EVERY cached tag (cheap) so no collateral stale tag
        // survives the kick — the per-frame loop rebuilds fresh next frame.
        try { wipeAllNameTags(); } catch (_) { /* ignore */ }
        // Drop it from the cached bot list too so the party box updates immediately
        // (the host's checkBotRoster re-publish confirms it).
        const mm: any = main();
        if (mm && Array.isArray(mm.partyBots)) {
            mm.partyBots = mm.partyBots.filter((x: string) => x !== name);
        }
        if (mm && mm._mpAdoptedBots) {
            try { delete mm._mpAdoptedBots[name]; } catch (_) { /* ignore */ }
        }
        try { menu.options.hideSortMenu(); menu.onOptionsBack(); } catch (e) { /* ignore */ }
        return true;
    }

    function rebuildSocialOptions(menu: any, isMp: boolean, inPartyWith: boolean, isLeader: boolean, isLocalBot: boolean, synced: boolean, host: boolean, full: boolean, botBlocked: boolean, followerOfRemoteLeader?: boolean): void {
        const opts = menu && menu.options;
        if (!opts) return;
        // Clear EVERY button: gui child + buttongroup focus entry + array slot.
        for (let i = opts.buttons.length; i--;) {
            const btn = opts.buttons[i];
            if (!btn) continue;
            try { if (opts.buttongroup) opts.buttongroup.removeFocusGui(0, i); } catch (e) { /* ignore */ }
            try { btn.remove(); } catch (e) { /* ignore */ }
        }
        opts.buttons.length = 0;
        opts.yPosition = 0;
        const add = (label: string, sortType: number, marker?: string) => {
            // addButton(langKey, sortType, position); the lang key is irrelevant —
            // we overwrite the text right after.
            opts.addButton('removeFriend', sortType, opts.buttons.filter(Boolean).length);
            const btn = opts.buttons[opts.buttons.length - 1];
            if (btn) {
                if (btn.setText) btn.setText(label, true);
                btn.data = btn.data || {};
                btn.data.sortType = sortType;
                if (marker) (btn.data as any)[marker] = true;
            }
            return btn;
        };
        // Button 0: invite — or kick/leave once you share a party with the target.
        // Round 12: a local follower bot (official OR mod) in the party gets 踢出,
        // restoring the native isPartyMember->"remove" behaviour our rebuild used
        // to clobber (the "bot invite button never turns into kick" bug).
        // Round 22: membership DECIDES the button. A target live in sc.party.
        // currentParty (isLocalBot) NEVER gets the bare sortType-0 invite — the
        // native executor would treat it as "remove" via removeMember with NO tag
        // cleanup, and the button wrongly flipped back to 邀请 after a map move
        // (host-status change) flipped the old canKickBot. A host-synced bot on a
        // member client keeps the round-12 "can't durably kick" intent as a
        // DISABLED kick button (still marked _mpBotKick), never the invite label.
        if (isMp && inPartyWith) {
            if (isLeader) add(t('optKick'), 0, '_mpKick');       // leader removes the member
            else add(t('optLeaveParty'), 0, '_mpLeave');           // member leaves the party
        } else if (isLocalBot && synced && !host && followerOfRemoteLeader) {
            const btn = add(t('optKick'), 0, '_mpBotKick');     // member can't durably kick a host-synced bot
            if (btn && typeof btn.setActive === 'function') btn.setActive(false);
        } else if (isLocalBot) {
            add(t('optKick'), 0, '_mpBotKick');                  // kick a follower bot
        } else if (full) {
            const btn = add(t('partyFull'), 0);                // party at the 8-slot cap
            if (btn && typeof btn.setActive === 'function') btn.setActive(false);
        } else if (botBlocked) {
            // Round 13: only the party LEADER may invite bots (official or mod).
            const btn = add(t('botLeaderOnly'), 0);
            if (btn && typeof btn.setActive === 'function') btn.setActive(false);
        } else {
            // Only a NON-party-member target (friend/NPC not yet in the party) ever
            // gets the bare native sortType-0 invite.
            const btn = add(NATIVE_BASE[0].label, NATIVE_BASE[0].sortType);
            // Round 23 wave 3: while an invite is in flight the button stays disabled
            // until the server's partyActionResult clears the guard.
            if (btn && typeof btn.setActive === 'function' && inviteGuardActive()) btn.setActive(false);
        }
        // 传送到队友身边 directly UNDER the first button, only for a party teammate.
        if (isMp && inPartyWith) add(t('teleportToMate'), 3, '_mpRegroup');
        add(NATIVE_BASE[1].label, NATIVE_BASE[1].sortType);
        if (isMp) add(t('removeFriend'), 2, '_mpRemove');
    }

    // ------------------------------------------------- sc.SocialList injection
    // Round 25: the engine's sc.party.isFriend reads contacts[name].status
    // UNGUARDED (game.compiled.js party.js). After a rebuildContacts deletes a
    // contact (friend removed / reconciled away), ANY native caller — the STATUS
    // sort comparator, onListEntrySelected, onListEntryPressed — throws on the
    // dead key. Guard it globally: a missing contact is simply "not a friend".
    // This also keeps the sort-based refresh path (refreshOpenMenu -> l.sort ->
    // sortTypeStatus) from throwing on a contact that vanished mid-rebuild.
    if ((sc as any).PartyModel && typeof (sc as any).PartyModel.inject === 'function') {
        (sc as any).PartyModel.inject({
            isFriend(this: any, name: string) {
                const c = this && this.contacts ? this.contacts[name] : null;
                return !!c && c.status === (sc as any).PARTY_MEMBER_TYPE.FRIEND;
            },
        });
    }

    (sc.SocialList as any).inject({
        init(this: any) {
            this.parent();
            this.addTab('room', 2, { type: PARTY_MEMBER_TYPE.CONTACT });
            // Round 23 wave 3: 申请管理 (Requests) tab — index 3 after room.
            // Round 24: renders as a NATIVE member list built from the latest
            // friendRequests payload (incoming first, then outgoing), so the tab
            // type is the sentinel that matches no native contact status — the rows
            // come from getMemberList, not from the native status filter.
            this.addTab('requests', 3, { type: PARTY_MEMBER_TYPE_MP });
        },
        onTabButtonCreation(this: any, b: string, a: number, d: any) {
            if (b === 'requests') {
                const btn = new sc.ItemTabbedBox.TabButton(t('requestsTab'), 'social-requests', 100);
                btn.textChild.setPos(7, 1);
                btn.setPos(0, 2);
                btn.setData({ type: d.type });
                // Round 27: the requests tab gets the GAME'S OWN star indicator —
                // sc.NewUnlockOverlay (the pulsing 11x11 star sprite the native
                // lore tabs put on unviewed entries; game.compiled.js LoreList
                // onTabButtonCreation attaches it exactly like this). Driven by
                // updateRequestsStar() from the friendRequests payload; the
                // indicator starts hidden and only shows for unviewed INCOMING
                // requests.
                try {
                    const overlay = new (sc as any).NewUnlockOverlay();
                    overlay.deactivate(false);
                    overlay.setPos(2, 2);
                    btn.addChildGui(overlay);
                    (btn as any).newUnlock = overlay;
                } catch (e) { /* a missing overlay must never break the tab */ }
                _requestsTabBtn = btn;
                updateRequestsStar();
                this.addChildGui(btn);
                return btn;
            }
            if (b === 'room') {
                const btn = new sc.ItemTabbedBox.TabButton(t('roomTab'), 'social-room', 85);
                btn.textChild.setPos(7, 1);
                btn.setPos(0, 2);
                btn.setData({ type: d.type });
                this.addChildGui(btn);
                return btn;
            }
            return this.parent(b, a, d);
        },
        show(this: any) {
            this.parent();
            refresh();
            // Round 24: the requests tab is a native member list — pull a fresh
            // friendRequests payload so it's current when the tab is opened
            // (fetchRequests guards against a double-fire while one is in flight).
            fetchRequests();
        },
        // Room tab shows everyone present (they're all online by definition). Only
        // filter on the ROOM tab — the native 联系人 (contacts) tab must keep showing
        // offline contacts, and both tabs share type CONTACT so we distinguish by key.
        // Round 23 wave 3 + round 24: the REQUESTS tab renders native member rows
        // built from the friendRequests payload (incoming first, then outgoing).
        getMemberList(this: any, b: number, a: number) {
            const tabKey = typeof this.getCurrentTabKey === 'function' ? this.getCurrentTabKey() : null;
            if (tabKey === 'requests') {
                state.requestsDirty = false; // rendered from the fresh payload
                // Round 27: the user is VIEWING the requests tab — its star has
                // done its job (new requests are visible right in front of them);
                // genuinely new arrivals re-raise it via the onFriendRequests diff.
                state.requestsViewed = true;
                updateRequestsStar();
                return requestsMemberList();
            }
            const list = this.parent(b, a);
            if (tabKey === 'room') {
                // Render the room roster DIRECTLY (they're all online same-instance
                // players), INCLUDING OURSELVES (round 9 — the list shows self too;
                // the server now includes the caller in the roster). This is robust
                // against the native contact list missing injected contacts depending
                // on how it was built.
                const roster = state.roomPlayers.filter((n) => !!n);
                console.log('[multiplayer] room tab render -> ' + JSON.stringify(roster));
                return roster;
            }
            return list;
        },
        // Round 25: the native onCreateListEntries clears the list FIRST, then
        // constructs `new sc.SocialEntryButton(key, party.getPartyMemberModel(key))`
        // — a missing model throws INSIDE the loop, AFTER the clear, leaving the
        // tab EMPTY (refreshOpenMenu's try/catch swallows the throw, so it looks
        // like the list "just stopped rendering"). This override keeps the native
        // ordering (getMemberList BEFORE the clears — a comparator throw leaves
        // the existing rows untouched), skips keys whose model is missing, and
        // isolates each entry construction so ONE broken entry can never wipe the
        // whole tab. The model/contact invariants above make this unreachable in
        // practice; it exists so the sort-rebuild CANNOT abort midway.
        onCreateListEntries(this: any, list: any, group: any, type: number, sortVal: number) {
            let keys: string[] = [];
            try {
                keys = this.getMemberList(type, sortVal);
            } catch (e) {
                // Comparator threw (a dead contact/model): keep the EXISTING rows
                // instead of clearing into an empty tab (mirrors the native
                // pre-clear order).
                return;
            }
            const party: any = (sc as any).party;
            keys = keys.filter((k) => { try { return !!party.models[k]; } catch (_) { return false; } });
            list.clear();
            if (group && typeof group.clear === 'function') group.clear();
            for (const k of keys) {
                try {
                    const btn = new (sc as any).SocialEntryButton(k, party.getPartyMemberModel(k));
                    list.addButton(btn);
                } catch (e) { /* skip the broken entry; never abort the rebuild */ }
            }
        },
        onListEntryPressed(this: any, b: any) {
            // Round 24: a friend-request row acts on the request itself — 接受/拒绝
            // for an incoming one, 撤回 for an outgoing one — instead of the native
            // member options. b._mpReqKind/_mpReqName are stamped by the
            // SocialEntryButton.init override below; native rows keep the default.
            if (b && b._mpReqKind && b.key && typeof b.key === 'string') {
                const name = b._mpReqName || (b._mpReqKind === 'in' ? b.key.slice(6) : b.key.slice(7));
                if (name) {
                    try { if (this.submitSound && this.submitSound.play) this.submitSound.play(); } catch (e) { /* ignore */ }
                    if (b._mpReqKind === 'in') openFriendRequestBox(name);
                    else openWithdrawWindow(name);
                    return;
                }
            }
            return this.parent(b);
        },
        // Round 24 hotfix: safety net for dead-key rows. If a contact was deleted
        // (friend removed / reconciled) and its button somehow survives a rebuild,
        // the engine's onListEntrySelected reads sc.party.isFriend(key) ->
        // contacts[key].status UNGUARDED and crashes. Block the dead key here so
        // the native path is never reached (the refresh paths rebuild via sort(),
        // this only ever fires on a race/uncovered strip path).
        onListEntrySelected(this: any, b: any) {
            try {
                const key = b && b.key;
                if (key && !(sc as any).party.contacts[key]) return;
            } catch (e) { /* fall through to the native handler */ }
            return this.parent(b);
        },
    });

    // ------------------------------------------- sc.SocialEntryButton injection
    // Round 9: mark the block host in the member lists. Entry labels come from
    // SocialEntryButton.getMemberName(key, model) (native: model.getCharacterName()
    // || key), so append a host suffix there — this.key keeps the RAW username, so
    // invite/kick/regroup actions stay unaffected. Round 11: the suffix is scoped
    // to the 房间玩家 tab ONLY (the user doesn't want it in the friends/contacts
    // lists) — walk up to the tabbed list and check getCurrentTabKey() === 'room'.
    if ((sc as any).SocialEntryButton) {
        ((sc as any).SocialEntryButton as any).inject({
            init(this: any, a: string, b: any) {
                this.parent(a, b);
                // Round 24: stamp the request-tab rows so onListEntryPressed can
                // route a click to the accept/decline or withdraw window. a is the
                // synthetic key (reqIn:<name> / reqOut:<name>); keep the real
                // username too so the windows don't re-parse it.
                if (typeof a === 'string' && a.indexOf('reqIn:') === 0) {
                    this._mpReqKind = 'in';
                    this._mpReqName = a.slice(6);
                } else if (typeof a === 'string' && a.indexOf('reqOut:') === 0) {
                    this._mpReqKind = 'out';
                    this._mpReqName = a.slice(7);
                }
            },
            getMemberName(this: any, a: string, b: any) {
                const base = this.parent(a, b);
                if (!state.roomHost || a !== state.roomHost) return base;
                let g: any = this;
                for (let i = 0; i < 8 && g; i++) {
                    if (typeof g.getCurrentTabKey === 'function') {
                        return g.getCurrentTabKey() === 'room' ? base + t('hostSuffix') : base;
                    }
                    g = g.parentGui;
                }
                return base;
            },
        });
    }

    // -------------------------------------------------- sc.SocialMenu injection
    (sc.SocialMenu as any).inject({
        init(this: any) {
            this.parent();

            // "加好友" chip -> opens the add-friend box. Lives in the top bar so it
            // is added/removed with the rest of the menu's hotkeys.
            this.hotkeyAddFriend = makeTopBarChip(t('addFriendChip'));
            this.hotkeyAddFriend.onButtonPress = () => { openAddFriendBox(main()); };

            // Online-count chip (display only; not mouse-clickable).
            this._mpOnlineChip = makeTopBarChip(onlineChipText(0));
            this._mpOnlineChip.onButtonPress = () => { /* display only */ };
        },
        onAddHotkeys(this: any, b: any) {
            // Register for top-bar rendering BEFORE the native commit so our chips
            // are laid out together with sort/help in a single top-bar build.
            sc.menu.addHotkey(() => this.hotkeyAddFriend);
            sc.menu.addHotkey(() => this._mpOnlineChip);
            this.parent(b); // parent's commitHotKeysToTopBar -> sc.menu.commitHotkeys(b)
            // ... and ALSO register as global buttons so they respond to the mouse
            // (a hotkey callback alone only renders; addGlobalButton wires the
            // buttonInteract that mouse clicks go through). The 加好友 chip's check
            // returns false so it never fires from a keyboard hotkey — mouse only.
            sc.menu.buttonInteract.addGlobalButton(this.hotkeyAddFriend, () => false);
        },
        // Intercept the single-player social actions for our injected players and
        // route them to the server instead. The game's SOCIAL_ACTION event returns
        // null for pseudo-contacts (no common-event handler), which is what crashed
        // invite with "Cannot read property 'addEventAttached' of null".
        inviteMember(this: any, b: string) {
            // Round 13: bots (official + mod) are leader-only invites. A member who
            // is not the party leader must never grow the bot roster — bots follow
            // the LEADER's world, not theirs.
            const botInviteBlocked = (): boolean => {
                const mm: any = main();
                return !!mm && !!mm.partyMembers && mm.partyMembers.length > 1
                    && mm.partyLeader !== mm.name;
            };
            if (isMpPlayer(b)) {
                const m = main();
                const conn = m && m.connection;
                if (!conn) return;
                if (isOnlineMp(b)) {
                    // A real online client — they join as a network member (mirror).
                    // Round 23 wave 3: arm the invite in-flight guard so the 邀请 button
                    // stays disabled until the server's partyActionResult arrives (the
                    // busy-check result also surfaces here as a toast).
                    setInviteGuard(true);
                    conn.partyInvite(b);
                } else {
                    // Round 12: an OFFLINE friend can't network-join, so invite them
                    // as a synced follower "mod bot" instead — the host adds them to
                    // its own party and checkBotRoster broadcasts the name; member
                    // clients spawn their own follower copies (applyPartyBots). This
                    // is what makes the mod's own bots visible to the whole party.
                    if (botInviteBlocked()) return;
                    const party: any = (sc as any).party;
                    if (partyIsFull()) return;
                    if (party.currentParty.indexOf(b) === -1) {
                        try { party.addPartyMember(b, null, false, true); } catch (e) { /* ignore */ }
                    }
                }
                return;
            }
            // Official/native bot: the native SOCIAL_ACTION path adds it locally.
            // Enforce the combined 8-slot cap (self + currentParty).
            if (botInviteBlocked()) return;
            if (partyIsFull()) return;
            return this.parent(b);
        },
        removeMember(this: any, b: string) {
            if (isMpPlayer(b)) {
                const conn = main() && main()!.connection;
                if (conn) conn.partyLeave();
                return;
            }
            // Round 22: a NON-mp local bot (native follower / adopted mod bot) must be
            // kicked with tag + roster cleanup, not through the native executor (which
            // leaves the cached name tag behind and desyncs m.partyBots/_mpAdoptedBots).
            if (b) {
                try {
                    const party: any = (sc as any).party;
                    if (party && typeof party.isPartyMember === 'function' && party.isPartyMember(b)) {
                        if (kickLocalPartyMember(this, b)) return;
                    }
                } catch (_) { /* fall through to native */ }
            }
            return this.parent(b);
        },
        contactMember(this: any, b: string) {
            if (isMpPlayer(b)) {
                // ROUND 93: 联系 on a real player opens the private chat channel with
                // them (multi-tab, closable — see chatBox.ts). Close the options popup
                // and the social menu first so the chat input owns the focus.
                try { if (this.options && typeof this.options.hideSortMenu === 'function') this.options.hideSortMenu(); } catch (_) { /* ignore */ }
                try { if (typeof this.onOptionsBack === 'function') this.onOptionsBack(); } catch (_) { /* ignore */ }
                try { if (typeof this.exitMenu === 'function') this.exitMenu(); } catch (_) { /* ignore */ }
                openPrivateChannel(b, true);
                return;
            }
            return this.parent(b);
        },
        // The options popup is rebuilt deterministically on every open (see
        // rebuildSocialOptions): mp teammates get 邀请 / [传送到队友身边] / 联系 /
        // 删除好友; NPCs get the vanilla base set. No ad-hoc add/remove, so no
        // ghost buttons can accumulate on the shared SortMenu.
        openOptionsMenu(this: any, b: any, a: any) {
            // Parent FIRST, rebuild AFTER. For party members the native code
            // rewrites button labels (setButtonKey(0,"remove")); rebuilding BEFORE
            // it let the native overwrite our 邀请 label, and its "remove" execute
            // routed through our removeMember intercept -> conn.partyLeave(), so a
            // LEADER clicking remove on a member left the whole party. Rebuilding
            // after parent wins deterministically.
            this.parent(b, a);
            try {
                // a = contacts-only variant; mp players never live in that tab.
                if (!a && b && b.key) {
                    const key = b.key;
                    const isMp = isMpPlayer(key);
                    const m: any = main();
                    const inPartyWith = isMp && !!m && !!m.partyMembers
                        && m.partyMembers.length > 1 && m.partyMembers.indexOf(key) !== -1;
                    const isLeader = inPartyWith && !!m && m.partyLeader === m.name;
                    // Round 12: follower bots (official OR mod) sitting in the local
                    // party get a 踢出 button. Synced (host-broadcast) bots are only
                    // kickable by the host — a member-side kick would be undone by the
                    // next partyBots re-broadcast.
                    const party: any = (sc as any).party;
                    const isLocalBot = !inPartyWith && !!party && typeof party.isPartyMember === 'function'
                        && party.isPartyMember(key);
                    const synced = !!m && Array.isArray(m.partyBots) && (m.partyBots as string[]).indexOf(key) !== -1;
                    const hostFlag = !!(m && m.host);
                    // Round 13: bots (official followers already in the local party,
                    // or OFFLINE mp friends that would join as mod bots) can only be
                    // INVITED by the party leader — members get a disabled button.
                    const inParty = !!m && !!m.partyMembers && m.partyMembers.length > 1;
                    // Round 14: the round-13 check missed OFFICIAL bots that are not
                    // mp players and not in the party yet (isLocalBot && isMp both
                    // false) — members still saw a live 邀请 on them. Any character
                    // in sc.PARTY_OPTIONS would join as a local-only follower bot when
                    // invited, so it counts as a bot target too.
                    const partyOpts: any = (sc as any).PARTY_OPTIONS;
                    const isOfficialBot = !isMp && Array.isArray(partyOpts) && partyOpts.indexOf(key) !== -1;
                    const botTarget = isLocalBot || (isMp && !isOnlineMp(key)) || isOfficialBot;
                    const botBlocked = botTarget && inParty && !(m && m.partyLeader === m.name);
                    // ROUND 32 (item 5): the old round-22 disabled-kick rule keyed ONLY off
                    // `!host` (the local INSTANCE-host flag). When a party leader carries a bot
                    // into an ALREADY-OCCUPIED shared town, the server demotes them (another
                    // player is the town-instance host), so `m.host` goes false and the leader's
                    // OWN bot rendered as a disabled kick. The disabled kick must apply ONLY to
                    // a FOLLOWER of a REMOTE leader (someone else's host-broadcast bot), never to
                    // the bot's owner. The owner is exactly the local party leader
                    // (m.partyLeader === m.name); everyone else is a follower.
                    const followerOfRemoteLeader = inParty && !!m && m.partyLeader !== m.name;
                    rebuildSocialOptions(this, isMp, inPartyWith, isLeader, isLocalBot, synced, hostFlag, partyIsFull(), !!botBlocked, followerOfRemoteLeader);
                }
            } catch (e) { /* ignore */ }
        },
        onOptionsExecute(this: any, b: any) {
            const focused = this._keepButtonFocused && this._keepButtonFocused.key;
            // Round 12: kick a follower bot (official OR mod) out of the local party.
            // NOT gated on isMpPlayer — official bots are the common case. On the
            // host, checkBotRoster publishes the shrunken roster within ~1s and
            // members drop their copies; on a member it only affects the local list.
            if (b && b.data && focused && b.data._mpBotKick) {
                // Round 22: shared kick path (tag drop + roster splice + adopted-bot
                // cleanup) — also the route for a DISABLED host-synced bot kick if it
                // ever fires.
                kickLocalPartyMember(this, focused);
                return;
            }
            if (b && b.data && focused && isMpPlayer(focused)) {
                const conn = main() && main()!.connection;
                if (b.data._mpKick) {
                    // Leader removes this member from the party (server validates
                    // leader status; the kicked player gets partyUpdate null).
                    if (conn) conn.partyKick(focused);
                    try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
                    return;
                }
                if (b.data._mpLeave) {
                    // Non-leader member leaves the party outright.
                    if (conn) conn.partyLeave();
                    try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
                    return;
                }
                if (b.data._mpRegroup) {
                    // Teleport next to the clicked teammate (server resolves their
                    // location; unlock-guarded on the client).
                    const mm = main();
                    // Round 19: while the USER is in a cutscene, refuse instead of
                    // teleporting (a mid-story teleport would fight the story UI).
                    try {
                        const mdl: any = (sc as any).model;
                        if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) {
                            if (mm && typeof (mm as any).showToast === 'function') (mm as any).showToast(t('teleportBusy'));
                            try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
                            return;
                        }
                    } catch (_) { /* fall through to teleporting */ }
                    if (mm && typeof (mm as any).requestRegroup === 'function') (mm as any).requestRegroup(focused);
                    try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
                    return;
                }
                if (b.data._mpRemove || b.data.sortType === 2) {
                    // Round 23 wave 3: confirm before removing a friend. The options
                    // popup is closed first so the confirm window isn't layered over it;
                    // the actual friendRemove only fires on 确认.
                    try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
                    confirmRemoveFriend(focused, () => {
                        if (conn) conn.friendRemove(focused);
                        // Round 24: NO optimistic contact downgrade here — the old
                        // `status = CONTACT` left the removed friend lingering in the
                        // native 联系人 tab. The server pushes a fresh friendList to
                        // both sides (onFriendList -> rebuildContacts reconciles
                        // exactly to state.friends), so just drop the local copy and
                        // reconcile immediately on the acting side.
                        state.friends = state.friends.filter((f) => f.name !== focused);
                        rebuildContacts();
                        refreshOpenMenu();
                    });
                    return;
                }
            }
            // Round 22: defense-in-depth — a focused LIVE local party member/bot whose
            // button carries no _mp marker (a stale bare sortType-0 invite from an old
            // rebuild) must never reach the native executor (which "invites" the
            // in-party bot = removeMember with no tag cleanup). Route to the mod kick
            // path; non-members / real network members fall through unchanged.
            if (focused && !(b && b.data && hasMpMarker(b.data)) && !isMpPlayer(focused)) {
                try {
                    if (kickLocalPartyMember(this, focused)) return;
                } catch (_) { /* fall through to native */ }
            }
            return this.parent(b);
        },
        showMenu(this: any) {
            this.parent();
            refresh();
            // Show the cached online count immediately (don't wait for the timer).
            const m0 = main();
            if (m0 && this._mpOnlineChip) {
                try { this._mpOnlineChip.setText(onlineChipText(m0.onlineCount || 0)); } catch (e) { /* ignore */ }
            }
            const m = main();
            if (m && m.connection && !state.refreshTimer) {
                state.refreshTimer = setInterval(() => {
                    try { if (m.connection) m.connection.onlineCount(); } catch (e) { /* ignore */ }
                    // Reflect the freshly-cached count.
                    if (this._mpOnlineChip && m) {
                        try { this._mpOnlineChip.setText(onlineChipText(m.onlineCount || 0)); } catch (e) { /* ignore */ }
                    }
                }, 5000);
            }
        },
        exitMenu(this: any) {
            // Remove the global button BEFORE parent() so it can't leak into other
            // submenus (this is why the button lingered after leaving the page).
            sc.menu.buttonInteract.removeGlobalButton(this.hotkeyAddFriend);
            // Round 13: belt-and-braces for the party-box wheel listener + scrollbar
            // (in case the box is dropped without its own hide() running).
            try { if (this.party) removePartyWheel(this.party); } catch (e) { /* ignore */ }
            // Round 23 wave 3 + review: drop the mp windows when the social menu
            // closes. Any open mp modal (accept/decline, withdraw, confirm) + the
            // add-friend box must not survive a menu close / map change —
            // closeMpModals clears them.
            closeMpModals();
            this.parent();
            if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = undefined; }
        },
    });

    // ------------------------------ info box: show the real username for players
    (sc.SocialInfoBox as any).inject({
        setCharacter(this: any, a: any) {
            this.parent(a);
            if (isMpPlayer(a)) {
                const username = (sc as any).party.models[a]._mpName;
                state.shownName = username;
                try {
                    // Round 9: the class line doubles as the block-host indicator.
                    this.clazz.setText(state.roomHost === username ? t('infoBlockHost') : t('infoOnlinePlayer'));
                    overwriteInfoWithRealProfile(this, username, main());
                    // The name TextGui is mod-tracked (per-frame overwrite from the
                    // character's realname); the injected model's untracked character
                    // realname would replace the username, so pin it back each frame.
                    if (!this._mpNamePinned) {
                        this._mpNamePinned = true;
                        const self = this;
                        const origUpdate = this.update ? this.update.bind(this) : null;
                        this.update = function (...args: any[]) {
                            if (origUpdate) origUpdate(...args);
                            if (state.shownName && self.name && self.name.text !== state.shownName) {
                                self.name.setText(state.shownName);
                            }
                        };
                    }
                } catch (e) { /* ignore */ }
            } else {
                state.shownName = undefined;
            }
        },
    });

    // The party box natively renders sc.party.currentParty (single-player follower
    // bots). Our party members are REAL network players, so we rebuild the box from
    // the server roster: top row = local player (account name), then one row per
    // remote party member's injected model. No bots.
    (sc.SocialPartyBox as any).inject({
        updatePartyMembers(this: any) {
            renderMpPartyBox(this);
        },
        show(this: any, a: any) {
            this.parent(a);
            renderMpPartyBox(this);
        },
        hide(this: any, a: any) {
            // Round 13: never leave the wheel listener + scrollbar attached while the
            // box is hidden (the DOM listener would keep eating wheel events and the
            // member list would double-scroll again once reopened).
            removePartyWheel(this);
            this.parent(a);
        },
    });

    // In the party box, the TOP row is the local player (sc.model.player, a Lea
    // config) — its name shows "Lea"/"莉亚". When playing multiplayer it should be
    // the logged-in account name. SocialBaseInfoBox.show renders that row's name
    // from b.getCharacterName(), so we patch it after the fact for the player row.
    (sc.SocialBaseInfoBox as any).inject({
        show(this: any, a: any, b: any) {
            this.parent(a, b);
            try {
                const m = main();
                const me = m && m.name;
                const player: any = (sc as any).model && (sc as any).model.player;
                // Only the local player's own row (b is the real PlayerModel).
                if (me && b && player && b === player && this.name && this.name.setText) {
                    this.name.setText(me);
                    // The name TextGui is mod-tracked (per-frame overwrite); pin the
                    // account name back each frame so it doesn't revert to "莉亚".
                    if (!this._mpPlayerNamePinned) {
                        this._mpPlayerNamePinned = true;
                        const self = this;
                        const origUpdate = this.update ? this.update.bind(this) : null;
                        this.update = function (...args: any[]) {
                            if (origUpdate) origUpdate(...args);
                            const mm = main();
                            const acc = mm && mm.name;
                            const pl: any = (sc as any).model && (sc as any).model.player;
                            if (acc && pl && self._mpRowModel === pl && self.name && self.name.text !== acc) {
                                self.name.setText(acc);
                            }
                        };
                    }
                    this._mpRowModel = player;
                }
            } catch (e) { /* ignore */ }
        },
    });
}

/**
 * Overwrites the SocialInfoBox's stat numbers + equip list with the player's REAL
 * synced profile (instead of the cloned face-model's placeholder stats/equip,
 * which is what made the details "all wrong"). Anything we don't have a real
 * value for is left as-is; the equip list is rebuilt from the real item ids.
 */
function overwriteInfoWithRealProfile(self: any, username: string, m: Multiplayer | undefined): void {
    const profile = m && m.getPlayerProfile ? m.getPlayerProfile(username) : undefined;
    // One-line diagnostic so we can see in the console whether a real profile was
    // available when the card was opened (equip preview depends on it).
    if (!(self as any)._mpProfileLogged) {
        (self as any)._mpProfileLogged = true;
        console.log('[multiplayer] info card for ' + username + ': profile=' +
            (profile ? 'yes lvl=' + profile.level + ' equip=' + JSON.stringify(profile.equip) : 'NONE'));
    }

    // Real stats (only overwrite numbers we actually have).
    if (profile) {
        try {
            if (typeof profile.hp === 'number') self.baseHp.setNumber(profile.hp, true);
            if (typeof profile.attack === 'number') self.baseAttack.setNumber(profile.attack, true);
            if (typeof profile.defense === 'number') self.baseDefense.setNumber(profile.defense, true);
            if (typeof profile.focus === 'number') self.baseFocus.setNumber(profile.focus, true);
            // Real level on the base face/level line.
            if (typeof profile.level === 'number' && self.base && self.base.level && self.base.level.setNumber) {
                self.base.level.setNumber(profile.level);
            }
            // Real EXP (round 10): the bar is an sc.ItemStatusDefaultBar whose
            // updateValues(skip, model) EXP branch reads `model.exp` + sc.EXP_PER_LEVEL.
            // The injected clone model's exp was never set, so the bar always showed 0.
            if (typeof profile.exp === 'number' && self.base && self.base.exp && self.base.exp.updateValues) {
                self.base.exp.updateValues(true, { exp: profile.exp });
            }
        } catch (e) { /* ignore */ }

        // Real equipment. Always rebuild (even if a slot is missing) so we never
        // leave the cloned face-character's placeholder gear on screen.
        try {
            self.equip.removeAllChildren();
            let y = -3;
            for (const slot of ['head', 'leftArm', 'rightArm', 'torso', 'feet']) {
                const id = profile.equip ? (profile.equip as any)[slot] : -1;
                y = self.createEquipEntry(typeof id === 'number' ? id : -1, y, slot);
            }
        } catch (e) { /* ignore */ }
    } else {
        // No real profile yet (offline or not synced): don't show misleading
        // placeholder stats — show the account name + "online player" and blank
        // the numeric lines to 0 rather than the cloned model's stats.
        try {
            self.baseHp.setNumber(0, true);
            self.baseAttack.setNumber(0, true);
            self.baseDefense.setNumber(0, true);
            self.baseFocus.setNumber(0, true);
            self.equip.removeAllChildren();
            // Also blank the cloned model's (wrong) level.
            if (self.base && self.base.level && self.base.level.setNumber) self.base.level.setNumber(0);
            // And the EXP bar (same reason as above — never leave the clone's value).
            if (self.base && self.base.exp && self.base.exp.updateValues) self.base.exp.updateValues(true, { exp: 0 });
        } catch (e) { /* ignore */ }
    }
}
