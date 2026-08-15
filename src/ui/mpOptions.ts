import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';
import { isSharedTownNow } from '../util/areaUtil';

/**
 * Round 12 — mod-dedicated OPTIONS tab + persistent player name tags.
 *
 *  1. Adds a "多人" (Multiplayer) tab to the game's Options menu (sc.OptionsTabBox).
 *     It hosts mod-specific settings that have NO native equivalent, so we own the
 *     rows entirely instead of fighting sc.OPTIONS_DEFINITION / sc.OptionModel
 *     (whose values are seeded at startup, before this mod loads, and whose lang
 *     keys we don't control). Persistence is a tiny JSON blob in localStorage.
 *
 *  2. "显示玩家名称" (show player names) — when on, every remote player's mirror
 *     gets a small name tag floating above its head during gameplay. Tags track the
 *     mirror each frame via ig.system.getScreenFromMapPos (the same projection the
 *     native quick-menu anchors use) and are hidden while any menu is open.
 *
 * Round 13 — more tag options:
 *   - showOwnName  : also tag the local player (ig.game.playerEntity, account name).
 *   - showBotNames : also tag follower bots (sc.party.partyEntities).
 *   - leaderGold   : render the party leader's tag text in the engine's gold
 *                    (#FFE430 — the \c[n] color-set command; see makeTag).
 *   - tagAlpha     : backing opacity from 0% / 25% / 50% / 75% / 100% (was 0.55).
 *   - tagSize      : tag font 小/中/大 (tinyFont / smallFont / main bold font).
 *   Choice rows use a value readout + two arrow buttons (buildChoiceRow). Every
 *   row change rebuilds all tags next frame via resetAllTags().
 */

const LS_KEY = 'cc-mp-options';
// Sentinel category id for our tab. Native OPTION_CATEGORY uses 0..7 (ARENA); we
// register ours into sc.OPTION_CATEGORY as well so lookups never throw.
const MP_OPTION_CATEGORY = 999;

interface IMpOptions {
    /** Show a name tag above every online player's head during play. */
    showNameTags: boolean;
    /** Also tag the local player (ig.game.playerEntity) with the account name. */
    showOwnName: boolean;
    /** Also tag native/mod follower bots (sc.party.partyEntities). */
    showBotNames: boolean;
    /** Render the party leader's tag text in gold. */
    leaderGold: boolean;
    /** Round 16: show the local client's latency (ms) on the own name tag. */
    showPing: boolean;
    /** Round 21: host enemy-block tick rate (15/30/60 Hz). Latched at the next
     * host-acquire (becoming the map host), never read live. */
    hostTickRate: number;
    /** Round 23: own playerState send rate (10/20/30/60 Hz). HOT-APPLIED — netSync
     * reads it live every tick (getPlayerStateMs), so a change takes effect on the
     * next packet with no latch/rejoin. */
    playerStateRate: number;
    /** Round 21: show the bottom-right network debug overlay (up/down bits per
     * second + packet loss %). Read live by the HUD pump. */
    showNetDebug: boolean;
    /** Round 21: extend the network debug overlay with cumulative up/down totals. */
    showNetDebugCumulative: boolean;
    /** ROUND 76 (advanced network tool): show the full per-event network-usage panel
     * (upload/download rate + count + cumulative bytes for every sync type). Read
     * live by the same 1s HUD pump; hidden while any menu is open. */
    showNetTool: boolean;
    /** Name-tag backing opacity: one of 0 / 0.25 / 0.5 / 0.75 / 1. */
    tagAlpha: number;
    /** Name-tag font key: 'tiny' | 'small' | 'font' (ascending sizes). */
    tagSize: string;
    /** Round 24: show the save-success toast when the server confirms an upload
     * (read live at save time in multiplayer.ts — no latch/rebuild needed). */
    showSaveToast: boolean;
}

const DEFAULTS: IMpOptions = {
    showNameTags: true,
    showOwnName: false,
    showBotNames: true,
    leaderGold: true,
    showPing: false,
    hostTickRate: 30,
    playerStateRate: 10,
    showNetDebug: false,
    showNetDebugCumulative: false,
    showNetTool: false,
    tagAlpha: 0.5,
    tagSize: 'tiny',
    showSaveToast: true,
};

let cached: IMpOptions | null = null;

function loadOptions(): IMpOptions {
    if (cached) return cached;
    const out: IMpOptions = {
        showNameTags: DEFAULTS.showNameTags,
        showOwnName: DEFAULTS.showOwnName,
        showBotNames: DEFAULTS.showBotNames,
        leaderGold: DEFAULTS.leaderGold,
        showPing: DEFAULTS.showPing,
        hostTickRate: DEFAULTS.hostTickRate,
        playerStateRate: DEFAULTS.playerStateRate,
        showNetDebug: DEFAULTS.showNetDebug,
        showNetDebugCumulative: DEFAULTS.showNetDebugCumulative,
        showNetTool: DEFAULTS.showNetTool,
        tagAlpha: DEFAULTS.tagAlpha,
        tagSize: DEFAULTS.tagSize,
        showSaveToast: DEFAULTS.showSaveToast,
    };
    try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                if (typeof parsed.showNameTags === 'boolean') out.showNameTags = parsed.showNameTags;
                // New round-13 keys parse with backward-compatible defaults when absent.
                if (typeof parsed.showOwnName === 'boolean') out.showOwnName = parsed.showOwnName;
                if (typeof parsed.showBotNames === 'boolean') out.showBotNames = parsed.showBotNames;
                if (typeof parsed.leaderGold === 'boolean') out.leaderGold = parsed.leaderGold;
                // Round-16 key: absent on older saves -> default (off).
                if (typeof parsed.showPing === 'boolean') out.showPing = parsed.showPing;
                // Round-21 key: allowlist 15/30/60 Hz only; anything else -> default 30.
                if (parsed.hostTickRate === 15 || parsed.hostTickRate === 30 || parsed.hostTickRate === 60) out.hostTickRate = parsed.hostTickRate;
                // Round-23 key: allowlist 10/20/30/60 Hz only; anything else -> default 10.
                if ([10, 20, 30, 60].indexOf(parsed.playerStateRate) !== -1) out.playerStateRate = parsed.playerStateRate;
                if (typeof parsed.showNetDebug === 'boolean') out.showNetDebug = parsed.showNetDebug;
                if (typeof parsed.showNetDebugCumulative === 'boolean') out.showNetDebugCumulative = parsed.showNetDebugCumulative;
                // Round 76: absent on older saves -> default (off).
                if (typeof parsed.showNetTool === 'boolean') out.showNetTool = parsed.showNetTool;
                if (typeof parsed.tagAlpha === 'number' && [0, 0.25, 0.5, 0.75, 1].indexOf(parsed.tagAlpha) !== -1) out.tagAlpha = parsed.tagAlpha;
                if (typeof parsed.tagSize === 'string' && ['tiny', 'small', 'font'].indexOf(parsed.tagSize) !== -1) out.tagSize = parsed.tagSize;
                // Round-24 key: absent on older saves -> default (on).
                if (typeof parsed.showSaveToast === 'boolean') out.showSaveToast = parsed.showSaveToast;
            }
        }
    } catch (_) { /* localStorage unavailable -> defaults */ }
    cached = out;
    return out;
}

