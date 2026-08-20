import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';
import type { INetQuality, NetTier } from '../connection';
import { getMpUiScale } from './uiScale';

/**
 * Round 24: network-quality DIAMOND badges on the party-HUD portraits and the
 * player's element-mode indicator, plus hover tooltips (ping/loss on a badge,
 * member name + level on a portrait). Reworked to PIXEL-ART scanline diamonds
 * (no rotation / anti-aliasing, matching the in-game UI) — see drawDiamond.
 *
 * WHY RENDERER DRAW-STEPS, NOT RAW 2D CONTEXT: a raw `ig.system.context` draw
 * inside a gui `draw()` override runs BEFORE the element's transform is applied —
 * the gui collects draw-steps during onDeferredUpdate and applies their transforms
 * later in renderer.draw(), so a direct-context draw can't be positioned reliably.
 * The ig.GuiRenderer's plain addColor draw-steps ARE applied in the element's own
 * space, so the badge tracks the portrait/element automatically at the correct
 * scale — the pixel coords below are element-local integers.
 *
 * Hover hit-testing uses the engine-maintained `hook.screenCoords` rect (seeded
 * here; ig.gui recomputes it every frame in gui coords) vs `ig.input.mouse` —
 * which the engine compares against screenCoords in _updateGuiMouse, so they share
 * one coordinate space. Tooltips are a single fixed-position DOM div (the mod's
 * CJK-safe font stack, pointer-events:none) repositioned from `ig.input.mouse` via
 * `ig.system.getDrawPos`.
 */

/** Tier -> fill color for the diamond (spec: green/yellow/orange/red). */
const TIER_COLORS: Record<NetTier, string> = {
    green: '#4caf50',
    yellow: '#ffc107',
    orange: '#ff9800',
    red: '#f44336',
};
/** Round 27 (item 2): the diamond of a teammate who is OFF our map renders grey
 * (instead of a live tier color) and its hover tooltip says 不在同一房间. */
const OFFMAP_COLOR = '#8a8a92';

/** Same thresholds as SocketIOConnector.computeNetTier (loss dominates, then
 * latency). Used locally so member badges can tier a RELATIVE ping. */
function tierFor(ping: number, lossPct: number): NetTier {
    if (lossPct > 50 || ping > 300) return 'red';
    if (lossPct > 20 || ping > 150) return 'orange';
    if (lossPct > 5 || ping > 75) return 'yellow';
    return 'green';
}

/** Subtle dark outline behind the diamond so it reads on any portrait. */
const BADGE_OUTLINE = '#16161f';

/** Diamond half-sizes (integer gui px). Pixel-diamond rows are 2*(h-|dy|)+1 px, so
 * the fill is 2h+1 px wide and the outline 2(h+1)+1 px. Self badge = 50% of the old
 * 9px fill (h=2 → 5px fill / 7px outline); member badge = 25% (h=1 → 3px / 5px). */
const BADGE_HALF_SELF = 2;
const BADGE_HALF_MEMBER = 1;

/** Badge center offsets from the hook origin (gui px). The member badge sits neatly
 * in the portrait's top-left corner at (3,3). The self badge has TWO sites because
 * the engine moves StatusElementModeGui itself: MINIMIZED (normal play) it sits at
 * (0,0) inside StatusHudGui, which is anchored right in the screen corner — a
 * negative offset renders OFF-SCREEN there, so the minimized badge uses +6 (inside
 * the icon box, the round-23 spot). EXPANDED (quick menu / menus / element switch —
 * engine sets gui.selectBg=true and slides the gui to a wheel slot) there is room
 * around it, so the badge sits OUTSIDE the wheel, above-left at (-6,-6). */
const BADGE_OFF_MEMBER = 3;
const BADGE_OFF_SELF = -6;
const BADGE_OFF_SELF_MIN = 6;
/** Badge hover target is the diamond plus a small pad for easy hovering. */
const BADGE_HOVER_PAD = 2;

