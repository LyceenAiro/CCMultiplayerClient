import { Multiplayer } from '../multiplayer';
import { dropNameTag, wipeAllNameTags } from './mpOptions';
import { t } from '../i18n';

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
}

// Character names that provide a face/head + model. Mirrored from
// sc.PARTY_OPTIONS at runtime if available (fallback to a safe subset).
function partyFaceOptions(): string[] {
    const opts = (sc as any).PARTY_OPTIONS;
    if (opts && opts.length) return opts.slice();
    return ['Lea', 'Emilie', 'Sergey', 'Schneider', 'Hlin', 'Grumpy', 'Buggy', 'Glasses', 'Apollo', 'Joern', 'Triblader1', 'Luke'];
}

// Module-level bridges: the real state object and main accessor live inside the
// installSocialMenuButton closure; isOnlineMp/partyIsFull (module scope) reach
// them through these, wired once at install time.
let _mainRef: () => Multiplayer | undefined = () => undefined;
let _stateRef: IMpSocialState = { friends: [], roomPlayers: [], onlineCount: 0, faceFor: {} };

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

    const state: IMpSocialState = { friends: [], roomPlayers: [], onlineCount: 0, faceFor: {} };
    _mainRef = getMain;
    _stateRef = state;

    // ---------------------------------------------------------------- helpers

    function main(): Multiplayer | undefined { return getMain(); }

    /** Lazily wire connection callbacks (the connection only exists post-login). */
    function wireConnection(): boolean {
        const m = main();
        const conn = m && m.connection;
        if (!conn || (conn as any)._mpSocialWired) return !!conn;
        (conn as any)._mpSocialWired = true;

        conn.onFriendList((friends) => {
            state.friends = friends || [];
            rebuildContacts();
            refreshOpenMenu();
        });
        conn.onRoomPlayers((players, host) => {
            state.roomPlayers = players || [];
            state.roomHost = host || '';
            console.log('[multiplayer] roomPlayers: ' + JSON.stringify(state.roomPlayers) + ' host=' + (host || '-'));
            rebuildContacts();
            refreshOpenMenu();
        });
        conn.onOnlineCount((count) => {
            state.onlineCount = count || 0;
            refreshOpenMenu();
        });
        conn.onFriendRequest((from) => {
            showFriendRequestBox(from, conn);
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
        if (wireConnection()) {
            try { conn.friendList(); } catch (e) { /* ignore */ }
            try { conn.onlineCount(); } catch (e) { /* ignore */ }
        }
        wiring = false;
    });

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
                if (c && c._mp) delete party.contacts[name];
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
        for (const name of known) {
            if (state.faceFor[name]) continue;
            const used: { [c: string]: boolean } = {};
            for (const k in state.faceFor) used[state.faceFor[k]] = true;
            let pick = opts[0];
            for (const c of opts) { if (!used[c]) { pick = c; break; } }
            state.faceFor[name] = pick;
        }
    }

    /** Ensure a PartyMemberModel exists for `username` (built on a real character's config). */
    function ensureModel(username: string): any {
        const party: any = (sc as any).party;
        if (party.models[username]) return party.models[username];
        const face = state.faceFor[username] || partyFaceOptions()[0];
        try {
            // Reuse an existing character model so we get a fully-loaded config
            // (face, expression, proxies) without a second async load.
            const src = party.models[face];
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
            model._mpName = username;
            model._mpFace = face;
            // Show the real username everywhere (entry name, sort, info box) instead
            // of the face-character's name (e.g. "Lea"). Instance override, so the
            // shared prototype/character models are untouched.
            model.getCharacterName = () => username;
            model.getCharacterRealName = () => username;
            party.models[username] = model;
            // Seed with the real synced profile (stats + gear) so the native info
            // box reads correct values even before the explicit overwrite runs.
            const m = main();
            if (m && typeof (m as any).applyProfileToModel === 'function') (m as any).applyProfileToModel(username);
            return model;
        } catch (e) {
            return null;
        }
    }

    /** Sync sc.party.contacts/models with the current friends + room players. */
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

        for (const f of state.friends) {
            ensureModel(f.name);
            const c = party.contacts[f.name] || (party.contacts[f.name] = {});
            c._mp = true;
            c.status = PARTY_MEMBER_TYPE.FRIEND;
            c.online = !!f.online; // server friendList carries the live online flag
            c.locked = false;
        }
        for (const p of state.roomPlayers) {
            ensureModel(p);
            const existing = party.contacts[p];
            // Never touch a friend's online flag from the room logic (a friend who
            // is offline must stay "offline" even if they were recently in the room).
            if (existing && existing.status === PARTY_MEMBER_TYPE.FRIEND) continue;
            const c = existing || (party.contacts[p] = {});
            c._mp = true;
            c.status = PARTY_MEMBER_TYPE.CONTACT;
            c.online = true;
            c.locked = false;
        }
        // Players who left the room and aren't friends: mark offline (keep the entry cheap).
        for (const name in party.contacts) {
            const c = party.contacts[name];
            if (!c || !c._mp) continue;
            const isFriend = state.friends.some((f) => f.name === name);
            const inRoom = state.roomPlayers.indexOf(name) !== -1;
            if (!isFriend && !inRoom && c.status === PARTY_MEMBER_TYPE.CONTACT) c.online = false;
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
            // Rebuild the visible list (updatePartyMembers re-runs the current tab's
            // member list so online/offline dots flip live) and the party box.
            if (social.list && typeof social.list.updatePartyMembers === 'function') {
                social.list.updatePartyMembers();
            }
            if (social.party && typeof social.party.updatePartyMembers === 'function') {
                social.party.updatePartyMembers();
            }
        } catch (e) { /* menu mid-transition; ignore */ }
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
     */
    function ensurePartyWheel(box: any): void {
        if (box._mpWheelOn) return;
        box._mpWheelOn = true;
        try { box.hook.setMouseRecord(true); } catch (e) { /* ignore */ } // enables hook.mouseOver
        if (!box._mpScrollbar) {
            try {
                const sb = new (sc as any).Slider(); // vertical by default, track #1A1A1A / thumb #7E7E7E
                sb.setAlign(ig.GUI_ALIGN.X_RIGHT, ig.GUI_ALIGN.Y_TOP);
                sb.setPos(1, 2);
                sb.setSize(2, 116); // box height 120 - 4 (native ScrollPane inset)
                box.addChildGui(sb);
                box._mpScrollbar = sb;
            } catch (e) { /* scrollbar is cosmetic — wheel works without it */ }
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

    function rebuildSocialOptions(menu: any, isMp: boolean, inPartyWith: boolean, isLeader: boolean, canKickBot: boolean, full: boolean, botBlocked: boolean): void {
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
        if (isMp && inPartyWith) {
            if (isLeader) add(t('optKick'), 0, '_mpKick');       // leader removes the member
            else add(t('optLeaveParty'), 0, '_mpLeave');           // member leaves the party
        } else if (canKickBot) {
            add(t('optKick'), 0, '_mpBotKick');                  // kick a follower bot
        } else if (full) {
            const btn = add(t('partyFull'), 0);                // party at the 8-slot cap
            if (btn && typeof btn.setActive === 'function') btn.setActive(false);
        } else if (botBlocked) {
            // Round 13: only the party LEADER may invite bots (official or mod).
            const btn = add(t('botLeaderOnly'), 0);
            if (btn && typeof btn.setActive === 'function') btn.setActive(false);
        } else {
            add(NATIVE_BASE[0].label, NATIVE_BASE[0].sortType);
        }
        // 传送到队友身边 directly UNDER the first button, only for a party teammate.
        if (isMp && inPartyWith) add(t('teleportToMate'), 3, '_mpRegroup');
        add(NATIVE_BASE[1].label, NATIVE_BASE[1].sortType);
        if (isMp) add(t('removeFriend'), 2, '_mpRemove');
    }

    // ------------------------------------------------- sc.SocialList injection
    (sc.SocialList as any).inject({
        init(this: any) {
            this.parent();
            this.addTab('room', 2, { type: PARTY_MEMBER_TYPE.CONTACT });
        },
        onTabButtonCreation(this: any, b: string, a: number, d: any) {
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
        },
        // Room tab shows everyone present (they're all online by definition). Only
        // filter on the ROOM tab — the native 联系人 (contacts) tab must keep showing
        // offline contacts, and both tabs share type CONTACT so we distinguish by key.
        getMemberList(this: any, b: number, a: number) {
            const list = this.parent(b, a);
            const isRoomTab = typeof this.getCurrentTabKey === 'function' && this.getCurrentTabKey() === 'room';
            if (isRoomTab) {
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
            return this.parent(b);
        },
        contactMember(this: any, b: string) {
            if (isMpPlayer(b)) return; // no single-player "contact" for a real player
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
                    const canKickBot = isLocalBot && (!synced || !!(m && m.host));
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
                    rebuildSocialOptions(this, isMp, inPartyWith, isLeader, canKickBot, partyIsFull(), !!botBlocked);
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
                const party: any = (sc as any).party;
                try {
                    if (party && typeof party.isPartyMember === 'function' && party.isPartyMember(focused)) {
                        party.removePartyMember(focused, null, true);
                    }
                } catch (e) { /* ignore */ }
                // Round 15: hard-remove the cached name tag HERE — the hide-pass only
                // sets _visible=false, and a cached tag can be re-shown by addTagAt
                // (bot names are account usernames that can collide with a live
                // player's tag key). Also clear the adoption bookkeeping so the
                // applyPartyBots cleanup never skips this name.
                try { dropNameTag(focused); } catch (_) { /* ignore */ }
                // Round 16: also wipe EVERY cached tag (cheap) so no collateral stale
                // tag survives the kick — the per-frame loop rebuilds fresh next frame.
                try { wipeAllNameTags(); } catch (_) { /* ignore */ }
                // Drop it from the cached bot list too so the party box updates
                // immediately (the host's checkBotRoster re-publish confirms it).
                const mm: any = main();
                if (mm && Array.isArray(mm.partyBots)) {
                    mm.partyBots = mm.partyBots.filter((x: string) => x !== focused);
                }
                if (mm && mm._mpAdoptedBots) {
                    try { delete mm._mpAdoptedBots[focused]; } catch (_) { /* ignore */ }
                }
                try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
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
                    if (conn) conn.friendRemove(focused);
                    // Optimistically drop it from the local list; server confirms.
                    state.friends = state.friends.filter((f) => f.name !== focused);
                    const party: any = (sc as any).party;
                    if (party && party.contacts[focused] && party.contacts[focused]._mp) {
                        party.contacts[focused].status = PARTY_MEMBER_TYPE.CONTACT;
                    }
                    try { this.options.hideSortMenu(); this.onOptionsBack(); } catch (e) { /* ignore */ }
                    refresh();
                    return;
                }
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

/** Opens the small input overlay for typing a player name to send a friend REQUEST. */
function openAddFriendBox(main: Multiplayer | undefined): void {
    if (!main || !main.connection) {
        console.warn('[multiplayer] not connected; cannot add friend');
        return;
    }
    const box = $('<div class="gameOverlayBox gamecodeMessage"><h3>' + t('addFriendTitle') + '</h3></div>');
    const form = $('<form><input type="text" placeholder="' + t('addFriendPh') + '" /> <input type="submit" value="' + t('addFriendSend') + '" /></form>');
    box.append(form);
    $(document.body).append(box);
    box.addClass('shown');
    ig.system.setFocusLost();

    form.submit(() => {
        const name = String(form.find('input[type=text]').val() || '').trim();
        box.remove();
        ig.system.regainFocus();
        // Swallow the click that closed the box so it doesn't hit a menu button.
        try { (ig.interact as any).setBlockDelay(0.2); } catch (_) { /* ignore */ }
        if (name) {
            // Sends a request; the friend only appears (on both sides) once accepted.
            main.connection.friendAdd(name);
            console.log('[multiplayer] friend request sent to: ' + name);
        }
        return false;
    });

    form.find('input[type=text]').focus();
}

/** Accept/decline box for an incoming friend request. */
function showFriendRequestBox(from: string, conn: any): void {
    const box = $('<div class="gameOverlayBox gamecodeMessage"><b>' + from + t('friendRequestSuffix') + '</b><br></div>');
    const accept = $('<button>' + t('accept') + '</button>');
    const decline = $('<button>' + t('decline') + '</button>');
    accept.on('click', () => { conn.friendAccept(from); box.remove(); ig.system.regainFocus(); });
    decline.on('click', () => { conn.friendDecline(from); box.remove(); ig.system.regainFocus(); });
    box.append(accept).append(decline);
    $(document.body).append(box);
    box.addClass('shown');
    ig.system.setFocusLost();
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