function saveOptions(): void {
    try { window.localStorage.setItem(LS_KEY, JSON.stringify(loadOptions())); } catch (_) { /* ignore */ }
}

export function getMpOption<K extends keyof IMpOptions>(key: K): IMpOptions[K] {
    return loadOptions()[key];
}

export function setMpOption<K extends keyof IMpOptions>(key: K, value: IMpOptions[K]): void {
    loadOptions()[key] = value;
    saveOptions();
}

/** One row in the mod tab: a label + a native CheckboxGui toggle. Modeled on
 * sc.OptionRow + the native CHECKBOX option gui, but self-contained. */
function buildToggleRow(rowIdx: number, rowGroup: any, label: string, description: string, key: keyof IMpOptions, onApplied: () => void): any {
    const RowCtor = (ig as any).GuiElementBase.extend({
        row: -1,
        nameGui: null,
        button: null,
        _rowGroup: null,
        init(this: any) {
            this.parent();
            this.setSize(431, 26);
            this.row = rowIdx;
            this.nameGui = new (sc as any).TextGui(label);
            this.nameGui.setPos(5, 4);
            this.addChildGui(this.nameGui);
            // Divider under the label (matches native OptionRow).
            const divider = new (ig as any).ColorGui('#545454', 166, 1);
            divider.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_BOTTOM);
            divider.setPos(0, 4);
            this.addChildGui(divider);
            const corner = new (ig as any).ImageGui(((sc as any).OptionRow && (sc as any).OptionRow.prototype.gfx) || null, 32, 416, 8, 8);
            try {
                corner.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_BOTTOM);
                corner.setPos(166, 3);
                this.addChildGui(corner);
            } catch (_) { /* gfx optional */ }
            // Checkbox on the right half (native OptionRow places its type gui at x=175).
            this.button = new (sc as any).CheckboxGui(!!getMpOption(key), 30);
            this.button.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_CENTER);
            this.button.setPos(175, 0);
            this.button.data = { description: description, row: this.row };
            this.addChildGui(this.button);
            rowGroup.addFocusGui(this.button, 0, this.row);
            // Row's own group handle for the hover-info check (native OptionRow does
            // the same: this._rowGroup.isActive()).
            this._rowGroup = rowGroup;
            try { this.hook.setMouseRecord(true); } catch (_) { /* ignore */ }
        },
        onPressed(this: any, a: any) {
            if (a === this.button) {
                setMpOption(key, !!a.pressed);
                onApplied();
            }
        },
        onLeftRight(this: any, dir: boolean) {
            // Toggles ignore the direction and just flip (same as before).
            this.button.setPressed(!this.button.pressed);
            setMpOption(key, !!this.button.pressed);
            onApplied();
            return true;
        },
        onMouseInteract(this: any) {
            // Mirror native OptionRow hover -> info text.
            try {
                if ((sc as any).menu && (sc as any).menu.buttonInteract && (sc as any).menu.buttonInteract.isActive() && this._rowGroup && this._rowGroup.isActive()) {
                    const b = this.hook.screenCoords;
                    const mx = (sc as any).control.getMouseX();
                    const my = (sc as any).control.getMouseY();
                    if (b.x <= mx && b.x + b.w > mx && b.y <= my && b.y + b.h > my) (sc as any).menu.setInfoText(description);
                }
            } catch (_) { /* ignore */ }
        },
    });
    return new RowCtor();
}

/** Backing-opacity choices (replaces the old hardcoded 0.55 backing). */
const TAG_ALPHA_VALUES = [0, 0.25, 0.5, 0.75, 1];
const TAG_ALPHA_LABELS = ['0%', '25%', '50%', '75%', '100%'];
/** Tag font choices mapped to real sc.fontsystem fonts (7/13/16px, ascending). */
const TAG_SIZE_KEYS = ['tiny', 'small', 'font'];
const TAG_SIZE_LABELS = [t('sizeSmall'), t('sizeMedium'), t('sizeLarge')];
/** Round 21: host enemy-block tick-rate choices (15/30/60 Hz). Display labels are
 * plain ASCII (`30 tick`) — the rate is a number the label names directly. */
const HOST_TICK_VALUES = [15, 30, 60];
const HOST_TICK_LABELS = ['15 tick', '30 tick', '60 tick'];
/** Round 23: own playerState send-rate choices (10/20/30/60 Hz). Plain ASCII labels
 * like the host tick rate. Hot-applies: netSync reads the option live every tick. */
const PLAYER_STATE_RATES = [10, 20, 30, 60];
const PLAYER_STATE_LABELS = ['10 Hz', '20 Hz', '30 Hz', '60 Hz'];

/** A choice row for the mod tab: a label + a value readout flanked by two small
 * arrow buttons, modeled on buildToggleRow + the native OBJECT_SLIDER option gui.
 * One focus cell per row (rowGroup column 0) carries data = {description, row};
 * keyboard left/right and mouse clicks cycle the choice via the row's onLeftRight
 * / onPressed, and hovering shows the description exactly like the toggle rows. */