/** One install per game session (same pattern as the other installers). */
let installed = false;
let mpGetMain: (() => Multiplayer | undefined) | null = null;

/** Latest quality, refreshed once per frame by the pump. */
let mpQuality: INetQuality | null = null;

/** One hoverable rect collected during this frame's gui draws, consumed by the
 * pump on the next frame. Badges are pushed after portraits and win tie-breaks. */
interface HoverTarget {
    x: number; y: number; w: number; h: number;
    kind: 'badge' | 'portrait';
    name?: string;
    level?: number;
    /** Round 27 (item 2): this member is off our map — grey diamond + tooltip. */
    offMap?: boolean;
    /** Member badge tooltip = the MEMBER's own server link only: their ping
     * (relayed ~1/s via playerPing) plus the loss %, in the same format as the
     * self badge. (The diamond TIER still uses the relative link — see
     * collectMemberHud — only the hover text changed.) */
    peerPing?: number;
    lossPct?: number;
}
let hoverTargets: HoverTarget[] = [];

/** The single reusable tooltip div (null until first shown). */
let mpTooltip: JQuery | null = null;
let tipStyleInstalled = false;

/** True while badges should render: connected + actually in a game world. The HUD
 * guis only draw in-game anyway; this is the belt-and-braces connection gate. */
function netBadgeActive(): boolean {
    try {
        const m = mpGetMain && mpGetMain();
        if (!m) return false;
        const conn: any = m.connection;
        if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return false;
        const g: any = (ig as any).game;
        if (!g || !g.playerEntity) return false;
        return true;
    } catch (_) { return false; }
}

/** In a game menu? Tooltips/badges are in-game-only; this hides a stale tooltip
 * the moment a menu opens (mirrors the net-HUD overlay's anyMenuOpen gate). */
function anyMenuOpen(): boolean {
    try {
        const menu: any = (sc as any).menu;
        return !!(menu && menu.menuStack && menu.menuStack.length > 0);
    } catch (_) { return false; }
}

/** Draw a PIXEL-ART scanline diamond (no setRotate/setPivot, no anti-aliasing —
 * matches the in-game UI). For integer half-size `h`, one addColor rect per row:
 * for dy in -h..h, rowWidth = 2*(h-|dy|)+1 pixels centered at (cx, cy+dy). The
 * outline backs the fill as a diamond of half-size h+1 drawn FIRST (same scanline
 * loop), then the tier-color diamond of half-size h on top. Coords are element-local
 * integers (the gui renderer applies the element transform), so the diamond lands
 * exactly at the badge offset. */
function drawDiamond(renderer: any, cx: number, cy: number, h: number, color: string): void {
    for (let dy = -(h + 1); dy <= h + 1; dy++) {
        const half = (h + 1) - Math.abs(dy);
        renderer.addColor(BADGE_OUTLINE, cx - half, cy + dy, half * 2 + 1, 1);
    }
    for (let dy = -h; dy <= h; dy++) {
        const half = h - Math.abs(dy);
        renderer.addColor(color, cx - half, cy + dy, half * 2 + 1, 1);
    }
}

/** Ensure `hook.screenCoords` exists so ig.gui keeps it current every frame
 * (screenCoords is normally only allocated for mouse-recorded hooks; seeding it
 * here has no input side-effects). Seeds the hook AND every child hook of the
 * instrumented gui — MemberHudGui owns child HUD hooks (HP/SP bars, portrait)
 * that the engine's _updateGuiMouse and hit-testing can touch, so EVERY one must
 * carry a rect or a hover can crash on a missing one. Returns the (now valid) rect. */
function ensureScreenCoords(h: any): any {
    if (!h.screenCoords) {
        h.screenCoords = {
            x: 0,
            y: 0,
            w: h.size ? h.size.x : 0,
            h: h.size ? h.size.y : 0,
            active: false,
            zIndex: 0,
        };
    }
    const kids = h.children;
    if (kids && kids.length) {
        for (let i = 0; i < kids.length; i++) {
            if (kids[i] && !kids[i].screenCoords) {
                try { ensureScreenCoords(kids[i]); } catch (_) { /* one bad child must not stop the rest */ }
            }
        }
    }
    return h.screenCoords;
}

