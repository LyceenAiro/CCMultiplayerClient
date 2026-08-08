import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';

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
 *     'PartyMember' type: a green anchor with the bot's display name plus an
 *     info box showing name / 等级 / 经验 / HP.
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

    // Anchor type: green ring + username name tag (same pattern as the native
    // NPC type, which parents its QuickArrowBox into the focus screen).
    scAny.QUICK_MENU_TYPES.OnlinePlayer = scAny.QuickMenuTypesBase.extend({
        color: scAny.ANALYSIS_COLORS ? scAny.ANALYSIS_COLORS.GREEN : 2,
        nameGui: null,
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

    // Info box: username title, real level from the profile stream, and an
    // add/remove-friend button. Structure mirrors QUICK_INFO_BOXES.Enemy.
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
        levelLine: null,
        friendBtn: null,
        active: false,
        _mpUsername: '',
        _mpIsFriend: false,
        init(this: any) {
            this.parent(127, 86);
            // Mouse record: keeps box.hook.screenCoords fresh every frame so the
            // sticky isMouseOver (section 1b) treats hovering THIS box as hovering
            // the anchor — without it the box dies as soon as the cursor leaves the
            // 16x16 anchor and the friend button would be unreachable.
            try { this.hook.setMouseRecord(true); } catch (_) { /* ignore */ }
            this.title = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.title.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.title.setPos(0, 2);
            this.addChildGui(this.title);
            this.levelLine = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.levelLine.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.levelLine.setPos(0, 22);
            this.addChildGui(this.levelLine);
            this.friendBtn = new sc.ButtonGui(t('addFriend'), 100, true, sc.BUTTON_TYPE.SMALL);
            this.friendBtn.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.friendBtn.setPos(0, 50);
            this.friendBtn.onButtonPress = () => this._mpFriendPress();
            this.addChildGui(this.friendBtn);
            this.doStateTransition('HIDDEN', true);
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
                const rawY = a.pos.y + Math.floor(a.size.y / 2) - 46;
                const cy = Math.max(10, Math.min((ig as any).system.height - 150, rawY));
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
            // The friend button is a BoxGui child, so it has no buttonGroup and was
            // never hovered/clicked (FocusGui.onMouseInteract needs a buttonInteract
            // to route through). Register it as a global button on the quick menu's
            // ButtonInteractEntry while shown: the mouse path (setMouseOverGui +
            // getGuiClick in buttonInteract.update) then works. The check returns
            // false so the keyboard/hotkey loop never fires it — mouse-only, exactly
            // like the Social menu's 加好友 chip. clearAllButtons() on menu exit is
            // the safety net; hide() removes it eagerly.
            try {
                const bi = scAny.quickmodel && scAny.quickmodel.buttonInteract;
                if (bi && bi.globalButtons && this.friendBtn && bi.globalButtons.indexOf(this.friendBtn) === -1) {
                    bi.addGlobalButton(this.friendBtn, () => false, false);
                }
            } catch (_) { /* ignore */ }
        },
        hide(this: any, instant?: boolean) {
            // Deregister the global button so it can't keep firing / leaking focus
            // once the box is hidden (the quick menu's clearAllButtons() would also
            // catch it, but this runs even when the menu teardown path differs).
            try {
                const bi = scAny.quickmodel && scAny.quickmodel.buttonInteract;
                if (bi && bi.removeGlobalButton && this.friendBtn) bi.removeGlobalButton(this.friendBtn);
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
                // Profile wins when present; fall back to the injected party model
                // (stamped _mpName only — never a native single-party character) so
                // the line shows a real number even before the profile stream lands.
                let level: any = prof && typeof prof.level === 'number' ? prof.level : null;
                if (level === null) {
                    try {
                        const mdl = scAny.party && scAny.party.models && scAny.party.models[username];
                        if (mdl && mdl._mpName && typeof mdl.level === 'number') level = mdl.level;
                    } catch (_) { /* ignore */ }
                }
                this.levelLine.setText(t('levelLabel') + (level === null ? '?' : String(level)));
                this._mpIsFriend = isFriend(username);
                this.friendBtn.setText(this._mpIsFriend ? t('removeFriend') : t('addFriend'), true);
            } catch (_) { /* ignore */ }
        },
        _mpFriendPress(this: any) {
            try {
                const m = getMain();
                if (!m || !m.connection || !m.connection.isOpen() || !this._mpUsername) return;
                if (this._mpIsFriend) {
                    m.connection.friendRemove(this._mpUsername);
                    this._mpIsFriend = false;
                    this.friendBtn.setText(t('addFriend'), true);
                    console.log('[multiplayer] quick-menu: removed friend ' + this._mpUsername);
                } else {
                    // friendAdd sends a REQUEST (mutual only after the target accepts,
                    // or instantly if they had already requested us) — reflect that.
                    m.connection.friendAdd(this._mpUsername);
                    this.friendBtn.setText(t('friendReqSent'), true);
                    console.log('[multiplayer] quick-menu: friend request sent to ' + this._mpUsername);
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

    // Stats box: bot name + 等级 / 经验 / HP lines, mirroring the OnlinePlayer box
    // layout. setMouseRecord(true) so the sticky isMouseOver (section 1b) keeps it
    // alive while the cursor reads the stats.
    scAny.QUICK_INFO_BOXES.PartyMember = (ig as any).BoxGui.extend({
        ninepatch: new (ig as any).NinePatch('media/gui/menu.png', {
            width: 8, height: 8, left: 8, top: 8, right: 8, bottom: 8,
            offsets: { 'default': { x: 432, y: 304 }, flipped: { x: 456, y: 304 } },
        }),
        transitions: {
            HIDDEN: { state: { alpha: 0 }, time: 0.2, timeFunction: KEY_SPLINES.LINEAR },
            DEFAULT: { state: {}, time: 0.2, timeFunction: KEY_SPLINES.EASE },
        },
        title: null,
        levelLine: null,
        expLine: null,
        hpLine: null,
        active: false,
        init(this: any) {
            this.parent(127, 86);
            try { this.hook.setMouseRecord(true); } catch (_) { /* ignore */ }
            this.title = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.title.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.title.setPos(0, 2);
            this.addChildGui(this.title);
            this.levelLine = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.levelLine.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.levelLine.setPos(0, 20);
            this.addChildGui(this.levelLine);
            this.expLine = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.expLine.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.expLine.setPos(0, 36);
            this.addChildGui(this.expLine);
            this.hpLine = new sc.TextGui('', { font: sc.fontsystem.smallFont });
            this.hpLine.setAlign(ig.GUI_ALIGN.X_CENTER, ig.GUI_ALIGN.Y_TOP);
            this.hpLine.setPos(0, 52);
            this.addChildGui(this.hpLine);
            this.doStateTransition('HIDDEN', true);
        },
        updateDrawables(this: any, a: any) {
            this.parent(a);
            a.addColor('#CCCCCC', 3, this.title.hook.size.y + 1, 121, 1);
        },
        // Same placement as the OnlinePlayer box: right of the anchor, clamped to
        // the screen, flipped to the left near the right edge.
        alignToBase(this: any, a: any) {
            try {
                const d = this.hook;
                const snap = d.currentState && d.currentState.alpha === 0;
                const ax = a.pos.x + Math.floor(a.size.x / 2);
                const rawY = a.pos.y + Math.floor(a.size.y / 2) - 46;
                const cy = Math.max(10, Math.min((ig as any).system.height - 150, rawY));
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
        },
        hide(this: any, instant?: boolean) {
            this.doStateTransition('HIDDEN', instant);
            this.active = false;
        },
        setData(this: any, entity: any) {
            try {
                const mdl = entity && entity.model;
                const name = mdl && (typeof mdl.getCharacterName === 'function' ? mdl.getCharacterName() : mdl.name);
                this.title.setFont(sc.fontsystem.smallFont);
                this.title.setText(name || '???');
                const lvl = mdl && typeof mdl.level === 'number' ? String(mdl.level) : '?';
                this.levelLine.setText(t('levelLabel') + lvl);
                const exp = mdl && typeof mdl.exp === 'number' ? String(mdl.exp) : '?';
                this.expLine.setText(t('expLabel') + exp);
                const cur = mdl && mdl.params ? mdl.params.currentHp : null;
                let max: any = null;
                if (mdl && mdl.params && typeof mdl.params.getStat === 'function') {
                    try { max = mdl.params.getStat('hp'); } catch (_) { max = null; }
                }
                this.hpLine.setText(t('hpLabel') + (cur == null ? '?' : cur) + ' / ' + (max == null ? '?' : max));
            } catch (_) { /* ignore */ }
        },
    });

    console.log('[multiplayer] quick-menu enhancements installed (anchor follow + hover-sticky boxes + online-player + party-bot inspect)');
}
