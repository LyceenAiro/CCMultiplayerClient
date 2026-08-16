import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';
import { openPrivateChannel } from './chatBox';

/**
 * Quick-menu (SHIFT) inspect enhancements:
 *
 *  1. ANCHORS FOLLOW ENTITIES — vanilla places each inspect anchor once in
 *     QuickMenuAnalysis.show() and relied on the world being paused. Our party
 *     mode disables pausing, so anchors drifted away from moving enemies/NPCs.
 *     We re-run alignGuiPosition() every frame (the anchors keep LIVE entity
 *     references; only their screen position was snapshotted).
 *  2. ONLINE PLAYERS INSPECTABLE — remote-player mirrors (_mpMirror Enemy
 *     entities) now report quick-menu settings of a new 'OnlinePlayer' type:
 *     a green anchor with the username tag, plus an info box showing the real
 *     level (from the profile stream) and an add/remove-friend button.
 *  3. HOVER-STICKY INFO BOXES — QuickMenuTypesBase.isMouseOver() hides the
 *     focused box the instant the cursor leaves the 16x16 anchor (the KBM
 *     else-branch), which kills interactive boxes before the cursor reaches
 *     them. We inject a replacement whose KBM branch also treats the box's own
 *     screen rect as hovering, so OnlinePlayer/PartyMember boxes stay alive.
 *  4. CLICKABLE FRIEND BUTTON — the OnlinePlayer box's add/remove-friend button
 *     never had a buttonInteract (BoxGui children are not in any button group),
 *     so mouse clicks were dead. Registering it as a global button on
 *     sc.quickmodel.buttonInteract (check returning false = keyboard-only gate)
 *     routes clicks through the standard mouseOverGui + getGuiClick path.
 *  5. PARTY BOTS INSPECTABLE — sc.PartyMemberEntity (follower bots) had no
 *     getQuickMenuSettings, so the SHIFT scan skipped them. They now report a
 *     'PartyMember' type: a green anchor with the bot's display name, plus the
 *     NATIVE enemy-style hover box (HP/ATK/DEF/FOC + elemental resistances)
 *     fed from the bot's live PartyMemberModel.params.
 */

// sc.PARTY_MEMBER_TYPE.FRIEND (kept in sync with the game).
const CONTACT_FRIEND = 2;

/** Screen-space rect of a gui hook's mouse record (maintained each frame by ig.gui). */
function mpScreenRect(h: any): { x: number; y: number; w: number; h: number } | null {
    return (h && h.screenCoords) ? h.screenCoords : null;
}

/** True when the cursor is inside the anchor↔box keep-alive corridor: the AABB
 * spanning the focused anchor rect and the box rect, inflated by 8px. Covers the
 * dead gap between anchor and box in both default and flipped layouts. */
function mpZoneHit(screen: any, type: string, mx: number, my: number): boolean {
    const box = screen && screen.boxes && screen.boxes[type];
    const sc0 = box && box.active && mpScreenRect(box.hook);
    if (!sc0) return false;
    const an = (sc as any).quickmodel && (sc as any).quickmodel.analFocus;
    const ah = an && an.hook;
    const M = 8;
    let x0 = sc0.x, y0 = sc0.y, x1 = sc0.x + sc0.w, y1 = sc0.y + sc0.h;
    if (ah) { // union with the focused anchor rect
        x0 = Math.min(x0, ah.pos.x); y0 = Math.min(y0, ah.pos.y);
        x1 = Math.max(x1, ah.pos.x + ah.size.x); y1 = Math.max(y1, ah.pos.y + ah.size.y);
    }
    return mx >= x0 - M && mx <= x1 + M && my >= y0 - M && my <= y1 + M;
}

// Once-guard for the QuickMenuTypesBase.isMouseOver replacement below. The other
// injects here are installed exactly once from main.ts; this one gets the same
// treatment so a re-install can never stack a second isMouseOver on the chain.
let _mpMouseOverInjected = false;

// Once-guard for the QuickFocusScreen.hide backstop (section 1c) below — same
// re-install-safety as the isMouseOver flag: only the first install may inject.
let _mpHideBackstopInstalled = false;