/** Round 27 (item 2): resolve the off-map state of the party mate a MemberHudGui
 * renders. Returns undefined when the mate is on our map (or unknown -> show). */
function memberOffMap(model: any): boolean {
    try {
        const name = model ? (model._mpName || model.name) : undefined;
        if (!name) return false;
        const m = mpGetMain && mpGetMain();
        if (m && typeof (m as any).isPartyMateOnMap === 'function') {
            return !(m as any).isPartyMateOnMap(name);
        }
    } catch (_) { /* ignore */ }
    return false;
}

/** Injected into sc.MemberHudGui.updateDrawables: diamond badge at the portrait's
 * top-left + a hoverable portrait rect (name/level come from the member model).
 * Round 27 (item 2): when the mate is OFF our map the diamond renders grey and the
 * badge hover target is tagged offMap (tooltip = 不在同一房间). */
function collectMemberHud(gui: any, renderer: any): void {
    if (!netBadgeActive()) return;
    const h = gui.hook;
    const sc = ensureScreenCoords(h);
    // Portrait hover target first, badge after — the pump's topmost-wins scan
    // iterates last-pushed first, so the badge (drawn on top) wins overlaps.
    const model: any = gui.model;
    const offMap = memberOffMap(model);
    const name: string = model ? String(model._mpName || model.name || '') : '';
    // 1.71.9 (issue 5): member DIAMONDS still tier on the RELATIVE link between
    // us and that member (my RTT/2 to the server + the member's RTT/2, the sum of
    // both half-trips). The hover TOOLTIP, however, reports only the member's own
    // server link: their route is `main.remotePings[name]` (their own server RTT,
    // ~1/s), so resolve it even when our own probe hasn't answered yet.
    let relPing: number | undefined;
    let myPing: number | undefined;
    let peerPing: number | undefined;
    let lossPct: number | undefined;
    let tier: NetTier | null = null;
    if (!offMap && name) {
        try {
            const m = mpGetMain && mpGetMain();
            const q = m && m.connection && typeof m.connection.getNetQuality === 'function'
                ? m.connection.getNetQuality() : null;
            const local = q && q.known ? q : null;
            const peer = m && m.remotePings && typeof m.remotePings[name] === 'number' ? m.remotePings[name] : -1;
            if (peer >= 0) peerPing = Math.round(peer);
            if (local) {
                myPing = local.ping >= 0 ? Math.round(local.ping) : undefined;
                lossPct = local.lossPct || 0;
                if (peerPing != null) {
                    relPing = Math.round((Number(myPing) + Number(peerPing)) / 2);
                } else {
                    relPing = myPing; // peer probe unknown -> fall back to our route
                }
                tier = tierFor(relPing != null ? relPing : 0, lossPct);
            }
        } catch (_) { /* fall back to the shared local quality below */ }
    }
    const q = mpQuality;
    const tierColor = offMap ? OFFMAP_COLOR : (tier ? TIER_COLORS[tier] : (q ? TIER_COLORS[q.tier] : OFFMAP_COLOR));
    const hasBadge = !!q || offMap;
    // ROUND 30 (item 5): hide an off-map member's HP/SP/EXP bars by zeroing the
    // child guis' hook localAlpha. The engine's draw gate is `x.localAlpha > 0`
    // on EACH hook (updateDrawables is skipped entirely at 0), and localAlpha
    // does NOT propagate to children — so the background frame, hpBar and spBar
    // must each be zeroed. A skip in MemberHpExpSpGui.updateDrawables alone only
    // hid the background (its children are drawn separately by the renderer).
    // Nothing else writes these hooks' localAlpha (the engine only sets it on
    // StatusHudGui's own hook), so per-frame write-on-change is safe.
    try {
        const bars: any = gui.hpExpSpGui;
        if (bars) {
            const want = offMap ? 0 : 1;
            const hookList: any[] = [bars.hook];
            if (bars.hpBar && bars.hpBar.hook) hookList.push(bars.hpBar.hook);
            if (bars.spBar && bars.spBar.hook) hookList.push(bars.spBar.hook);
            for (const hk of hookList) {
                if (hk && hk.localAlpha !== want) hk.localAlpha = want;
            }
        }
    } catch (_) { /* a bar-hide failure must never break the HUD draw */ }
    hoverTargets.push({
        x: sc.x, y: sc.y, w: sc.w, h: sc.h, kind: 'portrait',
        name: name || undefined,
        level: model && typeof model.level === 'number' ? model.level : undefined,
        offMap,
    });
    if (hasBadge) {
        drawDiamond(renderer, BADGE_OFF_MEMBER, BADGE_OFF_MEMBER, BADGE_HALF_MEMBER, tierColor);
        const pad = BADGE_HALF_MEMBER + BADGE_HOVER_PAD;
        hoverTargets.push({
            x: sc.x + BADGE_OFF_MEMBER - pad, y: sc.y + BADGE_OFF_MEMBER - pad,
            w: pad * 2, h: pad * 2, kind: 'badge', offMap,
            name: name || undefined, peerPing, lossPct,
        });
    }
}