function buildChoiceRow(rowIdx: number, rowGroup: any, label: string, description: string, key: keyof IMpOptions, choices: string[], values: any[], onApplied: () => void): any {
    const RowCtor = (ig as any).GuiElementBase.extend({
        row: -1,
        nameGui: null,
        valueGui: null,
        leftBtn: null,
        rightBtn: null,
        focus: null,
        _key: null,
        _choices: null,
        _values: null,
        _onApplied: null,
        init(this: any) {
            this.parent();
            this.setSize(431, 26);
            this.row = rowIdx;
            this._key = key;
            this._choices = choices;
            this._values = values;
            this._onApplied = onApplied;
            this.nameGui = new (sc as any).TextGui(label);
            this.nameGui.setPos(5, 4);
            this.addChildGui(this.nameGui);
            // Divider + corner (same as the toggle rows / native OptionRow).
            const divider = new (ig as any).ColorGui('#545454', 166, 1);
            divider.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_BOTTOM);
            divider.setPos(0, 4);
            this.addChildGui(divider);
            const corner = new (ig as any).ImageGui(((sc as any).OptionRow && (sc as any).OptionRow.prototype.gfx) || null, 32, 416, 8, 8);
            try {
                corner.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_BOTTOM);
                corner.setPos(166, 3);
                this.addChildGui(corner);
            } catch (_) { /* gfx optional */ }
            // Current-choice readout on the right half (native type guis sit at x=175).
            this.valueGui = new (sc as any).TextGui('', { font: (sc as any).fontsystem.tinyFont });
            this.valueGui.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_CENTER);
            this.valueGui.setPos(175, 0);
            this.addChildGui(this.valueGui);
            // The single focus cell for this row (rowGroup column 0). Keyboard
            // confirm + mouse click route through the row's onPressed (the rowGroup
            // press callback fires for members); its own onButtonPress stays empty so
            // nothing double-cycles. It spans the value readout (so clicking the value
            // also cycles) and sits UNDER the arrows, so the arrows win the mouse.
            const FocusGui = (ig as any).FocusGui.extend({
                init(this: any) {
                    this.parent();
                    this.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_CENTER);
                    this.setPos(0, 0);
                    this.setSize(60, 26);
                },
                updateDrawables(drawer: any) {
                    // Faint highlight so keyboard focus is visible.
                    try {
                        if (this.focus) drawer.addColor('rgba(255,255,255,0.10)', 0, 0, this.hook.size.x, this.hook.size.y);
                    } catch (_) { /* ignore */ }
                },
            });
            this.focus = new FocusGui();
            this.focus.rowRef = this;
            this.focus._rowGroup = rowGroup;
            this.focus.data = { description: description, row: this.row };
            this.addChildGui(this.focus);
            rowGroup.addFocusGui(this.focus, 0, this.row);
            // Arrow buttons around the value. The decorative ◀/▶ glyphs are NOT in the
            // game fonts, so '<'/'>' (which are) are used. Mouse-only: each arrow
            // overrides onButtonPress to cycle; they are not focus cells.
            const ArrowBtn = (sc as any).ButtonGui.extend({
                _onCycle: null,
                init(this: any, text: string) {
                    this.parent(text, 24, true, (sc as any).BUTTON_TYPE.DEFAULT, null, false);
                    this._onCycle = null;
                },
                onButtonPress(this: any) { if (this._onCycle) this._onCycle(); },
            });
            this.leftBtn = new ArrowBtn('<');
            this.leftBtn._onCycle = () => this.cycle(-1);
            this.leftBtn.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_CENTER);
            this.leftBtn.setPos(175, 0);
            this.addChildGui(this.leftBtn);
            // Round-14 fix: the right arrow was hard-coded '<' in ArrowBtn.init,
            // so both buttons rendered as '<'. The glyph is now passed in.
            this.rightBtn = new ArrowBtn('>');
            this.rightBtn._onCycle = () => this.cycle(1);
            this.rightBtn.setAlign(ig.GUI_ALIGN.X_LEFT, ig.GUI_ALIGN.Y_CENTER);
            this.rightBtn.setPos(201, 0);
            this.addChildGui(this.rightBtn);
            try { this.hook.setMouseRecord(true); } catch (_) { /* ignore */ }
            this.refresh();
        },
        indexFromOption(this: any): number {
            const v = getMpOption(this._key);
            const idx = this._values.indexOf(v);
            return idx === -1 ? 0 : idx;
        },
        optionFromIndex(this: any, idx: number) {
            setMpOption(this._key, this._values[idx]);
        },
        cycle(this: any, dir: number) {
            const n = this._values.length;
            const cur = this.indexFromOption();
            const next = ((cur + dir) % n + n) % n;
            this.optionFromIndex(next);
            this.refresh();
            if (this._onApplied) this._onApplied();
        },
        refresh(this: any) {
            const idx = this.indexFromOption();
            this.valueGui.setText(this._choices[idx]);
            // Value starts right of the left arrow; right arrow glued to the text.
            const vx = 175 + 24 + 2;
            this.valueGui.setPos(vx, 0);
            const rx = vx + this.valueGui.hook.size.x + 4;
            this.rightBtn.setPos(rx, 0);
            // The focus cell spans the value readout (and beyond) so clicking the
            // value itself also cycles forward.
            this.focus.setPos(vx, 0);
            this.focus.setSize(Math.max(40, 431 - vx), 26);
        },
        onPressed(this: any, a: any) {
            if (a === this.focus) this.cycle(1);
        },
        onLeftRight(this: any, dir: boolean) {
            this.cycle(dir ? 1 : -1);
            return true;
        },
        onMouseInteract(this: any) {
            // Mirror native OptionRow hover -> info text (same as the toggle rows).
            try {
                if ((sc as any).menu && (sc as any).menu.buttonInteract && (sc as any).menu.buttonInteract.isActive() && this.focus._rowGroup && this.focus._rowGroup.isActive()) {
                    const b = this.hook.screenCoords;
                    const mx = (sc as any).control.getMouseX();
                    const my = (sc as any).control.getMouseY();
                    if (b.x <= mx && b.x + b.w > mx && b.y <= my && b.y + b.h > my) (sc as any).menu.setInfoText(description);
                }
            } catch (_) { /* ignore */ }
        },
    });
    return new RowCtor();
}