export function installQuickMenuEnhancements(getMain: () => Multiplayer | undefined): void {
    if (typeof sc === 'undefined' || typeof ig === 'undefined') {
        console.warn('[multiplayer] quick-menu enhancements: game globals missing');
        return;
    }
    const scAny: any = sc as any;
    if (!scAny.QuickMenuTypesBase || !scAny.QUICK_MENU_TYPES || !scAny.QUICK_INFO_BOXES) {
        console.warn('[multiplayer] quick-menu enhancements: quick-menu classes not found');
        return;
    }

    // ------------------------------------------------- 1. anchors follow entities

    // Vanilla update() only re-aligns while HIDDEN. Re-align every frame while
    // shown — alignGuiPosition() reads entity.coll live, and the NPC/Analyzable/
    // OnlinePlayer subclasses also reposition their name tags from there.
    scAny.QuickMenuTypesBase.inject({
        update(this: any) {
            this.parent();
            try {
                if (this.entity && this.hook.currentStateName === 'DEFAULT' && typeof this.alignGuiPosition === 'function') {
                    this.alignGuiPosition();
                }
            } catch (_) { /* anchor without coll yet; ignore */ }
        },
    });

    // The focused info box is aligned to the anchor once on show() — keep it
    // glued while the inspected entity moves.
    if (scAny.QuickMenuAnalysis) {
        scAny.QuickMenuAnalysis.inject({
            update(this: any) {
                this.parent();
                try {
                    const focus = scAny.quickmodel && scAny.quickmodel.analFocus;
                    const boxes = this.focusContainer && this.focusContainer.boxes;
                    const box = focus && boxes && boxes[focus.type];
                    if (box && box.active && focus.hook && typeof box.alignToBase === 'function') {
                        box.alignToBase(focus.hook);
                    }
                    // Round 18 (issue 2, display side): the native enemy inspect box is a
                    // STATIC snapshot — sc.QUICK_INFO_BOXES.Enemy.setData reads
                    // params.getStat('hp') once at open. The scaled max IS on member puppets
                    // (via blocks), but an open box never re-reads. Re-run setData live,
                    // CHANGE-GATED on the (scaled) max HP cached per shown entity (one
                    // getStat read/frame at most), so mid-inspect party-size changes and
                    // element-mode transients self-correct on both host and member. Skip
                    // dead/mid-death entities — the box dies with the normal flow.
                    try {
                        const ent: any = focus && focus.entity;
                        if (box && box.active && ent && !ent._killed && !ent._mpDying
                            && typeof ent.enemyName === 'string' && ent.params
                            && typeof ent.params.getStat === 'function'
                            && box instanceof scAny.QUICK_INFO_BOXES.Enemy
                            && typeof box.setData === 'function') {
                            const maxHp = ent.params.getStat('hp');
                            if (typeof maxHp === 'number') {
                                if (box._mpInspectEntity !== ent) {
                                    box._mpInspectEntity = ent;
                                    box._mpInspectHp = maxHp;
                                    box.setData(ent.enemyName, ent);
                                } else if (box._mpInspectHp !== maxHp) {
                                    box._mpInspectHp = maxHp;
                                    box.setData(ent.enemyName, ent);
                                }
                            }
                        }
                    } catch (_) { /* ignore */ }
                } catch (_) { /* ignore */ }
            },
        });
    }

    // ----------------------------------- 1b. hover-sticky info boxes (all types)

    // Vanilla isMouseOver() KBM branch hides the focused box + unfocuses the
    // anchor the instant the cursor leaves the 16x16 anchor. That kills our
    // OnlinePlayer/PartyMember boxes before the cursor can reach the friend
    // button beside them. Replacement: byte-identical to the engine's KBM branch
    // except the box's own screen rect (box.hook.screenCoords, maintained only
    // when the box registered a mouse record) also counts as hovering, so the
    // box survives the trip from the anchor onto itself. Non-KBM devices and the
    // gate preconditions fall through to the engine.
    if (!_mpMouseOverInjected) {
        _mpMouseOverInjected = true;
        scAny.QuickMenuTypesBase.inject({
            isMouseOver(this: any) {
                // Same gate as the engine (isQuickCheck + not blocked + focusable +
                // device synced); on failure the engine also returns false.
                if (!scAny.quickmodel.isQuickCheck() || ig.interact.isBlocked() || !this.focusable
                    || !scAny.quickmodel.isDeviceSynced()) return false;
                // Gamepad / other devices keep the vanilla cursor-distance logic.
                if (ig.input.currentDevice !== ig.INPUT_DEVICES.KEYBOARD_AND_MOUSE) return this.parent();
                // --- KBM branch (mirrors the engine) + sticky overBox addition ---
                const mx = Math.floor((sc as any).control.getMouseX());
                const my = Math.floor((sc as any).control.getMouseY());
                const a = this.hook;
                const overAnchor = mx >= a.pos.x && mx <= a.pos.x + a.size.x
                    && my >= a.pos.y && my <= a.pos.y + a.size.y;
                // Round 14: plain box-rect containment left a 12-23px dead gap
                // between the 16x16 anchor and the animated box (box lands at
                // anchor+20/+30), so the else-branch below killed the box before
                // the cursor reached it. Use the keep-alive corridor (mpZoneHit),
                // which spans anchor + box and inflates by 8px. The analFocus
                // guard stops a neighbouring anchor's inflated zone from stealing
                // focus when anchors sit close together.
                let overBox = false;
                const box = this.screen && this.screen.boxes && this.screen.boxes[this.type];
                if (box && box.active && (scAny.quickmodel.analFocus == this || !scAny.quickmodel.analFocus)) {
                    overBox = mpZoneHit(this.screen, this.type, mx, my);
                }
                if (overAnchor || overBox) {
                    // Unfocus a DIFFERENT focused anchor first and hide its box.
                    if (scAny.quickmodel.analFocus && scAny.quickmodel.analFocus != this) {
                        scAny.quickmodel.unfocusEntity(scAny.quickmodel.analFocus);
                        this.screen.hide(this.type);
                    }
                    scAny.quickmodel.focusEntity(a.pos.x + Math.floor(a.size.x / 2), a.pos.y + Math.floor(a.size.y / 2), this);
                    this.screen.show(this.type, this);
                    return true;
                }
                // Engine else-branch: leave the analysis focus entirely.
                scAny.quickmodel.analFocus == this && this.screen.hide(this.type);
                scAny.quickmodel.unfocusEntity(this);
                return false;
            },
        });
    }

    // -------------------------------- 1c. keep-alive hide backstop (all types)

    // The engine's isMouseOver else-branch dismisses the box through
    // QuickFocusScreen.hide(type) while the cursor is still in the anchor↔box
    // gap; box.hide() sets box.active=false immediately, so the box can never
    // revive and the friend button becomes unreachable. Backstop: short-circuit
    // hide() while the cursor is inside the keep-alive corridor — but ONLY
    // while the quick menu is genuinely OPEN. Round 15: the exit path
    // (_exitMenu → QuickMenuAnalysis.hide → onAnalysisExit → screen.hide)
    // routes through this very method AFTER sc.model left the QUICK substate,
    // so without the isQuickMenu() gate the backstop swallowed the exit hide
    // and the inspected box stayed pinned until the next menu open
    // (sc.quickmodel.isQuickCheck() is still true during exit and CANNOT be
    // used as the gate). ESC-in-analysis hides still run while the menu is
    // open, so a hovered box can survive ESC — it always closes on final exit.
    if (!_mpHideBackstopInstalled) {
        _mpHideBackstopInstalled = true;
        if (scAny.QuickFocusScreen) {
            scAny.QuickFocusScreen.inject({
                hide(this: any, type: any) {
                    try {
                        const mdl = (sc as any).model;
                        const menuOpen = !!(mdl && typeof mdl.isQuickMenu === 'function' && mdl.isQuickMenu());
                        if (menuOpen) {
                            const mx = Math.floor((sc as any).control.getMouseX());
                            const my = Math.floor((sc as any).control.getMouseY());
                            if (mpZoneHit(this, type, mx, my)) return; // keep the box open while hovered
                        }
                    } catch (_) { /* ignore */ }
                    return this.parent(type);
                },
            });
        }
    }

    // -------------------------------- 2. online players as inspectable targets

    // Mirrors are Enemy-typed; give them their own quick-menu settings so the
    // QuickMenuAnalysis.show() loop (duck-typed on getQuickMenuSettings) picks
    // them up instead of the native Enemy/analyze path.
    if (ig.ENTITY && (ig.ENTITY as any).Enemy) {
        ((ig.ENTITY as any).Enemy as any).inject({
            getQuickMenuSettings(this: any) {
                if (this._mpMirror) return { type: 'OnlinePlayer', disabled: false };
                return this.parent();
            },
        });
    }

    /** Is `name` a confirmed friend? socialMenuInject keeps friends in
     * sc.party.contacts with status = FRIEND. */
    function isFriend(name: string): boolean {
        try {
            const c = scAny.party && scAny.party.contacts && scAny.party.contacts[name];
            return !!(c && c.status === CONTACT_FRIEND);
        } catch (_) { return false; }
    }

    /** ROUND 91: best-known LEVEL for an online player (profile first, injected
     * party model fallback). Used by the head-level plate, NOT by the info box. */
    function playerLevel(name: string): number | null {
        try {
            const m = getMain();
            const prof = m && m.playerProfiles ? m.playerProfiles[name] : undefined;
            if (prof && typeof prof.level === 'number') return prof.level;
            const mdl = scAny.party && scAny.party.models && scAny.party.models[name];
            if (mdl && mdl._mpName && typeof mdl.level === 'number') return mdl.level;
        } catch (_) { /* ignore */ }
        return null;
    }

    // Anchor type: green ring + username name tag (same pattern as the native
    // NPC type, which parents its QuickArrowBox into the focus screen).
    scAny.QUICK_MENU_TYPES.OnlinePlayer = scAny.QuickMenuTypesBase.extend({
        color: scAny.ANALYSIS_COLORS ? scAny.ANALYSIS_COLORS.GREEN : 2,
        nameGui: null,
        level: null,
        _mpLevel: -1,
        init(this: any, a: string, b: any, c: any) {
            this.parent(a, b, c);
            this.setIconColor(this.color);
            try {
                const name = (this.entity && this.entity.name) || '???';
                this.nameGui = new scAny.QuickArrowBox(name);
                this.nameGui.setPivot(this.nameGui.hook.size.x / 2, 0);
                this.nameGui.hook.transitions = {
                    DEFAULT: { state: {}, time: 0.1, timeFunction: KEY_SPLINES.EASE },
                    HIDDEN: { state: { alpha: 0, scaleX: 0.3, offsetY: 8 }, time: 0.2, timeFunction: KEY_SPLINES.LINEAR },
                };
                this.nameGui.doStateTransition('HIDDEN', true);
                this.screen.addSubGui(this.nameGui);
                // ROUND 91: level plate above the head, exactly like the enemy
                // anchor — but permanently WHITE (never orange/red by level gap).
                const lvl = playerLevel(name);
                if (lvl !== null && scAny.QuickBorderArrowLevelBox) {
                    this.level = new scAny.QuickBorderArrowLevelBox('__mp_player__', { level: { override: lvl } });
                    this.level.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_CENTER);
                    this.level.displayColor = scAny.GUI_NUMBER_COLOR ? scAny.GUI_NUMBER_COLOR.WHITE : 0;
                    try { this.level.levelNumber.setColor(scAny.GUI_NUMBER_COLOR.WHITE); } catch (_) { /* ignore */ }
                    this.level.getLevelColor = () => (scAny.GUI_NUMBER_COLOR ? scAny.GUI_NUMBER_COLOR.WHITE : 0);
                    this.addChildGui(this.level);
                    this._mpLevel = lvl;
                }
            } catch (e) { this.focusable = false; }
        },
        onAnalysisEnter(this: any) {
            if (this.nameGui) this.nameGui.setPosition(this.hook, this.entity);
            this.parent();
        },
        onAnalysisExit(this: any) {
            this.parent();
            if (this.nameGui) this.nameGui.doStateTransition('HIDDEN');
        },
        focusGained(this: any) { if (this.nameGui) this.nameGui.doStateTransition('DEFAULT'); },
        focusLost(this: any) { if (this.nameGui) this.nameGui.doStateTransition('HIDDEN'); },
        alignGuiPosition(this: any) {
            this.parent();
            if (this.nameGui) this.nameGui.setPosition(this.hook, this.entity);
            if (this.level && this.entity && this.entity.coll) {
                try {
                    const e = this.entity;
                    let off = e.coll.size.z / 2 + e.coll.size.y / 2;
                    off = e.dmgZFocus ? off - e.dmgZFocus
                        : (e.cameraZFocus ? off - (e.cameraZFocus + 48) : off - (e.coll.size.z + e.coll.size.y + 8));
                    // Keep the level plate ABOVE the QuickArrowBox name tag.
                    this.level.setPos(0, off - 12);
                    // Profile may land AFTER the quick menu opened — keep the plate live.
                    const lvl = playerLevel(e.name);
                    if (lvl !== null && lvl !== this._mpLevel) {
                        this._mpLevel = lvl;
                        try { this.level.levelNumber.setNumber(lvl); } catch (_) { /* ignore */ }
                    }
                } catch (_) { /* ignore */ }
            }
        },
    });

    // Info box: enemy-box layout — title, HP/ATK/DEF/FOC icon lines, element
    // resistances, then TWO independent action rows below:
    //   - friend row: 添加好友 for non-friends, 联系 for confirmed friends (opens
    //     the private chat channel — ROUND 93)
    //   - party row:  踢出队伍 (I am the leader), 退出队伍 (I am a member), or
    //     邀请组队 (friend, not in party, shared town)
    // ROUND 91: the level is NOT in the box — it lives on the head plate above
    // the anchor, always white (never orange/red by level difference).
    scAny.QUICK_INFO_BOXES.OnlinePlayer = (ig as any).BoxGui.extend({
        ninepatch: new (ig as any).NinePatch('media/gui/menu.png', {
            width: 8, height: 8, left: 8, top: 8, right: 8, bottom: 8,
            offsets: { 'default': { x: 432, y: 304 }, flipped: { x: 456, y: 304 } },
        }),
        transitions: {
            HIDDEN: { state: { alpha: 0 }, time: 0.2, timeFunction: KEY_SPLINES.LINEAR },
            DEFAULT: { state: {}, time: 0.2, timeFunction: KEY_SPLINES.EASE },
        },
        title: null,
        baseHp: null,
        baseAttack: null,
        baseDefense: null,
        baseFocus: null,
        resistance: null,
        friendBtn: null,
        partyBtn: null,
        active: false,
        _mpUsername: '',
        _mpFriendAction: '',
        _mpPartyAction: '',
        init(this: any) {
            this.parent(127, 184);
            // Mouse record: keeps box.hook.screenCoords fresh every frame so the
            // sticky isMouseOver (section 1b) treats hovering THIS box as hovering
            // the anchor — without it the box dies as soon as the cursor leaves the
            // 16x16 anchor and the action buttons would be unreachable.
            try { this.hook.setMouseRecord(true); } catch (_) { /* ignore */ }
            this.title = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.title.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.title.setPos(0, 2);
            this.addChildGui(this.title);
            let y = 21;
            this.baseHp = this.createStatusLine('maxhp', 0, 4, y); y += 14;
            this.baseAttack = this.createStatusLine('atk', 1, 4, y); y += 14;
            this.baseDefense = this.createStatusLine('def', 2, 4, y); y += 14;
            this.baseFocus = this.createStatusLine('foc', 3, 4, y); y += 18;
            this.resistance = new scAny.EnemyResistence();
            this.resistance.setPos(4, y);
            this.addChildGui(this.resistance);
            this.friendBtn = new sc.ButtonGui(t('addFriend'), 100, true, sc.BUTTON_TYPE.SMALL);
            this.friendBtn.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.friendBtn.setPos(0, 136);
            this.friendBtn.onButtonPress = () => this._mpFriendPress();
            this.addChildGui(this.friendBtn);
            this.partyBtn = new sc.ButtonGui(t('inviteParty'), 100, true, sc.BUTTON_TYPE.SMALL);
            this.partyBtn.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.partyBtn.setPos(0, 158);
            this.partyBtn.onButtonPress = () => this._mpPartyPress();
            this.addChildGui(this.partyBtn);
            this.doStateTransition('HIDDEN', true);
        },
        createStatusLine(this: any, key: string, icon: number, x: number, y: number) {
            const line = new scAny.EnemyBaseParamLine(ig.lang.get('sc.gui.menu.equip.' + key), icon);
            line.setPos(x, y);
            this.addChildGui(line);
            return line;
        },
        updateDrawables(this: any, a: any) {
            this.parent(a);
            a.addColor('#CCCCCC', 3, this.title.hook.size.y + 1, 121, 1);
        },
        // The engine's showFocusBox calls boxes[type].show(anchor) and show()
        // expects alignToBase() to exist (the vanilla Enemy box has it; a bare
        // BoxGui does not — that crashed the SHIFT menu in round 11). Mirror the
        // vanilla placement: right of the anchor, clamped to screen, flipped to
        // the left near the right edge. No arrow child here, so skip that part.
        alignToBase(this: any, a: any) {
            try {
                const d = this.hook;
                const snap = d.currentState && d.currentState.alpha === 0;
                const ax = a.pos.x + Math.floor(a.size.x / 2);
                const rawY = a.pos.y + Math.floor(a.size.y / 2) - 82;
                const cy = Math.max(10, Math.min((ig as any).system.height - 200, rawY));
                const w = (d.size && d.size.x) || 127;
                if (ax + w + 60 < (ig as any).system.width) {
                    this.currentTileOffset = 'default';
                    if (snap) { d.pos.x = ax + 30; d.pos.y = cy; }
                    if (typeof d.doPosTranstition === 'function') d.doPosTranstition(ax + 20, cy, 0.2, (KEY_SPLINES as any).EASE);
                } else {
                    this.currentTileOffset = 'flipped';
                    if (snap) { d.pos.x = ax - w - 31; d.pos.y = cy; }
                    if (typeof d.doPosTranstition === 'function') d.doPosTranstition(ax - w - 21, cy, 0.2, (KEY_SPLINES as any).EASE);
                }
            } catch (_) { /* ignore */ }
        },
        show(this: any, anchor: any) {
            this.alignToBase(anchor.hook);
            this.setData(anchor.entity);
            this.doStateTransition('DEFAULT');
            this.active = true;
            // The action buttons are BoxGui children, so they have no buttonGroup
            // and would never be hovered/clicked. Register both as global buttons on
            // the quick menu's ButtonInteractEntry while shown; the checks return
            // false so keyboard/hotkey never fires them — mouse-only, exactly like
            // the Social menu's 加好友 chip. clearAllButtons() is the safety net;
            // hide() removes them eagerly.
            try {
                const bi = scAny.quickmodel && scAny.quickmodel.buttonInteract;
                if (bi && bi.globalButtons) {
                    for (const btn of [this.friendBtn, this.partyBtn]) {
                        if (btn && bi.globalButtons.indexOf(btn) === -1) bi.addGlobalButton(btn, () => false, false);
                    }
                }
            } catch (_) { /* ignore */ }
        },
        hide(this: any, instant?: boolean) {
            try {
                const bi = scAny.quickmodel && scAny.quickmodel.buttonInteract;
                if (bi && bi.removeGlobalButton) {
                    for (const btn of [this.friendBtn, this.partyBtn]) {
                        if (btn) bi.removeGlobalButton(btn);
                    }
                }
            } catch (_) { /* ignore */ }
            this.doStateTransition('HIDDEN', instant);
            this.active = false;
        },
        setData(this: any, entity: any) {
            try {
                const username = (entity && entity.name) || '???';
                this._mpUsername = username;
                this.title.setFont(sc.fontsystem.smallFont);
                this.title.setText(username);
                const m = getMain();
                const prof = m && m.playerProfiles ? m.playerProfiles[username] : undefined;
                const stat = (v: any) => (typeof v === 'number' && isFinite(v) ? Math.round(v) : 0);
                this.baseHp.setNumber(stat(prof && prof.hp), true);
                this.baseAttack.setNumber(stat(prof && prof.attack), true);
                this.baseDefense.setNumber(stat(prof && prof.defense), true);
                this.baseFocus.setNumber(stat(prof && prof.focus), true);
                this.resistance.setResistance(prof && Array.isArray(prof.elemFactor) ? prof.elemFactor : null, true);

                const inParty = !!(m && Array.isArray(m.partyMembers) && m.partyMembers.indexOf(username) !== -1);
                const isLeader = !!(m && m.partyLeader && m.name && m.partyLeader === m.name);
                const friend = isFriend(username);
                // Friend row (ROUND 93): non-friends get 加好友; CONFIRMED friends get
                // 联系, which opens the private chat channel with that player.
                const friendAction = friend ? 'contact' : 'friend';
                this._mpFriendAction = friendAction;
                this.friendBtn.setText(friendAction === 'contact' ? t('optContact') : t('addFriend'), true);
                try { this.friendBtn.hook._visible = true; } catch (_) { /* ignore */ }
                // Party row: kick when I lead this party, leave when I'm just a
                // member inspecting another member, and INVITE for every other
                // online player — friend or not (ROUND 92).
                let partyAction = '';
                let partyLabel = '';
                if (inParty) {
                    partyAction = isLeader ? 'kick' : 'leave';
                    partyLabel = isLeader ? t('kickParty') : t('leaveParty');
                } else {
                    partyAction = 'invite';
                    partyLabel = t('inviteParty');
                }
                this._mpPartyAction = partyAction;
                this.partyBtn.setText(partyLabel, true);
                try { this.partyBtn.hook._visible = !!partyAction; } catch (_) { /* ignore */ }
            } catch (_) { /* ignore */ }
        },
        _mpFriendPress(this: any) {
            try {
                const m = getMain();
                if (!m || !m.connection || !m.connection.isOpen() || !this._mpUsername) return;
                if (this._mpFriendAction === 'contact') {
                    // 联系: leave the quick-menu SUB-STATE the same way a native item
                    // use does (sc.model.enterRunning) — QuickMenu only reacts to the
                    // game-model sub-state change, and calling quickmodel.exitQuickMenu
                    // directly left the analysis window visible/stuck on screen.
                    try {
                        const mdl = scAny.model;
                        if (mdl && typeof mdl.enterRunning === 'function') mdl.enterRunning();
                    } catch (_) { /* ignore */ }
                    openPrivateChannel(this._mpUsername, true);
                    console.log('[multiplayer] quick-menu: opening private chat with ' + this._mpUsername);
                    return;
                }
                if (this._mpFriendAction !== 'friend') return;
                m.connection.friendAdd(this._mpUsername);
                this.friendBtn.setText(t('friendReqSent'), true);
                console.log('[multiplayer] quick-menu: friend request sent to ' + this._mpUsername);
            } catch (_) { /* ignore */ }
        },
        _mpPartyPress(this: any) {
            try {
                const m = getMain();
                if (!m || !m.connection || !m.connection.isOpen() || !this._mpUsername || !this._mpPartyAction) return;
                if (this._mpPartyAction === 'kick') {
                    m.connection.partyKick(this._mpUsername);
                    console.log('[multiplayer] quick-menu: kicked ' + this._mpUsername);
                } else if (this._mpPartyAction === 'leave') {
                    m.connection.partyLeave();
                    console.log('[multiplayer] quick-menu: left the party');
                } else if (this._mpPartyAction === 'invite') {
                    m.connection.partyInvite(this._mpUsername);
                    this.partyBtn.setText(t('partyInviteSent'), true);
                    console.log('[multiplayer] quick-menu: party invite sent to ' + this._mpUsername);
                }
            } catch (_) { /* ignore */ }
        },
    });

    // ---------------------------- 3. party follower bots as inspectable targets

    // Bots are sc.PartyMemberEntity (extends sc.PlayerBaseEntity) with no
    // getQuickMenuSettings anywhere on the chain, so the SHIFT scan skipped them.
    // Give them a 'PartyMember' type so they get an anchor + stats box. Same
    // gating as the OnlinePlayer registration: only when the class exists.
    if (scAny.PartyMemberEntity) {
        scAny.PartyMemberEntity.inject({
            getQuickMenuSettings(this: any) {
                // No base definition exists (that's why bots were skipped); call
                // this.parent if a later mod ever adds one. Disable while the model
                // isn't up yet so we never anchor a half-built bot.
                if (typeof this.parent === 'function') return this.parent();
                return { type: 'PartyMember', disabled: !this.model };
            },
        });
    }

    // Anchor type: same pattern as OnlinePlayer (green ring + name tag), but the
    // display name comes from the PartyMemberModel — entity.name is empty for
    // follower bots, which spawn with only a partyMemberName setting.
    scAny.QUICK_MENU_TYPES.PartyMember = scAny.QuickMenuTypesBase.extend({
        color: scAny.ANALYSIS_COLORS ? scAny.ANALYSIS_COLORS.GREEN : 2,
        nameGui: null,
        init(this: any, a: string, b: any, c: any) {
            this.parent(a, b, c);
            this.setIconColor(this.color);
            try {
                const mdl = this.entity && this.entity.model;
                // getCharacterName() is the display name: the account name for an
                // injected mod-bot model, the localized character name for a native
                // bot; model.name is the raw config name fallback.
                const name = (mdl && (typeof mdl.getCharacterName === 'function' ? mdl.getCharacterName() : mdl.name)) || '???';
                this.nameGui = new scAny.QuickArrowBox(name);
                this.nameGui.setPivot(this.nameGui.hook.size.x / 2, 0);
                this.nameGui.hook.transitions = {
                    DEFAULT: { state: {}, time: 0.1, timeFunction: KEY_SPLINES.EASE },
                    HIDDEN: { state: { alpha: 0, scaleX: 0.3, offsetY: 8 }, time: 0.2, timeFunction: KEY_SPLINES.LINEAR },
                };
                this.nameGui.doStateTransition('HIDDEN', true);
                this.screen.addSubGui(this.nameGui);
            } catch (e) { this.focusable = false; }
        },
        onAnalysisEnter(this: any) {
            if (this.nameGui) this.nameGui.setPosition(this.hook, this.entity);
            this.parent();
        },
        onAnalysisExit(this: any) {
            this.parent();
            if (this.nameGui) this.nameGui.doStateTransition('HIDDEN');
        },
        focusGained(this: any) { if (this.nameGui) this.nameGui.doStateTransition('DEFAULT'); },
        focusLost(this: any) { if (this.nameGui) this.nameGui.doStateTransition('HIDDEN'); },
        alignGuiPosition(this: any) {
            this.parent();
            if (this.nameGui) this.nameGui.setPosition(this.hook, this.entity);
        },
    });

	// Stats box: MONSTER-STYLE hover box (the native sc.QUICK_INFO_BOXES.Enemy
	// layout) driven by the bot's PartyMemberModel.params instead of an
	// enemyDataList entry — title, HP/ATK/DEF/FOC lines, the four elemental
	// resistances and the pointer arrow match the enemy inspection look.
	// setData ignores the enemyName argument and reads model.params live.
	scAny.QUICK_INFO_BOXES.PartyMember = scAny.QUICK_INFO_BOXES.Enemy.extend({
		setData(this: any, _enemyName: string, entity: any) {
			const ent = entity || (this.anchor && this.anchor.entity);
			const mdl = ent && ent.model;
			const name = mdl && (typeof mdl.getCharacterName === 'function'
				? mdl.getCharacterName()
				: (mdl.name || ent.name)) || '???';
			this.title.setFont(sc.fontsystem.smallFont);
			this.title.setText(name);
			if (this.title.hook.size.x >= 121) {
				this.title.setFont(sc.fontsystem.tinyFont);
				this.title.setPos(0, 6);
				this.tiny = true;
			} else {
				this.tiny = false;
				this.title.setPos(0, 2);
			}
			// No enemy-data record for a follower bot -> stats are visible, never
			// scrambled, and always read from the live model params.
			try { if (this.resistance && typeof this.resistance.hide === 'function') this.resistance.hide(); } catch (_) { /* ignore */ }
			const params = mdl && mdl.params;
			const stat = (key: string) => {
				try { return params && typeof params.getStat === 'function' ? params.getStat(key) : null; } catch (_) { return null; }
			};
			const num = (v: any, fallback: number) => (typeof v === 'number' && isFinite(v) ? v : fallback);
			try {
				this.baseHp.number.scramble = false;
				this.baseAttack.number.scramble = false;
				this.baseDefense.number.scramble = false;
				this.baseFocus.number.scramble = false;
				this.baseHp.setNumber(num(stat('hp'), 9999), true);
				this.baseAttack.setNumber(num(stat('attack'), 999), true);
				this.baseDefense.setNumber(num(stat('defense'), 999), true);
				this.baseFocus.setNumber(num(stat('focus'), 999), true);
				const factor = stat('elemFactor');
				this.resistance.setResistance(Array.isArray(factor) && factor.length >= 4
					? factor.slice(0, 4)
					: [1, 1, 1, 1], true);
			} catch (_) { /* ignore */ }
		},
		show(this: any, anchor: any) {
			this.anchor = anchor;
			this.parent(anchor);
		},
	});

    console.log('[multiplayer] quick-menu enhancements installed (anchor follow + hover-sticky boxes + online-player + party-bot inspect)');
}