/** Injected into sc.StatusElementModeGui.updateDrawables: the self badge. Offset
 * depends on the gui's mode (see BADGE_OFF_SELF_MIN): selectBg is the engine's own
 * expanded flag (quick menu / menus / element-switch display set it true; the
 * minimize routines set it false), so it picks the visible site automatically. */
function collectElementHud(gui: any, renderer: any): void {
    if (!netBadgeActive()) return;
    const h = gui.hook;
    const sc = ensureScreenCoords(h);
    const q = mpQuality;
    if (!q) return;
    const off = gui.selectBg ? BADGE_OFF_SELF : BADGE_OFF_SELF_MIN;
    drawDiamond(renderer, off, off, BADGE_HALF_SELF, TIER_COLORS[q.tier]);
    const pad = BADGE_HALF_SELF + BADGE_HOVER_PAD;
    hoverTargets.push({
        x: sc.x + off - pad, y: sc.y + off - pad,
        w: pad * 2, h: pad * 2, kind: 'badge',
    });
}

// --------------------------------------------------------------- DOM tooltip

/** Inject the tooltip stylesheet exactly once. */
function ensureTipStyle(): void {
    if (tipStyleInstalled) return;
    tipStyleInstalled = true;
    const style = document.createElement('style');
    style.id = 'mpNetBadgeTipStyle';
    style.textContent = `
.mpNetBadgeTip { position: fixed; z-index: 10003; padding: 4px 9px;
    background: rgba(6, 18, 30, 0.94); border: 1px solid #6fc7ff; border-radius: 4px;
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
    font-size: 12px; line-height: 1.4; white-space: nowrap; pointer-events: none;
    box-shadow: 0 0 10px rgba(111, 199, 255, 0.3); }
`;
    try {
        if (document.head) document.head.appendChild(style);
        else if (document.documentElement) document.documentElement.appendChild(style);
    } catch (_) { /* document not ready — the tooltip would fail anyway */ }
}

/** Lazily create the (single) tooltip div. Returns null when no body yet. */
function ensureTooltip(): JQuery | null {
    if (typeof document === 'undefined' || !document.body) return null;
    if (mpTooltip && document.body.contains(mpTooltip[0])) return mpTooltip;
    mpTooltip = $('<div class="mpNetBadgeTip"></div>');
    $(document.body).append(mpTooltip);
    return mpTooltip;
}