/** Install the Options-tab injection (prototype-level, before the menu exists). */
export function installMpOptionsTab(getMain: () => Multiplayer | undefined): void {
    if (typeof sc === 'undefined' || !(sc as any).OptionsTabBox) {
        console.warn('[multiplayer] sc.OptionsTabBox not available; options tab not installed');
        return;
    }
    const scAny: any = sc as any;
    if (scAny._mpOptionsTabInstalled) return;
    scAny._mpOptionsTabInstalled = true;

    // Register our category so any native lookup by category value is safe.
    try { scAny.OPTION_CATEGORY.MULTIPLAYER = MP_OPTION_CATEGORY; } catch (_) { /* ignore */ }

    scAny.OptionsTabBox.inject({
        init(this: any, ...args: any[]) {
            this.parent(...args);
            try {
                // Append the mod tab after the native ones. tabArray may have holes
                // (arena is conditional) — find the real count of defined tabs.
                let idx = 0;
                for (let i = 0; i < this.tabArray.length; i++) if (this.tabArray[i]) idx = i + 1;
                // TabButton(text, icon, largeWidth, smallWidth, noIcon). Native tabs
                // show icon-only when unpressed; we use noIcon + the label in both
                // states so we don't depend on a font icon that may not exist.
                const btn = new scAny.ItemTabbedBox.TabButton(t('optionsTab'), t('optionsTab'), 48, 48, true);
                try {
                    // Fit the width to the actual CJK text and keep it constant
                    // across pressed/unpressed (otherwise it snaps small↔large).
                    btn.setWidthToTextSize();
                    btn._smallWidth = btn._largeWidth;
                    btn.hook.size.x = btn._smallWidth;
                } catch (_) { /* keep the 48px fallback */ }
                try { btn.textChild.setPos(7, 1); } catch (_) { /* ignore */ }
                btn.setPos(0, 2);
                btn.setData({ type: MP_OPTION_CATEGORY });
                this.addChildGui(btn);
                this.tabGroup.addFocusGui(btn, idx, 0);
                this.tabArray[idx] = btn;
                this._rearrangeTabs();
            } catch (e) { console.warn('[multiplayer] failed to add options tab', e); }
        },
        // Build OUR rows when the mod tab is selected; defer everything else native.
        _createOptionList(this: any, category: any) {
            if (category === MP_OPTION_CATEGORY) {
                try {
                    const rows: any[] = [];
                    // Every row change rebuilds the tags next frame so styling
                    // (font/alpha/gold) never survives stale.
                    const refreshTags = () => { resetAllTags(); applyNameTagsNow(getMain); };
                    let r = 0;
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optShowNames'), t('optShowNamesDesc'), 'showNameTags', refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optShowSelf'), t('optShowSelfDesc'), 'showOwnName', refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optShowBots'), t('optShowBotsDesc'), 'showBotNames', refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optLeaderGold'), t('optLeaderGoldDesc'), 'leaderGold', refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optShowPing'), t('optShowPingDesc'), 'showPing', refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    // Round 21: host tick rate. Latched at host-acquire, and ROUND 80
                    // now HOT-APPLIES while WE are the current host so the hostile
                    // entity stream AND the enemy-projectile stream both follow the
                    // newly selected frequency immediately.
                    rows[r] = buildChoiceRow(r, this.rowButtonGroup, t('optHostTick'), t('optHostTickDesc'), 'hostTickRate', HOST_TICK_LABELS, HOST_TICK_VALUES, () => {
                        try {
                            const m = getMain();
                            if (m && m.host && m.netSync) m.netSync.setBlockInterval(m.getHostTickInterval());
                        } catch (_) { /* next host-acquire still latches it */ }
                    });
                    this.list.addButton(rows[r], true); r++;
                    // Round 23: own playerState send rate. HOT-APPLIES — netSync reads it
                    // live every tick (shouldSendPlayerState's floor), so the rows' onApplied
                    // can be a no-op (the next packet uses the new rate immediately).
                    rows[r] = buildChoiceRow(r, this.rowButtonGroup, t('optPlayerStateRate'), t('optPlayerStateRateDesc'), 'playerStateRate', PLAYER_STATE_LABELS, PLAYER_STATE_RATES, () => { /* netSync reads live every tick */ });
                    this.list.addButton(rows[r], true); r++;
                    // Round 21: network debug overlay toggles. The HUD pump reads the
                    // options live each second, so a change needs no immediate action.
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optNetDebug'), t('optNetDebugDesc'), 'showNetDebug', () => { /* HUD pump reads live */ });
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optNetDebugCum'), t('optNetDebugCumDesc'), 'showNetDebugCumulative', () => { /* HUD pump reads live */ });
                    this.list.addButton(rows[r], true); r++;
                    // ROUND 76 (advanced network tool): per-event network-usage panel
                    // (upload/download per sync type, 1s refresh). The same HUD pump
                    // reads the option live, so the onApplied is a no-op.
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optNetTool'), t('optNetToolDesc'), 'showNetTool', () => { /* HUD pump reads live */ });
                    this.list.addButton(rows[r], true); r++;
                    // Round 24: save-success toast toggle. No immediate action — the
                    // gate in multiplayer.ts's onSaveSaved reads it live at save time.
                    rows[r] = buildToggleRow(r, this.rowButtonGroup, t('optShowSaveToast'), t('optShowSaveToastDesc'), 'showSaveToast', () => { /* read live at save time */ });
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildChoiceRow(r, this.rowButtonGroup, t('optTagAlpha'), t('optTagAlphaDesc'), 'tagAlpha', TAG_ALPHA_LABELS, TAG_ALPHA_VALUES, refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    rows[r] = buildChoiceRow(r, this.rowButtonGroup, t('optTagSize'), t('optTagSizeDesc'), 'tagSize', TAG_SIZE_LABELS, TAG_SIZE_KEYS, refreshTags);
                    this.list.addButton(rows[r], true); r++;
                    this.rows = rows;
                } catch (e) { console.warn('[multiplayer] failed to build options rows', e); }
                return;
            }
            return this.parent(category);
        },
    });
    console.log('[multiplayer] mod options tab installed');
}

// --------------------------------------------------------------- name tags

let tagContainer: any = null;
const tags: { [name: string]: any } = {};
const scr: { x: number, y: number } = { x: 0, y: 0 };
// Remembers whether the master toggle was on last frame so an off→on flip can
// drop stale cached tags (styling rebuilds fresh).
let lastTagsEnabled = false;

/** Current backing opacity from options, clamped to the 5 allowed values. */
function pickTagAlpha(): number {
    const a = getMpOption('tagAlpha') as number;
    return TAG_ALPHA_VALUES.indexOf(a) === -1 ? 0.5 : a;
}

/** Current tag font from options (小 tiny / 中 small / 大 main bold font). */
function pickTagFont(): any {
    const fs: any = (sc as any).fontsystem;
    const key = getMpOption('tagSize') as string;
    if (key === 'font' && fs && fs.font) return fs.font;
    if (key === 'small' && fs && fs.smallFont) return fs.smallFont;
    return fs && fs.tinyFont;
}

