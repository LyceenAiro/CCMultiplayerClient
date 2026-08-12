import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';

/**
 * In-game multiplayer helpers: the F8 command box and party-invite toasts.
 *
 * NOTE: the old L-key friends overlay was removed — friends and room players now
 * live in the game's native Social menu (see ui/socialMenuInject.ts). This class
 * only keeps the pieces that have no native-menu home: the F8 command box and the
 * party-invite "comm call" dialog.
 */
export class SocialOverlay {
    /** Currently open comm-invite dialog (one at a time). */
    private commBox: JQuery | null = null;
    private commTimer: number | null = null;
    /** Round 24: cached in-game comm notification sound (calling.ogg — the ring the
     * engine plays on an incoming bot comm message). Reused across invites like the
     * game reuses its own sound objects. */
    private commRing: any = null;

    constructor(private main: Multiplayer) { }

    /** Process-level wiring (F8 key + update pump). Safe to call on every connect —
     * the bindings stack-guard themselves. Connection-bound callbacks (party invite)
     * live in wireConnection() because reconnects swap the socket. */
    public registerOnce(): void {
        if ((this.main as any)._overlayOnceInstalled) return;
        (this.main as any)._overlayOnceInstalled = true;
        const input = ig.input as any;
        // F8 opens the in-game command box (run mp.* commands without DevTools).
        const f8 = (ig.KEY as any).F8 !== undefined ? (ig.KEY as any).F8 : 119;
        input.bind(f8, 'mpcmd');
        simplify.registerUpdate(() => {
            if (input.pressed('mpcmd')) {
                this.toggleCommandBox();
            }
        });
    }

    /** Connection-bound wiring. MUST run on every connect: the socket (and thus the
     * on* listeners) is recreated per session — binding once to the first
     * connection is why party invites died after logout/re-login (round 7). */
    public wireConnection(): void {
        const conn = this.main.connection;
        conn.onPartyInvite((from, partyId) => {
            // Round 19: while the LOCAL player is in a cutscene, party invites are
            // auto-declined — the comm dialog would fight the story UI mid-sequence.
            try {
                const mdl: any = (sc as any).model;
                if (mdl && typeof mdl.isCutscene === 'function' && mdl.isCutscene()) {
                    try { conn.partyDecline(partyId); } catch (_) { /* ignore */ }
                    this.showToast(t('inviteBusy'));
                    return;
                }
            } catch (_) { /* ignore */ }
            // Immersive presentation: an in-game-style COMM window (like the
            // game's dialog/comms UI) instead of a bare black box.
            this.showCommInvite(from, partyId);
        });
    }

    /** Round 19: a transient, non-modal toast (used for the cutscene auto-decline
     * and teleport-refusal feedback). Auto-removes after 3s; never steals focus.
     * Round 24: styled as .mpCommToast (NOT .mpToast) so the top-right stacked
     * toasts from ui/toasts.ts can never be overridden to render center-screen. */
    public showToast(message: string): void {
        try {
            this.ensureCommStyle();
            const box = $('<div class="mpCommToast"></div>');
            box.text(String(message));
            $(document.body).append(box);
            window.setTimeout(() => { box.remove(); }, 3000);
        } catch (_) { /* a toast must never break the caller */ }
    }

    /** Round 24: play the in-game comm notification ring — the same calling.ogg the
     * engine plays on an incoming bot comm message. Copied idiom: the game caches
     * `new ig.Sound(path, volume)` on the GUI and calls `.play(loop)`; we play a
     * single (non-looping) iteration. Guarded — a missing/blocked sound must never
     * break the invite. */
    private playInviteRing(): void {
        try {
            if (!this.commRing) this.commRing = new (ig as any).Sound('media/sound/hud/calling.ogg', 1);
            this.commRing.play(false);
        } catch (_) { /* a sound must never break the invite */ }
    }

    // ---- immersive comm-call invite dialog ----