/** Show the tooltip near the mouse. `mx/my` are in gui/game coords; getDrawPos
 * converts to screen px. ROUND 30 (item 6): getDrawPos multiplies by
 * `ig.system.scale` — the scale the canvas's internal pixel buffer was sized
 * with — but the canvas's CSS box is sized independently (setCanvasSize sets
 * style.width/height and screenWidth from the window). When the two differ
 * (HiDPI / non-native window size), getDrawPos under/over-shoots by a factor
 * that grows with distance from the top-left origin — exactly the reported
 * drift. The engine's own mouse path (getMouseCoords) reads raw CSS px then
 * scales by `width/screenWidth`, so the correct game->CSS factor is
 * `screenWidth/width` — NOT `system.scale`. Recompute from the canvas's real
 * CSS rect so the tooltip tracks the cursor at any zoom/DPR. */
function showTooltip(text: string, mx: number, my: number): void {
    const tip = ensureTooltip();
    if (!tip) return;
    ensureTipStyle();
    const ui = getMpUiScale();
    let x = mx + 14 * ui, y = my + 16 * ui;
    try {
        const sys: any = (ig as any).system;
        const canvas: any = sys && sys.canvas;
        if (canvas && typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            const scaleX = (sys.width > 0 && rect.width > 0) ? rect.width / sys.width : (sys.scale || 1);
            const scaleY = (sys.height > 0 && rect.height > 0) ? rect.height / sys.height : (sys.scale || 1);
            x = rect.left + mx * scaleX + 14 * ui;
            y = rect.top + my * scaleY + 16 * ui;
        } else if (sys && typeof sys.getDrawPos === 'function') {
            x = sys.getDrawPos(mx) + 14 * ui; y = sys.getDrawPos(my) + 16 * ui;
        }
    } catch (_) { /* fall back to raw coords */ }
    // 1.71.10: the tooltip root is zoomed and Chromium multiplies authored
    // left/top, so the DESIRED CSS position is divided by the zoom factor. The
    // keep-on-screen clamp below works in real (post-zoom) CSS px.
    const setAt = (left: number, top: number): void => {
        tip.css({ left: Math.round(left / ui), top: Math.round(top / ui) }).text(text).show();
    };
    setAt(x, y);
    // Keep it fully on-screen (the tooltip is nowrap; measure after show).
    const rect = tip[0].getBoundingClientRect();
    const maxX = (window.innerWidth || document.documentElement.clientWidth) - rect.width - 4;
    const maxY = (window.innerHeight || document.documentElement.clientHeight) - rect.height - 4;
    if (rect.left > maxX || rect.top > maxY) {
        setAt(Math.max(4, Math.min(maxX, x)), Math.max(4, Math.min(maxY, y)));
    }
}

function hideTooltip(): void {
    // Z3: hide AND clear the stale content — a hidden tooltip must not keep its
    // last position/ping/loss text and re-show it after a hover gap.
    if (mpTooltip) { try { mpTooltip.hide().text(''); } catch (_) { /* ignore */ } }
}

// --------------------------------------------------------------- pump

/** One per-frame pass: refresh the cached quality and consume the hover targets
 * collected by this frame's (actually last frame's) gui draws. */