function makeTag(name: string, opts: { font: any, alpha: number, gold: boolean }): any {
    const font = opts.font || ((sc as any).fontsystem && (sc as any).fontsystem.tinyFont);
    const alpha = (typeof opts.alpha === 'number') ? opts.alpha : 0.55;
    const gold = !!opts.gold;
    // Gold leader tags reuse the engine's own gold color. TextGui/TextBlock take NO
    // color option, but the \c[N] text command picks a font color-set index; the
    // PURPLE set (3) renders #FFE430 on every tag font (verified: the three glyph
    // sheets are all RGB 255,228,48). The engine has no #FFD700 color set, so the
    // game's actual gold #FFE430 is used.
    const textStr = gold ? '\\c[' + ((sc as any).FONT_COLORS ? (sc as any).FONT_COLORS.PURPLE : 3) + ']' + name : name;
    const text = new (sc as any).TextGui(textStr, { font });
    const box = new (ig as any).GuiElementBase();
    box.addChildGui(text);
    // 3px horizontal padding around the name.
    const w = text.hook.size.x + 6;
    const h = text.hook.size.y + 2;
    text.setPos(3, 1);
    box.setSize(w, h);
    // Round 16: keep the TextGui + raw label on the tag so a changed label (the
    // live ping suffix) can be re-set without rebuilding the whole box.
    box._mpText = text;
    box._mpLabel = name;
    // Draw a translucent dark backing so the name reads over any background.
    // At alpha 0 the backing is skipped entirely. Reads the LIVE box size so a
    // setTagLabel resize (ping suffix appearing/disappearing) re-covers the text.
    box.updateDrawables = (drawer: any) => {
        try {
            if (alpha > 0) drawer.addColor('rgba(0,0,0,' + alpha + ')', 0, 0, box.hook.size.x, box.hook.size.y);
        } catch (_) { /* ignore */ }
    };
    try { box.hook.zIndex = 5; } catch (_) { /* ignore */ }
    // A fresh tag stays hidden until its first projection (no pop-in).
    try { box.hook._visible = false; } catch (_) { /* ignore */ }
    box._mpFontKey = font;
    box._mpAlpha = alpha;
    box._mpGold = gold;
    return box;
}

/** Drop every cached tag from the container and clear the cache. The next
 * applyNameTagsNow frame rebuilds them from the current options, so any row
 * change (or an off→on master-toggle flip) can never leave stale styling. */
function resetAllTags(): void {
    for (const n in tags) {
        const t = tags[n];
        try { tagContainer && tagContainer.removeChildGui(t); } catch (_) { /* ignore */ }
        delete tags[n];
    }
}

/** Hard-remove one tag right now (round 14): called by the multiplayer core
 * when a bot is kicked/culled or a player leaves, so its tag cannot linger at
 * the last projected position while the per-frame loop reconciles. */
export function dropNameTag(name: string): void {
    const t = tags[name];
    if (!t) return;
    try { tagContainer && tagContainer.removeChildGui(t); } catch (_) { /* ignore */ }
    delete tags[name];
}

/** Round 16: hard-remove EVERY cached tag from the gui container and clear the
 * map/cache. Used on kicks, party roster changes (kick received/leave/disband)
 * and map changes so NO tag can linger at a stale position. The per-frame
 * applyNameTagsNow recreates tags for live entities on subsequent frames from
 * the reconciled roster — that IS the "reload" half. Mirrors dropNameTag's
 * removal logic for all entries; wrapped in try/catch so a broken tag can never
 * abort the wipe. */
export function wipeAllNameTags(): void {
    try {
        for (const n in tags) {
            const t = tags[n];
            try { tagContainer && tagContainer.removeChildGui(t); } catch (_) { /* ignore */ }
            delete tags[n];
        }
    } catch (_) { /* never break the update loop */ }
}

function anyMenuOpen(): boolean {
    try {
        const menu: any = (sc as any).menu;
        return !!(menu && menu.menuStack && menu.menuStack.length > 0);
    } catch (_) { return false; }
}

/** Round 16: re-set an existing tag's label text (own tag's live ping suffix)
 * and re-fit the box to the new text width. TextGui.setText is expensive, so
 * this must only be called when the displayed label actually changed (see
 * addTagAt's change gate) — never every frame. Re-applies the gold prefix for
 * leader tags so a change can't strip it. */
function setTagLabel(tag: any, label: string): void {
    try {
        const text = tag && tag._mpText;
        if (!text || typeof text.setText !== 'function') return;
        const textStr = tag._mpGold ? '\\c[' + ((sc as any).FONT_COLORS ? (sc as any).FONT_COLORS.PURPLE : 3) + ']' + label : label;
        text.setText(textStr);
        // Re-fit the backing box (the drawable reads the live box size).
        tag.setSize(text.hook.size.x + 6, text.hook.size.y + 2);
    } catch (_) { /* ignore */ }
}

/** Position + show one name tag above an entity, creating or reusing the cached
 * tag. The tag is recreated when its styling (font/alpha/gold) changed, because
 * the box size derives from the text hook and the backing is baked at creation. */
function addTagAt(name: string, ent: any, font: any, alpha: number, gold: boolean, label?: string): void {
    let tag = tags[name];
    if (tag && (tag._mpFontKey !== font || tag._mpAlpha !== alpha || tag._mpGold !== gold)) {
        try { tagContainer && tagContainer.removeChildGui(tag); } catch (_) { /* ignore */ }
        delete tags[name];
        tag = null;
    }
    if (!tag) {
        tag = makeTag(label != null ? label : name, { font, alpha, gold });
        tags[name] = tag;
        tagContainer.addChildGui(tag);
    } else {
        // Round 16: the label can change on a live tag (own-tag ping suffix).
        // Only call setText when the string actually changed — per-frame setText
        // is expensive and this runs every frame.
        const lbl = label != null ? label : name;
        if (tag._mpLabel !== lbl) {
            tag._mpLabel = lbl;
            setTagLabel(tag, lbl);
        }
    }
    // Project the head position to screen space (same math the native quick-menu
    // anchors use: fold z into y before projecting).
    const coll = ent.coll;
    const cx = coll.pos.x + coll.size.x / 2;
    const cy = coll.pos.y - coll.pos.z - coll.size.z + coll.size.y / 2;
    (ig as any).system.getScreenFromMapPos(scr, Math.round(cx), Math.round(cy));
    tag.setPos(Math.round(scr.x - tag.hook.size.x / 2), Math.round(scr.y - tag.hook.size.y - 2));
    try { tag.hook._visible = true; } catch (_) { /* ignore */ }
}