    /** Inject the comm-dialog stylesheet exactly once. */
    private ensureCommStyle(): void {
        if (document.getElementById('mpCommStyle')) return;
        const style = document.createElement('style');
        style.id = 'mpCommStyle';
        style.textContent = `
/* Round 23 wave 3: the party invite popup now lives on the RIGHT side, vertically
   centered (like LoL's surrender-vote box) instead of bottom-center. Same navy/
   cyan palette as the login panel; the draining bar auto-declines at 20s.
   Round 24: the popup is simplified — a single message line + the two buttons +
   the draining bar (the old blinking header is gone). The transient cutscene/
   teleport toast uses .mpCommToast (NOT .mpToast) so it can never hijack the
   top-right stacked toasts from ui/toasts.ts (round-24 cascade fix). */
.mpComm {
    position: fixed; right: 24px; top: 50%;
    transform: translateY(-50%);
    width: 340px; max-width: 92vw;
    background: rgba(6, 18, 30, 0.94);
    border: 2px solid #6fc7ff; border-radius: 6px;
    box-shadow: 0 0 18px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    z-index: 10000; padding: 14px 16px;
    animation: mpCommIn 0.22s ease-out;
}
@keyframes mpCommIn { from { opacity: 0; transform: translateY(26px); }
                      to   { opacity: 1; transform: translateY(0); } }
.mpCommMsg { font-size: 14px; line-height: 1.55; margin-bottom: 12px; color: #eaf7ff; }
.mpCommBtns { display: flex; justify-content: flex-end; gap: 10px; }
.mpCommBtn { min-width: 96px; padding: 5px 14px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #dff3ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 13px; font-family: inherit; letter-spacing: 1px; }
.mpCommBtn:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpCommBtn.mpPrimary { background: rgba(31, 111, 74, 0.9); border-color: #7dffa8; color: #eafff2; }
.mpCommBtn.mpPrimary:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }
/* Reverse progress bar: starts FULL and drains over the 20s window; when it empties
   the invite auto-declines (the JS setTimeout in showCommInvite). */
.mpCommBar { height: 6px; margin-top: 12px; background: rgba(111,199,255,0.25); border-radius: 3px; overflow: hidden; }
.mpCommBarFill { height: 100%; width: 100%; background: linear-gradient(90deg, #6fc7ff, #7dffa8);
    animation: mpCommCountdown 20s linear forwards; }
@keyframes mpCommCountdown { from { width: 100%; } to { width: 0%; } }
.mpCommToast { position: fixed; left: 50%; top: 22%; transform: translateX(-50%);
    max-width: 80vw; padding: 8px 16px; z-index: 10001;
    background: rgba(6, 18, 30, 0.94); border: 1px solid #6fc7ff; border-radius: 4px;
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    font-size: 13px; text-align: center; pointer-events: none;
    box-shadow: 0 0 14px rgba(111,199,255,0.3); }
`;
        document.head.appendChild(style);
    }

    /** Round 23 wave 3: right-side party invite (LoL-style surrender-vote box).
     * Round 24: simplified — ONE message line + 接受/拒绝 + a reverse progress bar
     * draining over 20s. When it empties -> auto-decline + close (same decline logic
     * as before). One popup at a time — a new invite replaces the old
     * (closeComm(true) first). Non-blocking: the player can keep playing while it's up. */
    private showCommInvite(from: string, partyId: string): void {
        this.closeComm(true);
        this.ensureCommStyle();
        const conn = this.main.connection;
        const box = $('<div class="mpComm"></div>');
        // Round 24: the header (blinking dot + title + caller line) is gone — the
        // popup is just the message, the two buttons and the draining bar.
        const msg = $('<div class="mpCommMsg"></div>').text(t('commInviteSimple').replace('{name}', from));
        box.append(msg);
        box.append('<div class="mpCommBtns"></div>');
        box.append('<div class="mpCommBar"><div class="mpCommBarFill"></div></div>');
        const btns = box.find('.mpCommBtns');
        const accept = $('<button class="mpCommBtn mpPrimary">' + t('commAccept') + '</button>');
        const decline = $('<button class="mpCommBtn">' + t('commDecline') + '</button>');
        accept.on('click', () => { conn.partyAccept(partyId); this.closeComm(); });
        decline.on('click', () => { conn.partyDecline(partyId); this.closeComm(); });
        btns.append(accept).append(decline);
        $(document.body).append(box);
        this.commBox = box;
        // Round 24: the in-game comm notification ring — the same calling.ogg the
        // engine plays on an incoming bot comm message (ig.EVENT_STEP.RING_PRIVATE_MSG
        // -> sc.model.message.ringPrivateMessage -> PrivateMessageBGGui sound.incoming).
        // Played ONCE, only now that the popup is actually up.
        this.playInviteRing();
        // Non-blocking: do NOT steal the game's focus (like LoL's vote box) — the
        // player can keep moving while the invite is up.
        // Reverse countdown: the draining bar empties over 20s (CSS matches), then
        // auto-decline + close.
        this.commTimer = window.setTimeout(() => {
            try { conn.partyDecline(partyId); } catch (_) { /* ignore */ }
            this.closeComm();
        }, 20000);
    }

    /** Close the comm dialog. silent=true skips the focus restore (a replacement
     * dialog immediately takes over focus). */
    private closeComm(silent?: boolean): void {
        if (this.commTimer !== null) { clearTimeout(this.commTimer); this.commTimer = null; }
        if (this.commBox) { this.commBox.remove(); this.commBox = null; }
        if (!silent) ig.system.regainFocus();
    }

    // ---- in-game command box (F8) ----
    private cmdBox: JQuery | null = null;

    public toggleCommandBox(): void {
        if (this.cmdBox) {
            this.cmdBox.remove();
            this.cmdBox = null;
            ig.system.regainFocus();
            return;
        }
        this.cmdBox = $('<div class="gameOverlayBox gamecodeMessage"><h3>' + t('cmdBoxTitle') + '</h3></div>');
        const form = $('<form><input type="text" placeholder="skipPrologue / saveHere / boost / friends" style="width:90%" /></form>');
        this.cmdBox.append(form);
        $(document.body).append(this.cmdBox);
        this.cmdBox.addClass('shown');
        ig.system.setFocusLost();
        form.submit(() => {
            const cmd = String(form.find('input[type=text]').val() || '').trim();
            form.find('input[type=text]').val('');
            if (cmd) {
                this.main.runCommand(cmd);
            }
            return false;
        });
        form.find('input[type=text]').focus();
    }
}
