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
    private commTypeTimer: number | null = null;

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
     * and teleport-refusal feedback). Auto-removes after 3s; never steals focus. */
    public showToast(message: string): void {
        try {
            this.ensureCommStyle();
            const box = $('<div class="mpToast"></div>');
            box.text(String(message));
            $(document.body).append(box);
            window.setTimeout(() => { box.remove(); }, 3000);
        } catch (_) { /* a toast must never break the caller */ }
    }

    /** Toast for an incoming FRIEND request (accept makes the friendship mutual). */
    public friendRequestToast(from: string): void {
        const conn = this.main.connection;
        this.flash(from + t('friendRequestSuffix'), [
            { label: t('accept'), cb: () => conn.friendAccept(from) },
            { label: t('decline'), cb: () => conn.friendDecline(from) },
        ]);
    }

    // ---- immersive comm-call invite dialog ----

    /** Inject the comm-dialog stylesheet exactly once. */
    private ensureCommStyle(): void {
        if (document.getElementById('mpCommStyle')) return;
        const style = document.createElement('style');
        style.id = 'mpCommStyle';
        style.textContent = `
.mpComm {
    position: fixed; left: 50%; bottom: 14%;
    transform: translateX(-50%);
    width: 560px; max-width: 92vw;
    background: rgba(6, 18, 30, 0.94);
    border: 2px solid #6fc7ff; border-radius: 6px;
    box-shadow: 0 0 18px rgba(111, 199, 255, 0.35), inset 0 0 26px rgba(13, 42, 66, 0.8);
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    z-index: 10000; padding: 12px 16px 14px 16px;
    animation: mpCommIn 0.22s ease-out;
}
@keyframes mpCommIn { from { opacity: 0; transform: translateX(-50%) translateY(26px); }
                      to   { opacity: 1; transform: translateX(-50%) translateY(0); } }
.mpCommHead { display: flex; align-items: center; gap: 8px;
    border-bottom: 1px solid rgba(111,199,255,0.4); padding-bottom: 6px; margin-bottom: 10px; }
.mpCommDot { width: 9px; height: 9px; border-radius: 50%; background: #7dffa8;
    box-shadow: 0 0 8px #7dffa8; animation: mpBlink 1.1s infinite; }
@keyframes mpBlink { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }
.mpCommTag { font-size: 11px; letter-spacing: 2px; color: #8fd6ff; }
.mpCommFrom { margin-left: auto; font-size: 12px; color: #bfe8ff; }
.mpCommBody { display: flex; gap: 12px; align-items: flex-start; }
.mpCommAvatar { flex: 0 0 46px; width: 46px; height: 46px; border-radius: 50%;
    background: linear-gradient(135deg, #2c5d7c, #123248);
    border: 2px solid #6fc7ff; color: #dff3ff;
    font-size: 22px; font-weight: bold; text-align: center; line-height: 44px; }
.mpCommMsg { flex: 1 1 auto; font-size: 14px; line-height: 1.55; min-height: 44px; color: #eaf7ff; }
.mpCommMsg .mpCaret { display: inline-block; width: 7px; background: #8fd6ff;
    animation: mpBlink 0.8s infinite; }
.mpCommBtns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; }
.mpCommBtn { min-width: 96px; padding: 5px 14px; cursor: pointer;
    background: rgba(18, 50, 72, 0.9); color: #dff3ff;
    border: 1px solid #6fc7ff; border-radius: 4px;
    font-size: 13px; font-family: inherit; letter-spacing: 1px; }
.mpCommBtn:hover { background: rgba(46, 104, 142, 0.95); box-shadow: 0 0 8px rgba(111,199,255,0.6); }
.mpCommBtn.mpPrimary { background: rgba(31, 111, 74, 0.9); border-color: #7dffa8; color: #eafff2; }
.mpCommBtn.mpPrimary:hover { background: rgba(41, 148, 99, 0.95); box-shadow: 0 0 8px rgba(125,255,168,0.6); }
.mpCommBar { height: 3px; margin-top: 10px; background: rgba(111,199,255,0.25); border-radius: 2px; overflow: hidden; }
.mpCommBarFill { height: 100%; width: 100%; background: #6fc7ff;
    animation: mpCommCountdown 20s linear forwards; }
@keyframes mpCommCountdown { from { width: 100%; } to { width: 0%; } }
.mpToast { position: fixed; left: 50%; top: 22%; transform: translateX(-50%);
    max-width: 80vw; padding: 8px 16px; z-index: 10001;
    background: rgba(6, 18, 30, 0.94); border: 1px solid #6fc7ff; border-radius: 4px;
    color: #eaf7ff; font-family: 'Noto Sans SC', 'Segoe UI', sans-serif;
    font-size: 13px; text-align: center; pointer-events: none;
    box-shadow: 0 0 14px rgba(111,199,255,0.3); }
`;
        document.head.appendChild(style);
    }

    /** In-game COMM-style party invite: portrait + typewriter message + accept/decline,
     * auto-declines after 20s. Replaces a previous invite if one is still open. */
    private showCommInvite(from: string, partyId: string): void {
        this.closeComm(true);
        this.ensureCommStyle();
        const conn = this.main.connection;
        const box = $('<div class="mpComm"></div>');
        const initial = (from || '?').charAt(0).toUpperCase();
        box.append(
            '<div class="mpCommHead"><span class="mpCommDot"></span>'
            + '<span class="mpCommTag">' + t('commIncoming') + '</span>'
            + '<span class="mpCommFrom">' + t('commFrom') + $('<i>').text(from).html() + '</span></div>'
            + '<div class="mpCommBody">'
            + '<div class="mpCommAvatar">' + $('<i>').text(initial).html() + '</div>'
            + '<div class="mpCommMsg"><span class="mpCommText"></span><span class="mpCaret">&nbsp;</span></div>'
            + '</div>'
            + '<div class="mpCommBtns"></div>'
            + '<div class="mpCommBar"><div class="mpCommBarFill"></div></div>');
        const btns = box.find('.mpCommBtns');
        const accept = $('<button class="mpCommBtn mpPrimary">' + t('commAccept') + '</button>');
        const decline = $('<button class="mpCommBtn">' + t('commDecline') + '</button>');
        accept.on('click', () => { conn.partyAccept(partyId); this.closeComm(); });
        decline.on('click', () => { conn.partyDecline(partyId); this.closeComm(); });
        btns.append(accept).append(decline);
        $(document.body).append(box);
        this.commBox = box;
        ig.system.setFocusLost();
        // Typewriter message.
        const text = from + t('commInviteMsg');
        const msgEl = box.find('.mpCommText');
        let i = 0;
        this.commTypeTimer = window.setInterval(() => {
            i++;
            msgEl.text(text.slice(0, i));
            if (i >= text.length) {
                if (this.commTypeTimer !== null) { clearInterval(this.commTypeTimer); this.commTypeTimer = null; }
                box.find('.mpCaret').remove();
            }
        }, 45);
        // Auto-decline after 20s (matches the CSS countdown bar).
        this.commTimer = window.setTimeout(() => {
            try { conn.partyDecline(partyId); } catch (_) { /* ignore */ }
            this.closeComm();
        }, 20000);
    }

    /** Close the comm dialog. silent=true skips the focus restore (a replacement
     * dialog immediately takes over focus). */
    private closeComm(silent?: boolean): void {
        if (this.commTimer !== null) { clearTimeout(this.commTimer); this.commTimer = null; }
        if (this.commTypeTimer !== null) { clearInterval(this.commTypeTimer); this.commTypeTimer = null; }
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

    /** A transient message box with action buttons (used for friend requests). */
    private flash(message: string, buttons: Array<{ label: string, cb: () => void }>): void {
        const box = $('<div class="gameOverlayBox gamecodeMessage"></div>');
        box.append('<b>' + message + '</b><br>');
        for (const b of buttons) {
            const btn = $('<button>' + b.label + '</button>');
            btn.on('click', () => { b.cb(); box.remove(); ig.system.regainFocus(); });
            box.append(btn);
        }
        $(document.body).append(box);
        box.addClass('shown');
        ig.system.setFocusLost();
    }
}