/** Round 17: a ` (Nms)` suffix for a valid (finite, >=0) ping, else nothing. */
function pingSuffix(ms: number): string {
    return (typeof ms === 'number' && isFinite(ms) && ms >= 0) ? ' (' + Math.round(ms) + 'ms)' : '';
}

/** Round 16/17: label for the LOCAL player's own tag. When 显示ping值 is on and the
 * connection has a valid locally-measured RTT sample, append ` (123ms)`; otherwise
 * return the plain name. The own tag ALWAYS shows this client's own latency
 * (connector pingMs), never the server-relayed value. */
function ownTagLabel(m: Multiplayer | undefined, base: string): string {
    try {
        // Main-city refactor: in a shared town, name tags show the plain name only —
        // no ping / " (Host)" suffix (those are wilderness-only).
        if (isSharedTownNow()) return base;
        if (!getMpOption('showPing')) return base;
        const conn: any = m && (m as any).connection;
        if (!conn) return base;
        if (typeof conn.isOpen === 'function' && !conn.isOpen()) return base;
        // Round 20: the map-instance HOST's own tag shows " (Host)" instead of the
        // latency. The host never receives its own playerPing relay, so the changeMap
        // verdict (main.host) is the authoritative source here.
        if (m && (m as any).host) return base + t('hostSuffix');
        return base + pingSuffix(conn.pingMs);
    } catch (_) { return base; }
}

/** Round 17: label for a REMOTE player's tag. When 显示ping值 is on, append the RTT
 * that player reports to the server (remotePings[name], ~1/s) when we have a
 * recent value (>= 0); otherwise the plain name. Never uses the local pingMs. */
function remoteTagLabel(m: Multiplayer | undefined, name: string): string {
    try {
        // Main-city refactor: no ping / " (Host)" suffix on tags inside a shared town.
        if (isSharedTownNow()) return name;
        if (!getMpOption('showPing')) return name;
        const pings: any = m && (m as any).remotePings;
        if (!pings) return name;
        // Round 20: the map-instance HOST's remote tag shows " (Host)" instead of
        // the latency (instanceHost is seeded from changeMapResponse.host and kept
        // fresh by the host's own playerPing relay).
        if ((m as any).instanceHost === name) return name + t('hostSuffix');
        return name + pingSuffix(pings[name]);
    } catch (_) { return name; }
}

/** Reconcile name tags with the live set of taggable entities. Called every frame
 * from the update loop and immediately when any option toggle changes. */
export function applyNameTagsNow(getMain: () => Multiplayer | undefined): void {
    try {
        const m = getMain();
        const enabled = !!getMpOption('showNameTags');
        const show = enabled && !!m && inGameOk() && !anyMenuOpen();

        // Off→on: drop stale cached tags so styling rebuilds from current options.
        if (enabled && !lastTagsEnabled) resetAllTags();
        lastTagsEnabled = enabled;

        if (!show) {
            for (const n in tags) { try { tags[n].hook._visible = false; } catch (_) { /* ignore */ } }
            return;
        }
        // Ensure container exists.
        if (!tagContainer) {
            tagContainer = new (ig as any).GuiElementBase();
            (ig as any).gui.addGuiElement(tagContainer);
        }
        const seen: { [name: string]: boolean } = {};
        const font = pickTagFont();
        const alpha = pickTagAlpha();
        const goldOn = !!getMpOption('leaderGold') && !!(m as any).partyLeader;

        // Own player tag (account name above the local player entity).
        if (getMpOption('showOwnName')) {
            const selfName = (m as any).name;
            const ent = (ig as any).game && (ig as any).game.playerEntity;
            if (selfName && ent && ent.coll && !ent._killed && !(ent.params && ent.params.currentHp <= 0)) {
                seen[selfName] = true;
                addTagAt(selfName, ent, font, alpha, goldOn && (m as any).partyLeader === selfName, ownTagLabel(m, selfName));
            }
        }

        // Remote player mirrors.
        const players = (m as any).players || {};
        for (const name in players) {
            try {
                // Round 22: only tag mirrors actually on THIS map. ROUND 83: once the
                // roster is settled (playersRosterReady), absence from the roster is
                // authoritative even when it's empty — a leaving/fading mirror's tag
                // must not be re-added. Before the first reconcile, an empty roster
                // still fails open so unknown members can self-heal.
                const onMap = (m as any).playersOnThisMap;
                if (onMap && !onMap[name] && ((m as any).playersRosterReady || Object.keys(onMap).length > 0)) continue;
                // ROUND 83: a known sub-map that differs from ours also overrides the
                // roster (missed enter/leave relay) so the old area's tag can't linger.
                const pmap = (m as any).playerMapByName;
                if (pmap && pmap[name] !== undefined && pmap[name] !== (ig.game ? (ig.game as any).mapName : '')) continue;
                const pl = players[name];
                const ent = pl && pl.entity;
                // Round 20: hide the tag the very first frame the death flag arrives
                // (netSync sets _mpDying immediately in playPuppetDeath; _killed only
                // lands ~500ms later via the delayed-death queue).
                if (!ent || !ent.coll || ent._killed || (ent as any)._mpDying) continue;
                seen[name] = true;
                // Round 17: remote tags carry the player's OWN reported ping when
                // 显示ping值 is on (remoteTagLabel appends ` (Nms)`). The gold
                // \c[3] leader prefix is applied by makeTag/setTagLabel around the
                // whole label, so prefix + ping-suffix order stays consistent.
                addTagAt(name, ent, font, alpha, goldOn && (m as any).partyLeader === name, remoteTagLabel(m, name));
                // Round 19: dim the name tag of a player who is in a cutscene
                // (their mirror is faded too, so a bright tag would look wrong).
                // The tag's alpha lever is hook.localAlpha (the same localAlpha the
                // StatusBar uses), multiplied into the whole box at draw time.
                // Change-gated so we only touch it when the dim state flips.
                const tag = tags[name];
                if (tag) {
                    const dim = !!(pl as any)._mpCutscene;
                    const want = dim ? 0.35 : 1;
                    if (tag._mpDimAlpha !== want) {
                        tag._mpDimAlpha = want;
                        try { tag.hook.localAlpha = want; } catch (_) { /* ignore */ }
                    }
                }
            } catch (_) { /* one broken entry must not abort the hide pass below */ }
        }

        // Follower bots (native + mod). Keyed by their sc.party.partyEntities name;
        // the label resolves through the party model's getCharacterName override
        // (mod bots return the account name, native bots their character name).
        if (getMpOption('showBotNames')) {
            const party: any = (sc as any).party;
            const ents = party && party.partyEntities;
            if (ents) {
                for (const name in ents) {
                    try {
                        const ent = ents[name];
                        // Round 14: dying/dead bots must drop their tag immediately —
                        // a kicked bot can briefly linger in partyEntities while its
                        // death state runs; only fully ALIVE entities are taggable.
                        if (!ent || !ent.coll || ent._killed) continue;
                        if (typeof ent.isDying === 'function' ? ent.isDying() : (ent.dying && ent.dying > 0)) continue;
                        // The party entry must still be registered; a culled bot whose
                        // entity object survived would otherwise keep its tag forever.
                        if (party.currentParty && party.currentParty.indexOf && party.currentParty.indexOf(name) === -1) continue;
                        seen[name] = true;
                        let label = name;
                        const mdl = party.models && party.models[name];
                        if (mdl && typeof mdl.getCharacterName === 'function') label = mdl.getCharacterName();
                        // Bots are never gold — only player tags are.
                        addTagAt(name, ent, font, alpha, false, label);
                    } catch (_) { /* one broken entry must not abort the hide pass below */ }
                }
            }
        }

        // Hide tags whose target left / despawned.
        for (const n in tags) {
            if (!seen[n]) { try { tags[n].hook._visible = false; } catch (_) { /* ignore */ } }
        }
    } catch (_) { /* never break the update loop */ }
}

