/**
 * 1.72.0 (user request): death-wait indicator — replaces the old countdown TEXT
 * prompt with a combat-rank-style glowing LINE.
 *
 * Look: modelled on the engine's combat HUD top line (sc.CombatUpperHud) — a
 * 2px additive ("lighter" composition) colored line over a dimmer underlay.
 * Geometry: centered horizontally, floating at 1/3 of the screen height from
 * the top, total width 1/3 of the screen width.
 *
 * Behaviour:
 *  - Countdown: the line's two ends FLOW from the outer edges toward the
 *    center as the revive timer runs (displayP 0 -> 1). Traveling shimmer
 *    dashes reinforce the inward flow. When the ends meet at the center the
 *    timer has elapsed and the caller revives the player.
 *  - Fast shrink (combat-end quick revive AND party wipe): the line collapses
 *    to the center with an ease-IN curve (accelerating, never linear), then
 *    fires onDone — the caller executes the revive / team-wipe logic exactly
 *    when the collapse lands.
 *  - Center icon: a white pixel-art HEART that pulses gently. On party wipe it
 *    fluidly morphs into a white pixel-art SKULL (per-pixel eased migration).
 *
 * Rendered inside the game canvas via ig.GuiElementBase.updateDrawables so it
 * zooms with the engine HUD like the combat rank line does. Every engine touch
 * is defensive: if creation fails the caller falls back to the legacy text.
 */

// ------------------------------------------------------------- pixel art

/** 11x9 white pixel heart (1 = lit). Center column is index 5. */
const HEART = [
    '.XXX...XXX.',
    'XXXXX.XXXXX',
    'XXXXXXXXXXX',
    'XXXXXXXXXXX',
    '.XXXXXXXXX.',
    '..XXXXXXX..',
    '...XXXXX...',
    '....XXX....',
    '.....X.....',
];

/** 11x10 white pixel skull (1 = lit). Center column is index 5. */
const SKULL = [
    '...XXXXX...',
    '..XXXXXXX..',
    '.XXXXXXXXX.',
    '.XX..X..XX.',
    '.XX..X..XX.',
    '.XXXXXXXXX.',
    '..XXXXXXX..',
    '...X.X.X...',
    '...XXXXX...',
    '....XXX....',
];

interface Px { x: number; y: number }

function gridPixels(rows: string[]): Px[] {
    const out: Px[] = [];
    const h = rows.length;
    const w = rows[0].length;
    for (let gy = 0; gy < h; gy++) {
        for (let gx = 0; gx < w; gx++) {
            if (rows[gy].charCodeAt(gx) === 88 /* X */) {
                out.push({ x: gx - (w - 1) / 2, y: gy - (h - 1) / 2 });
            }
        }
    }
    return out;
}

/** Greedy nearest-neighbour morph assignment (heart pixel -> skull pixel).
 *  Precomputed once; sizes are tiny (50-60 px) so O(n^2) is free. */
interface MorphMap { pairs: { h: Px, s: Px }[]; skullOnly: Px[]; heartOnly: Px[] }
let morphMap: MorphMap | null = null;
function getMorphMap(): MorphMap {
    if (morphMap) return morphMap;
    const heart = gridPixels(HEART);
    const skull = gridPixels(SKULL);
    const used = new Array(skull.length).fill(false);
    const pairs: { h: Px, s: Px }[] = [];
    const heartOnly: Px[] = [];
    for (const h of heart) {
        let best = -1; let bestD = Infinity;
        for (let i = 0; i < skull.length; i++) {
            if (used[i]) continue;
            const dx = skull[i].x - h.x; const dy = skull[i].y - h.y;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
        }
        if (best >= 0) { used[best] = true; pairs.push({ h, s: skull[best] }); }
        else heartOnly.push(h);
    }
    const skullOnly: Px[] = [];
    for (let i = 0; i < skull.length; i++) if (!used[i]) skullOnly.push(skull[i]);
    morphMap = { pairs, skullOnly, heartOnly };
    return morphMap;
}

// ------------------------------------------------------------- easing