function pumpNetBadges(): void {
    let connected = false;
    try {
        const m = mpGetMain && mpGetMain();
        const conn: any = m && m.connection;
        connected = !!conn && typeof conn.isOpen === 'function' && conn.isOpen();
        if (connected && typeof conn.getNetQuality === 'function') {
            const got: INetQuality = conn.getNetQuality();
            mpQuality = got && got.known ? got : null;
        } else {
            mpQuality = null;
        }
    } catch (_) { mpQuality = null; }

    const targets = hoverTargets;
    hoverTargets = [];

    if (!connected || anyMenuOpen() || !targets.length) {
        hideTooltip();
        return;
    }

    const input: any = (ig as any).input;
    const mouse: any = input && input.mouse;
    if (!mouse || typeof mouse.x !== 'number' || typeof mouse.y !== 'number' || mouse.x < 0) {
        hideTooltip();
        return;
    }
    const mx: number = mouse.x;
    const my: number = mouse.y;

    // Topmost target wins; badges are pushed after portraits so they win overlaps.
    let hit: HoverTarget | null = null;
    for (let i = targets.length - 1; i >= 0; i--) {
        const tr = targets[i];
        if (mx >= tr.x && mx < tr.x + tr.w && my >= tr.y && my < tr.y + tr.h) { hit = tr; break; }
    }
    if (!hit) { hideTooltip(); return; }

    let text: string;
    if (hit.kind === 'badge') {
        // ROUND 30 (item 5): an off-map member's BADGE tooltip still explains why
        // the diamond is grey. The PORTRAIT tooltip (below) always shows name +
        // level — the user asked for that to never change to the room warning.
        if (hit.offMap) {
            text = t('notInSameRoom');
        } else if (hit.name) {
            // A MEMBER badge reports ONLY the teammate's own link to the server
            // (their ping, relayed ~1/s) plus the loss % — the same one-line
            // format as the self badge below. Peer report not arrived yet (or
            // our probe still unknown) -> a dash, mirroring the self tooltip.
            const peer = typeof hit.peerPing === 'number' ? Math.round(hit.peerPing) + 'ms' : '—';
            text = t('netPingLabel') + ': ' + peer + '  '
                + t('netLossLabel') + ': ' + (hit.lossPct != null ? hit.lossPct : 0) + '%';
        } else {
            const q = mpQuality;
            // 100% loss -> no answered probe -> ping unknown; show a dash instead of -1.
            const ping = q && q.ping >= 0 ? Math.round(q.ping) + 'ms' : '—';
            text = t('netPingLabel') + ': ' + ping + '  '
                + t('netLossLabel') + ': ' + (q ? q.lossPct : 0) + '%';
        }
    } else {
        text = (hit.name || '') + '  ' + t('memberLevel') + ' ' + (hit.level != null ? hit.level : '?');
    }
    showTooltip(text, mx, my);
}

/** Start the per-frame pump (idempotent). */
function startPump(): void {
    const s: any = (typeof simplify !== 'undefined') ? (simplify as any) : null;
    if (!s || typeof s.registerUpdate !== 'function') return;
    if ((s as any)._mpNetBadgeLoop) return;
    (s as any)._mpNetBadgeLoop = true;
    s.registerUpdate(() => {
        try { pumpNetBadges(); } catch (_) { /* never break the update loop */ }
    });
}

/** Install the net badges + hover tooltips. Idempotent; safe to call from main.ts
 * next to the other installers. Canvas injects are permanent (they gate on the
 * connection state every frame), so there is no teardown to run. */
export function installNetBadge(getMain: () => Multiplayer | undefined): void {
    if (installed) return;
    if (typeof sc === 'undefined' || typeof ig === 'undefined') {
        console.warn('[multiplayer] net badges: game globals missing');
        return;
    }
    installed = true;
    mpGetMain = getMain;
    const scAny: any = sc as any;
    if (!scAny.MemberHudGui || !scAny.StatusElementModeGui) {
        console.warn('[multiplayer] net badges: HUD classes not found');
        return;
    }

    scAny.MemberHudGui.inject({
        updateDrawables(this: any, renderer: any) {
            this.parent(renderer);
            try { collectMemberHud(this, renderer); } catch (_) { /* never break the HUD draw */ }
        },
    });

    scAny.StatusElementModeGui.inject({
        updateDrawables(this: any, renderer: any) {
            this.parent(renderer);
            try { collectElementHud(this, renderer); } catch (_) { /* never break the HUD draw */ }
        },
    });

    // ROUND 30 (item 5): the off-map bar hide now lives in collectMemberHud (zero
    // the hpExpSpGui/hpBar/spBar hooks' localAlpha — the engine's draw gate skips
    // a hook's draw entirely at localAlpha 0, and unlike a single updateDrawables
    // skip it hides the CHILD bar guis too, which is what was still showing). The
    // old skip-in-updateDrawables approach only hid the background frame.
    startPump();
}