function inGameOk(): boolean {
    try {
        const g: any = (ig as any).game;
        if (!g || !g.playerEntity) return false;
        if (typeof g.isTeleporting === 'function' && g.isTeleporting()) return false;
        return true;
    } catch (_) { return false; }
}

/** Start the per-frame name-tag pump (idempotent). */
export function startNameTagLoop(getMain: () => Multiplayer | undefined): void {
    const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
    if (!s || typeof s.registerUpdate !== 'function') return;
    if ((s as any)._mpNameTagLoop) return;
    (s as any)._mpNameTagLoop = true;
    s.registerUpdate(() => { applyNameTagsNow(getMain); });
}

// --------------------------------------------------------------- network debug overlay

/** ROUND 80 (unit unification): ALL network-debug displays use byte-based units
 * ('B','kB','MB','GB'). The engine counters are still bits/sec internally, so
 * callers convert with `/ 8` before calling this. 1024-stepping; values below
 * 1024 show as a plain integer + 'B', anything else as one decimal + the unit. */
function formatBytes(bytes: number): string {
    if (!isFinite(bytes) || bytes < 0) bytes = 0;
    const units = ['B', 'kB', 'MB', 'GB'];
    let v = bytes;
    let u = 0;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    if (u === 0) return Math.round(v) + 'B';
    return v.toFixed(1) + units[u];
}

let netHudBox: any = null;
let netHudText: any = null;
let netHudTimer = 0;
let netHudLast = '';
/** ROUND 81 (FPS readout): frames + wall-clock window for the real render FPS shown
 * in the SIMPLE network debug overlay. Counted in the same pump that renders it and
 * folded every time that pump's 1s game-time window elapses (FPS = frames / real
 * elapsed seconds, so a hitch lowers the value and a paused game resets the window). */
let netHudFrames = 0;
let netHudFpsAt = 0;
let netHudFps = 0;

/** Lazily build the bottom-right debug overlay: one dark-backed GuiElementBase
 * holding a single tiny-font text element — the same container + hook mechanics the
 * name tags use (both are added to ig.gui and positioned in screen coords). */
function ensureNetHud(): any {
    if (netHudBox) return netHudBox;
    netHudBox = new (ig as any).GuiElementBase();
    (ig as any).gui.addGuiElement(netHudBox);
    netHudText = new (sc as any).TextGui('', { font: (sc as any).fontsystem.tinyFont });
    netHudText.setPos(6, 4);
    netHudBox.addChildGui(netHudText);
    netHudBox.updateDrawables = (drawer: any) => {
        try { drawer.addColor('rgba(0,0,0,0.5)', 0, 0, netHudBox.hook.size.x, netHudBox.hook.size.y); } catch (_) { /* ignore */ }
    };
    try { netHudBox.hook.zIndex = 6; } catch (_) { /* ignore */ }
    try { netHudBox.hook._visible = false; } catch (_) { /* ignore */ }
    return netHudBox;
}

/** Round 21: one 1s pass of the network debug overlay. Visible only when 显示网络调试
 * is on, the connection is open and exposes getNetStats, in-game and no menu is up.
 * Text is only re-set (and the box re-fit + re-anchored bottom-right) when the
 * string actually changed — setText every second would be needless churn. */