function easeInCubic(k: number): number { return k * k * k; }
function easeInOutCubic(k: number): number {
    return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

// ------------------------------------------------------------- the HUD

export interface DeathLineHud {
    /** Countdown mode: set the flow target 0..1 (line ends converge on 1). */
    setTarget(p: number): void;
    /** Switch to the eased fast collapse; onDone fires exactly once when the
     *  line reaches the center. */
    startShrink(onDone: () => void): void;
    /** Abort a running shrink (wipe cancelled / combat re-started) and return
     *  to countdown mode at the current display position. */
    cancelShrink(): void;
    /** Heart <-> skull morph target (party wipe). */
    setWipe(wipe: boolean): void;
    /** Remove the GUI. */
    dispose(): void;
}

const SHRINK_SECONDS = 0.8;   // eased collapse duration (both fast modes)
const MORPH_SECONDS = 0.7;    // heart -> skull migration
const ICON_SCALE = 2;         // gui units per icon pixel

export function createDeathLineHud(): DeathLineHud | null {
    try {
        const igAny: any = ig as any;
        if (!igAny || !igAny.GuiElementBase || !igAny.gui) return null;

        const Cls = igAny.GuiElementBase.extend({
            // animation state
            displayP: 0, targetP: 0,
            mode: 'countdown',           // 'countdown' | 'shrink'
            shrinkT: 0, shrinkFrom: 0, onDoneCb: null,
            morphP: 0, morphTarget: 0,
            pulseT: 0, shimmerT: 0,

            init: function (this: any) {
                this.parent();
                this.setSize(igAny.system.width, igAny.system.height);
                this.hook.zIndex = 3000; // same layer the old death text used
            },

            update: function (this: any) {
                this.parent();
                const tick = igAny.system.actualTick || 0;
                this.pulseT += tick;
                this.shimmerT += tick;
                // Keep covering the screen across window resizes.
                if (this.hook.size.x !== igAny.system.width || this.hook.size.y !== igAny.system.height) {
                    this.setSize(igAny.system.width, igAny.system.height);
                }
                // Heart <-> skull migration.
                const mDir = this.morphTarget - this.morphP;
                if (mDir !== 0) {
                    const step = tick / MORPH_SECONDS;
                    this.morphP = Math.abs(mDir) <= step ? this.morphTarget : this.morphP + Math.sign(mDir) * step;
                }
                // Eased fast collapse.
                if (this.mode === 'shrink') {
                    this.shrinkT += tick;
                    let k = this.shrinkT / SHRINK_SECONDS;
                    if (k > 1) k = 1;
                    this.displayP = this.shrinkFrom + (1 - this.shrinkFrom) * easeInCubic(k);
                    if (k >= 1 && this.onDoneCb) {
                        const cb = this.onDoneCb;
                        this.onDoneCb = null;   // fire exactly once
                        try { cb(); } catch (_) { /* caller logic must survive */ }
                    }
                } else {
                    this.displayP = this.targetP;
                }
            },

            updateDrawables: function (this: any, r: any) {
                const w = igAny.system.width;
                const h = igAny.system.height;
                const cx = Math.floor(w / 2);
                const ly = Math.floor(h / 3);
                const totalW = Math.floor(w / 3);
                const half = (totalW / 2) * (1 - this.displayP);

                // ---- the line (combat-rank style: additive glow over dim base,
                // FADED tips: both outer ends taper out over ~10 gui units in three
                // alpha steps instead of ending with a hard cut).
                if (half > 0.5) {
                    const taper = Math.min(10, Math.max(0, half - 1));
                    const bodyW = half - taper; // half-width of the solid body
                    // alpha-stepped tip segment helper (mirrored on both sides)
                    const drawSpan = (color: string, y: number, hgt: number, lighter: boolean, tipScale: number) => {
                        if (bodyW > 0) {
                            const d = r.addColor(color, Math.round(cx - bodyW), y, Math.round(bodyW * 2), hgt);
                            if (lighter) d.setCompositionMode('lighter');
                        }
                        if (taper > 0) {
                            const steps = 3;
                            const segW = taper / steps;
                            for (let i = 0; i < steps; i++) {
                                const a = ((i + 1) / (steps + 1)) * tipScale; // tip -> body ramp (0.25/0.5/0.75)
                                r.addTransform().setAlpha(a);
                                const lx = Math.round(cx - half + i * segW);
                                const rx = Math.round(cx + half - (i + 1) * segW);
                                const sw = Math.max(1, Math.round(segW) + 1); // +1 hides sub-pixel seams
                                const dl = r.addColor(color, lx, y, sw, hgt);
                                if (lighter) dl.setCompositionMode('lighter');
                                const dr = r.addColor(color, rx, y, sw, hgt);
                                if (lighter) dr.setCompositionMode('lighter');
                                r.undoTransform();
                            }
                        }
                    };
                    r.addTransform().setAlpha(0.35);
                    drawSpan('#40060c', ly - 1, 4, false, 1);
                    r.undoTransform();
                    drawSpan('#b0001d', ly, 2, true, 1);
                    drawSpan('#ff4438', ly, 1, true, 1);
                    // Flowing shimmer: bright dashes travel from both ends toward
                    // the center (two phases per side so the flow never gaps).
                    if (half > 12) {
                        const speed = half * 1.6; // gui units per second
                        for (let phase = 0; phase < 2; phase++) {
                            const s = ((this.shimmerT * speed + phase * half) % (2 * half)) / 2;
                            const dash = Math.min(8, half * 0.2);
                            // left dash moving right, right dash moving left
                            r.addColor('#ffd9d5', Math.round(cx - half + s), ly, dash, 2).setCompositionMode('lighter');
                            r.addColor('#ffd9d5', Math.round(cx + half - s - dash), ly, dash, 2).setCompositionMode('lighter');
                        }
                    }
                }

                // ---- center icon (white pixel heart <-> skull)
                const map = getMorphMap();
                const e = easeInOutCubic(this.morphP);
                const pulse = 1 + 0.07 * Math.sin(this.pulseT * 5);
                const S = ICON_SCALE * pulse;
                const size = Math.max(1, Math.ceil(S));
                // Collect the final per-pixel positions once so the glow pass can
                // follow the icon's SHAPE (a plain rect behind the icon read as a
                // visible square backing — the user report).
                const pts: { x: number, y: number, a: number }[] = [];
                for (const pr of map.pairs) {
                    pts.push({ x: pr.h.x + (pr.s.x - pr.h.x) * e, y: pr.h.y + (pr.s.y - pr.h.y) * e, a: 1 });
                }
                for (const p of map.skullOnly) pts.push({ x: p.x, y: p.y, a: e });      // fade in
                for (const p of map.heartOnly) pts.push({ x: p.x, y: p.y, a: 1 - e });  // fade out
                // Per-pixel soft halo (additive, one gui unit around each lit
                // pixel) — pixel-shaped glow, never a square.
                let haloOpen = false;
                let haloAlpha = -1;
                for (const p of pts) {
                    if (p.a <= 0.05) continue;
                    const a = Math.round(0.2 * p.a * 20) / 20;
                    if (a !== haloAlpha) {
                        if (haloOpen) r.undoTransform();
                        r.addTransform().setAlpha(a);
                        haloAlpha = a; haloOpen = true;
                    }
                    r.addColor('#ffffff', Math.round(cx + p.x * S) - 1, Math.round(ly + p.y * S) - 1, size + 2, size + 2)
                        .setCompositionMode('lighter');
                }
                if (haloOpen) r.undoTransform();
                // Solid pixels on top.
                for (const p of pts) {
                    if (p.a <= 0.01) continue;
                    if (p.a >= 0.99) {
                        r.addColor('#ffffff', Math.round(cx + p.x * S), Math.round(ly + p.y * S), size, size);
                    } else {
                        r.addTransform().setAlpha(p.a);
                        r.addColor('#ffffff', Math.round(cx + p.x * S), Math.round(ly + p.y * S), size, size);
                        r.undoTransform();
                    }
                }
            },
        });

        const gui = new Cls();
        igAny.gui.addGuiElement(gui);

        const api: DeathLineHud = {
            setTarget(p: number): void {
                try { gui.targetP = p < 0 ? 0 : (p > 1 ? 1 : p); } catch (_) { /* ignore */ }
            },
            startShrink(onDone: () => void): void {
                try {
                    if (gui.mode === 'shrink') { gui.onDoneCb = onDone; return; }
                    gui.mode = 'shrink';
                    gui.shrinkT = 0;
                    gui.shrinkFrom = gui.displayP;
                    gui.onDoneCb = onDone;
                } catch (_) { /* ignore */ }
            },
            cancelShrink(): void {
                try {
                    if (gui.mode !== 'shrink') return;
                    gui.mode = 'countdown';
                    gui.onDoneCb = null;
                    gui.targetP = gui.displayP; // resume the flow from here
                } catch (_) { /* ignore */ }
            },
            setWipe(wipe: boolean): void {
                try { gui.morphTarget = wipe ? 1 : 0; } catch (_) { /* ignore */ }
            },
            dispose(): void {
                try { gui.remove(); } catch (_) { /* ignore */ }
            },
        };
        return api;
    } catch (_) {
        return null;
    }
}
