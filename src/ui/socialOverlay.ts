import { Multiplayer } from '../multiplayer';

/**
 * In-game multiplayer helpers: the F8 command box and party-invite toasts.
 *
 * NOTE: the old L-key friends overlay was removed — friends and room players now
 * live in the game's native Social menu (see ui/socialMenuInject.ts). This class
 * only keeps the pieces that have no native-menu home: the F8 command box and the
 * "X 邀请你组队" accept/decline toast.
 */
export class SocialOverlay {
    constructor(private main: Multiplayer) { }

    public register(): void {
        const input = ig.input as any;
        // F8 opens the in-game command box (run mp.* commands without DevTools).
        const f8 = (ig.KEY as any).F8 !== undefined ? (ig.KEY as any).F8 : 119;
        input.bind(f8, 'mpcmd');
        simplify.registerUpdate(() => {
            if (input.pressed('mpcmd')) {
                this.toggleCommandBox();
            }
        });

        const conn = this.main.connection;
        conn.onPartyInvite((from, partyId) => {
            this.flash(from + ' 邀请你组队！', [
                { label: '接受', cb: () => conn.partyAccept(partyId) },
                { label: '拒绝', cb: () => conn.partyDecline(partyId) },
            ]);
        });
    }

    /** Toast for an incoming FRIEND request (accept makes the friendship mutual). */
    public friendRequestToast(from: string): void {
        const conn = this.main.connection;
        this.flash(from + ' 请求添加你为好友', [
            { label: '接受', cb: () => conn.friendAccept(from) },
            { label: '拒绝', cb: () => conn.friendDecline(from) },
        ]);
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
        this.cmdBox = $('<div class="gameOverlayBox gamecodeMessage"><h3>命令 (回车执行 / F8 关闭)</h3></div>');
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

    /** A transient message box with action buttons (used for party invites). */
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