function applyNetHudNow(getMain: () => Multiplayer | undefined): void {
    try {
        const m = getMain();
        // ROUND 76: the advanced network tool renders inside THIS bottom-right debug
        // window (a top-left panel collided with other UI), so it takes priority over
        // the simple text while it is on; the simple debug stays when only
        // showNetDebug is enabled.
        const showTool = !!getMpOption('showNetTool');
        const showSimple = !showTool && !!getMpOption('showNetDebug');
        const show = (showTool || showSimple) && !!m && inGameOk() && !anyMenuOpen();
        const conn: any = m && m.connection;
        if (!show || !conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) {
            if (netHudBox) { try { netHudBox.hook._visible = false; } catch (_) { /* ignore */ } }
            return;
        }
        let str = '';
        if (showTool && typeof conn.getUploadEventStats === 'function') {
            str = buildNetToolText(conn);
        }
        if (!str && typeof conn.getNetStats === 'function') {
            const s = conn.getNetStats();
            // Round 22: arrow glyphs for up/down (user-requested; ↑ ↓ render in the game
            // fonts — unlike ◀ ▶). esbuild escapes the glyphs for us.
            // ROUND 80: all rates/totals are bytes (B/kB/MB), not bits.
            // ROUND 81: the simple tool also shows the real render FPS, averaged over
            // the same ~1s window as the rates.
            const fps = Math.max(0, Math.min(999, Math.round(netHudFps)));
            str = 'FPS ' + fps + '  ↑ ' + formatBytes(s.upBitsSec / 8) + '/s  ↓ ' + formatBytes(s.downBitsSec / 8) + '/s  LOSS ' + Math.round(s.lossPct) + '%';
            if (getMpOption('showNetDebugCumulative')) {
                str += '\n↑ ' + formatBytes(s.upBitsTotal / 8) + '  ↓ ' + formatBytes(s.downBitsTotal / 8);
                // ROUND 81 (item tick fix): H/B are now the MEASURED per-stream
                // entityState rates (the host tags every block with its stream and the
                // server relays the tag), so the number is the REAL active tick — not
                // the option setting. Fall back to the combined measured count only for
                // older connectors without per-stream fields.
                const sa: any = s as any;
                if (typeof sa.tickRateHostile === 'number' && typeof sa.tickRateBase === 'number') {
                    str += '  TICK ' + Math.round(sa.tickRateHostile) + '(H)/s ' + Math.round(sa.tickRateBase) + '(B)/s';
                } else {
                    str += '  TICK ' + Math.round(sa.tickRate || 0) + '/s';
                }
            }
        }
        if (!str) {
            if (netHudBox) { try { netHudBox.hook._visible = false; } catch (_) { /* ignore */ } }
            return;
        }
        if (str !== netHudLast) {
            netHudLast = str;
            ensureNetHud();
            netHudText.setText(str);
            try {
                const w = netHudText.hook.size.x + 12;
                const h = netHudText.hook.size.y + 8;
                netHudBox.setSize(w, h);
                netHudBox.setPos(Math.max(0, (ig as any).system.width - w - 8), Math.max(0, (ig as any).system.height - h - 8));
            } catch (_) { /* ignore */ }
        }
        try { netHudBox.hook._visible = true; } catch (_) { /* ignore */ }
    } catch (_) { /* never break the update loop */ }
}

// ---- ROUND 76 (advanced network tool): full per-event network-usage table ----

/** ROUND 76: build the per-event network-usage table text (header + top rows, by
 * combined rate). The callers (applyNetHudNow) render it; the per-event windows
 * reset on every read, so the rates always describe the last second. Returns ''
 * when the connector lacks the per-event counters (older build). */
function buildNetToolText(conn: any): string {
    try {
        const up = conn.getUploadEventStats();
        const down = (typeof conn.getDownloadEventStats === 'function') ? conn.getDownloadEventStats() : [];
        // Merge both directions per event name, keep the top rows by combined rate.
        const merged: { [name: string]: any } = Object.create(null);
        for (const r of up) { const e = merged[r.event] || (merged[r.event] = {}); e.up = r; }
        for (const r of down) { const e = merged[r.event] || (merged[r.event] = {}); e.down = r; }
        const rows: any[] = [];
        for (const name in merged) {
            const e = merged[name];
            const upBps = e.up ? e.up.bytesPerSec : 0;
            const downBps = e.down ? e.down.bytesPerSec : 0;
            rows.push({ name, upBps, downBps, upCount: e.up ? e.up.count : 0, downCount: e.down ? e.down.count : 0, upTotal: e.up ? e.up.total : 0, downTotal: e.down ? e.down.total : 0 });
        }
        rows.sort((a, b) => (b.upBps + b.downBps) - (a.upBps + a.downBps));
        const top = rows.slice(0, 14);
        // Sum ALL rows (not only the displayed top) so the 合计 line is directly
        // comparable with the engine-level header — any leftover difference is
        // protocol framing / untagged packets, not missing sync traffic.
        let sumUp = 0;
        let sumDown = 0;
        for (const r of rows) { sumUp += r.upBps; sumDown += r.downBps; }
        let str = '';
        try {
            const s: any = typeof conn.getNetStats === 'function' ? conn.getNetStats() : null;
            if (s) {
                // ROUND 80: header + rows + totals all use bytes (B/kB/MB). The
                // engine counters are bits/sec, so convert before formatting.
                str = '↑ ' + formatBytes(s.upBitsSec / 8) + '/s   ↓ ' + formatBytes(s.downBitsSec / 8) + '/s   ' + t('netToolLoss') + ' ' + Math.round(s.lossPct || 0) + '%\n';
            }
        } catch (_) { /* header is cosmetic */ }
        if (!top.length) {
            str += t('netToolNoEvents');
        } else {
            for (const r of top) {
                str += r.name
                    + '  ↑' + formatBytes(r.upBps) + '/s·' + r.upCount + '·' + formatBytes(r.upTotal)
                    + '  ↓' + formatBytes(r.downBps) + '/s·' + r.downCount + '·' + formatBytes(r.downTotal) + '\n';
            }
            str += t('netToolSum') + '  ↑' + formatBytes(sumUp) + '/s  ↓' + formatBytes(sumDown) + '/s';
        }
        return str;
    } catch (_) {
        return '';
    }
}

/** Round 21: start the 1s-cadence network-debug HUD pump (idempotent). */
export function startNetHudLoop(getMain: () => Multiplayer | undefined): void {
    const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
    if (!s || typeof s.registerUpdate !== 'function') return;
    if ((s as any)._mpNetHudLoop) return;
    (s as any)._mpNetHudLoop = true;
    s.registerUpdate(() => {
        try {
            // ROUND 81: count every rendered frame for the FPS readout. While the game
            // is paused (ig.system.tick === 0) the window is reset continuously so a
            // long pause is never averaged into the next displayed FPS value.
            const nowMs = Date.now();
            if (!netHudFpsAt) netHudFpsAt = nowMs;
            netHudFrames++;
            if (!(ig.system.tick > 0)) {
                netHudFrames = 0;
                netHudFpsAt = nowMs;
                return;
            }
            netHudTimer += ig.system.tick;
            if (netHudTimer < 1) return;
            netHudTimer = 0;
            const fpsElapsed = nowMs - netHudFpsAt;
            if (fpsElapsed >= 250) {
                netHudFps = netHudFrames * 1000 / fpsElapsed;
                netHudFrames = 0;
                netHudFpsAt = nowMs;
            }
            // ROUND 76: the advanced network tool renders inside applyNetHudNow's
            // bottom-right window, so it shares this one pump.
            applyNetHudNow(getMain);
        } catch (_) { /* never break the update loop */ }
    });
}
