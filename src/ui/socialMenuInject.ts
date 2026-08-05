import { Multiplayer } from '../multiplayer';

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

/** True when `name` is one of our injected multiplayer players (not a real NPC contact). */
function isMpPlayer(name: any): boolean {
    return !!(name && (sc as any).party && (sc as any).party.models[name] && (sc as any).party.models[name]._mpName);
}

export function installSocialMenuButton(getMain: () => Multiplayer | undefined): void {
    if (typeof sc === 'undefined' || !(sc as any).SocialMenu) {
        console.warn('[multiplayer] sc.SocialMenu not available; social menu injection not installed');
        return;
    }

    const state: IMpSocialState = { friends: [], roomPlayers: [], onlineCount: 0, faceFor: {} };

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
        conn.onRoomPlayers((players) => {
            state.roomPlayers = players || [];
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
        }
        state.account = me;
        state.faceFor = {};
        state.friends = [];
        state.roomPlayers = [];
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
            model._mpName = username;
            model._mpFace = face;
            // Show the real username everywhere (entry name, sort, info box) instead
            // of the face-character's name (e.g. "Lea"). Instance override, so the
            // shared prototype/character models are untouched.
            model.getCharacterName = () => username;
            model.getCharacterRealName = () => username;
            party.models[username] = model;
            return model;
        } catch (e) {
            return null;
        }
    }

    /** Sync sc.party.contacts/models with the current friends + room players. */
    function rebuildContacts(): void {
        const party: any = (sc as any).party;
        if (!party) return;
        ensureAccountScope();
        assignFaces();

        for (const f of state.friends) {
            ensureModel(f.name);
            const c = party.contacts[f.name] || (party.contacts[f.name] = {});
            c._mp = true;
            c.status = PARTY_MEMBER_TYPE.FRIEND;
            c.online = !!f.online;
            c.locked = false;
        }
        for (const p of state.roomPlayers) {
            ensureModel(p);
            const existing = party.contacts[p];
            if (existing && existing.status === PARTY_MEMBER_TYPE.FRIEND) { existing.online = true; continue; }
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
        const social = menu && menu.currentMenu;
        if (!social || !social.list) return;
        try {
            if (social._mpOnlineChip) social._mpOnlineChip.setText('在线 ' + state.onlineCount);
            if (social.list && typeof social.list.setTab === 'function') {
                social.list.setTab(social.list.currentTabIndex || 0, true, { skipSounds: true });
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

    // ------------------------------------------------- sc.SocialList injection
    (sc.SocialList as any).inject({
        init(this: any) {
            this.parent();
            this.addTab('room', 2, { type: PARTY_MEMBER_TYPE.CONTACT });
        },
        onTabButtonCreation(this: any, b: string, a: number, d: any) {
            if (b === 'room') {
                const btn = new sc.ItemTabbedBox.TabButton('房间玩家', 'social-room', 85);
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
        // Room tab shows everyone present (they're all online by definition).
        getMemberList(this: any, b: number, a: number) {
            const list = this.parent(b, a);
            if (b === PARTY_MEMBER_TYPE.CONTACT) {
                return list.filter((name: string) => {
                    const c = (sc as any).party.contacts[name];
                    return c && c.online;
                });
            }
            return list;
        },
    });

    // -------------------------------------------------- sc.SocialMenu injection
    (sc.SocialMenu as any).inject({
        init(this: any) {
            this.parent();

            // "加好友" chip -> opens the add-friend box. Lives in the top bar so it
            // is added/removed with the rest of the menu's hotkeys.
            this.hotkeyAddFriend = makeTopBarChip('加好友');
            this.hotkeyAddFriend.onButtonPress = () => { openAddFriendBox(main()); };

            // Online-count chip (display only; not mouse-clickable).
            this._mpOnlineChip = makeTopBarChip('在线 0');
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
            if (isMpPlayer(b)) {
                const conn = main() && main()!.connection;
                if (conn) conn.partyInvite(b);
                return;
            }
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
        showMenu(this: any) {
            this.parent();
            refresh();
            const m = main();
            if (m && m.connection && !state.refreshTimer) {
                state.refreshTimer = setInterval(() => {
                    try { if (m.connection) m.connection.onlineCount(); } catch (e) { /* ignore */ }
                }, 5000);
            }
        },
        exitMenu(this: any) {
            // Remove the global button BEFORE parent() so it can't leak into other
            // submenus (this is why the button lingered after leaving the page).
            sc.menu.buttonInteract.removeGlobalButton(this.hotkeyAddFriend);
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
                    this.clazz.setText('在线玩家');
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
    const box = $('<div class="gameOverlayBox gamecodeMessage"><h3>加好友</h3></div>');
    const form = $('<form><input type="text" placeholder="玩家名" /> <input type="submit" value="发送请求" /></form>');
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
    const box = $('<div class="gameOverlayBox gamecodeMessage"><b>' + from + ' 请求添加你为好友</b><br></div>');
    const accept = $('<button>接受</button>');
    const decline = $('<button>拒绝</button>');
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
        } catch (e) { /* ignore */ }

        // Real equipment.
        if (profile.equip) {
            try {
                self.equip.removeAllChildren();
                let y = -3;
                for (const slot of ['head', 'leftArm', 'rightArm', 'torso', 'feet']) {
                    const id = (profile.equip as any)[slot];
                    y = self.createEquipEntry(typeof id === 'number' ? id : -1, y, slot);
                }
            } catch (e) { /* ignore */ }
        }
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
        } catch (e) { /* ignore */ }
    }
}
