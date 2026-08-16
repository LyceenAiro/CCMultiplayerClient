import { IConnection } from '../connection';
import { t } from '../i18n';
import { showMpToast } from '../ui/toasts';

/**
 * 1.70.61 剧情同步模式 (Story Sync Mode)
 *
 * Closed-loop design:
 *  - Party LEADER picks an in-progress quest in the quest menu; the server asks
 *    every member's client (leader included) to confirm quest active-or-solved.
 *  - When the server raises the mode, EVERY client snapshots its whole quest
 *    block (`sc.quests.onStorageSave`), the leader streams its authoritative
 *    {task, highest, completed, labels} progress and every unfinished member
 *    applies it live. While the mode is active a quest-save guard replaces the
 *    quest block in every local save with the snapshot, so mid-sync progress
 *    can NEVER persist from a crash/logout/save.
 *  - Story triggers are leader-authoritative: EventTrigger / LocationEvent
 *    ready-check waits until every remaining member's mirror is within 320px
 *    of the trigger, then the leader starts the engine event and relays
 *    {map, key, kind, type}; members replay the SAME local event while their
 *    own trigger starts are suppressed. Skip votes require every member's yes.
 *  - Exit matrix:
 *      complete   -> apply final state, keep completion, one native reward for
 *                    members who hadn't solved it, stop the save guard;
 *      cancel / leaderLeft / leave / partyEnd -> restore the snapshot;
 *      a member leaving/kicked affects only that member; others keep syncing.
 */

const GATHER_RADIUS = 320;
const GATHER_Z_DELTA = 96;
const STATE_SEND_INTERVAL = 0.25;   // seconds — leader quest-state coalescing
const STATE_HEARTBEAT = 1.5;        // seconds — periodic re-send for self-heal
const NUDGE_PROMPT_COOLDOWN = 8000; // ms — don't spam the waiting popup
const CHECK_LOCAL_TIMEOUT = 17000;  // ms — belt-and-braces vs the server's 15s
const SUPPRESS_TOAST_COOLDOWN = 4000;

interface IStorySyncButton {
	label: string;
	kind?: 'primary' | 'danger' | 'ghost';
	onClick: () => void;
}

/** Minimal full-screen modal in the same visual language as the mod's other
 * windows. Choice-only where the caller says so (skip votes never time out). */
function storyWindow(title: string, bodyHtml: string, buttons: IStorySyncButton[], dismissable: boolean): { close: () => void } {
	if (typeof document === 'undefined' || !document.body) { return { close: () => { /* nothing to close */ } }; }
	closeStoryWindows();
	const scrim = $('<div class="mpStoryScrim"></div>');
	const box = $('<div class="mpStoryBox"></div>');
	const head = $('<div class="mpStoryHead"></div>').text(title);
	const body = $('<div class="mpStoryBody"></div>').html(bodyHtml);
	const row = $('<div class="mpStoryBtns"></div>');
	box.append(head, body, row);
	for (const b of buttons) {
		const btn = $('<button class="mpStoryBtn ' + (b.kind === 'danger' ? 'danger' : b.kind === 'ghost' ? 'ghost' : 'primary') + '"></button>').text(b.label);
		btn.on('click', () => {
			try { b.onClick(); } finally {
				try { closeStoryWindows(); } catch (_) { /* ignore */ }
			}
		});
		row.append(btn);
	}
	if (dismissable) {
		const close = $('<button class="mpStoryClose">×</button>');
		close.on('click', () => { try { closeStoryWindows(); } catch (_) { /* ignore */ } });
		box.append(close);
	}
	scrim.on('mousedown', () => {
		if (!dismissable) return; // choice-only: outside click must not leak a click
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
	});
	scrim.append(box);
	$(document.body).append(scrim);
	return { close: () => { try { closeStoryWindows(); } catch (_) { /* ignore */ } } };
}

function closeStoryWindows(): void {
	try { $('.mpStoryScrim').remove(); } catch (_) { /* ignore */ }
}

/** Inject the story-window stylesheet exactly once. */
let stylesInstalled = false;
export function ensureStorySyncStyle(): void {
	if (stylesInstalled || typeof document === 'undefined') return;
	stylesInstalled = true;
	const style = document.createElement('style');
	style.textContent = `
.mpStoryScrim { position: fixed; inset: 0; z-index: 10010;
	background: rgba(0,0,0,0.62); animation: mpStoryFade 0.15s ease-out; }
.mpStoryBox { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%);
	width: min(680px, 92vw); background: rgba(6,18,30,0.96);
	border: 1px solid #6fc7ff; border-radius: 6px; padding: 20px 24px 18px;
	color: #eaf7ff; font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif;
	box-shadow: 0 0 24px rgba(111,199,255,0.4), inset 0 0 30px rgba(13,42,66,0.7); }
.mpStoryHead { font-size: 17px; font-weight: bold; letter-spacing: 1px;
	color: #b8ecff; margin-bottom: 10px; padding-right: 26px; }
.mpStoryBody { font-size: 14px; line-height: 1.6; color: #dff3ff; white-space: pre-line; }
.mpStoryBtns { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; }
.mpStoryBtn { min-width: 124px; padding: 9px 18px; border-radius: 4px; cursor: pointer;
	background: #155a86; border: 1px solid #6fc7ff; color: #eaf7ff; font-size: 14px; }
.mpStoryBtn:hover { background: #1d79b7; }
.mpStoryBtn.danger { background: #5c1f28; border-color: #ff8e9f; color: #ffe3e7; }
.mpStoryBtn.danger:hover { background: #7c2a36; }
.mpStoryBtn.ghost { background: #172a3a; border-color: #3c6f93; color: #cfe9ff; }
.mpStoryBtn.ghost:hover { background: #23435e; }
.mpStoryClose { position: absolute; top: 10px; right: 12px; background: none; border: none;
	color: #8fd6ff; font-size: 20px; cursor: pointer; }
@keyframes mpStoryFade { from { opacity: 0; } to { opacity: 1; } }
.mpStoryBar { position: fixed; top: 54px; left: 50%; transform: translateX(-50%);
	z-index: 9996; display: flex; align-items: center; gap: 10px; max-width: 94vw;
	padding: 6px 14px; background: rgba(6,18,30,0.9); border: 1px solid #6fc7ff;
	border-radius: 999px; color: #dff3ff;
	font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif;
	font-size: 13px; box-shadow: 0 0 12px rgba(111,199,255,0.35); }
.mpStoryBar .mpStoryBarTag { color: #6fc7ff; font-weight: bold; }
.mpStoryBar .mpStoryBarState { color: #ffd98c; }
.mpStoryBar button { background: #155a86; color: #eaf7ff; border: 1px solid #6fc7ff;
	border-radius: 999px; padding: 3px 12px; cursor: pointer; font-size: 12px; }
.mpStoryBar button:hover { background: #1d79b7; }
`;
	try {
		if (document.head) document.head.appendChild(style);
	} catch (_) { /* ignore */ }
}

export class StorySyncController {
	private readonly main: any;
	/** The connection is per-session: reconnect replaces the socket object, so
	 * every story packet MUST read the CURRENT connection from main at call
	 * time (a captured stale connector silently sends into a dead socket). */
	private get conn(): IConnection { return this.main.connection; }

	private active = false;
	private quest = '';
	private leader = '';
	private members: string[] = [];
	private snapshot: any = null;
	private committed = false;
	private isPendingStart = false;
	private pendingReqId = '';
	private pendingQuest = '';
	private pendingAt = 0;
	private lastSent = '';
	private stateTimer = 0;
	private stateHeartbeat = 0;
	private leaderCompleteAt = 0;
	private finishedSynced = false;

	private currentEventSeq = 0;
	private currentEventActive = false;
	private currentEventPendingSince = 0;
	private passivePrompted: { [key: string]: number } = Object.create(null);
	private waitingTrigger: any = null;
	private waitingPromptSince = 0;
	private waitingOpen = false;

	private skipRequested = false;
	private skipPromptOpen = false;
	private skipLastHandled = 0;

	private questMenu: any = null;
	private questMenuButton: any = null;
	private questMenuGroup: any = null;
	private hudBar: JQuery | null = null;
	private hudBarSignature = '';

	private updateRegistered = false;
	private questObserverInstalled = false;
	private saveGuardInstalled = false;
	private rawQuestSave: any = null;
	private triggersInstalled = false;
	private modelSkipInstalled = false;
	private cutsceneWrapperInstalled = false;
	private questModelHooksInstalled = false;
	private eventStepsHooksInstalled = false;
	private menuHooksInstalled = false;

	constructor(main: any) {
		this.main = main;
		(window as any).__mpStory = this;
		ensureStorySyncStyle();
		// Read-only diagnostic (F8 console): `__mpstory()` dumps the live mode.
		// Useful when a trigger is stuck "waiting" — the `members` set shows who
		// the gather gate is still waiting for, and `event` shows the last seq.
		const self = this;
		(window as any).__mpstory = () => {
			try {
				const q = self.questManager();
				console.log('[mpstory] active=' + self.active + ' quest=' + self.quest
					+ ' leader=' + self.leader + ' isLeader=' + self.isLocalLeader()
					+ ' pendingStart=' + self.isPendingStart
					+ ' members=' + JSON.stringify(self.members)
					+ ' snapshot=' + !!self.snapshot
					+ ' eventSeq=' + self.currentEventSeq
					+ ' eventActive=' + self.currentEventActive
					+ ' waiting=' + !!(self.waitingTrigger));
				if (self.active && q) {
					const st = self.serializeQuestState(self.quest);
					console.log('[mpstory] local quest state:', JSON.stringify(st));
				}
			} catch (e) { console.warn('[mpstory] failed', e); }
		};
	}

	// ---------------------------------------------------------------- install

	/** Re-run on every connect: the engine-side hooks are once-guarded; the
	 * connection-bound listeners attach to the CURRENT socket here. */
	public install(): void {
		const c = this.conn;
		try { c.onStorySyncCheck((reqId, quest) => this.onCheckRequested(reqId, quest)); } catch (e) { console.error('[storysync] wire check failed', e); }
		try { c.onStorySyncJoinCheck((reqId, quest) => this.onJoinCheckRequested(reqId, quest)); } catch (e) { console.error('[storysync] wire joinCheck failed', e); }
		try { c.onStorySyncStart((data) => this.onStart(data)); } catch (e) { console.error('[storysync] wire start failed', e); }
		try { c.onStorySyncStartFailed((data) => this.onStartFailed(data)); } catch (e) { console.error('[storysync] wire startFailed failed', e); }
		try { c.onStorySyncState((data) => this.onState(data)); } catch (e) { console.error('[storysync] wire state failed', e); }
		try { c.onStorySyncEvent((data) => this.onEvent(data)); } catch (e) { console.error('[storysync] wire event failed', e); }
		try { c.onStorySyncEnd((data) => this.onEnd(data)); } catch (e) { console.error('[storysync] wire end failed', e); }
		try { c.onStorySyncSkipVote((data) => this.onSkipVoteRequested(data)); } catch (e) { console.error('[storysync] wire skipVote failed', e); }
		try { c.onStorySyncSkipResult((data) => this.onSkipVoteResult(data)); } catch (e) { console.error('[storysync] wire skipResult failed', e); }
		try { c.onStorySyncNudge((data) => this.onNudged(data)); } catch (e) { console.error('[storysync] wire nudge failed', e); }
		try { c.onStorySyncResend((data) => this.onResend(data)); } catch (e) { console.error('[storysync] wire resend failed', e); }
		this.ensureUpdate();
	}

	private ensureUpdate(): void {
		if (this.updateRegistered) return;
		this.updateRegistered = true;
		try {
			(window as any).simplify.registerUpdate(() => { try { this.tick(); } catch (_) { /* never break the frame */ } });
		} catch (e) { console.error('[storysync] update registration failed', e); }
	}

	public isActive(): boolean { return this.active; }
	public currentQuest(): string { return this.quest; }
	public isLocalLeader(): boolean { return this.active && this.leader === this.localName(); }
	public isLocalMember(): boolean { return this.active && this.leader !== this.localName(); }

	private localName(): string {
		try { return (this.main && this.main.name) || ''; } catch (_) { return ''; }
	}

	// ------------------------------------------------------------ party hooks

	/** Called from multiplayer's partyUpdate handler AFTER the roster is applied. */
	public syncWithParty(): void {
		try {
			if (!this.active) return;
			const roster: string[] = Array.isArray(this.main.partyMembers) ? this.main.partyMembers : [];
			console.log('[storysync] party sync: active=' + this.active + ' quest=' + this.quest + ' members=' + JSON.stringify(roster));
			if (roster.length <= 1 || roster.indexOf(this.localName()) === -1) {
				this.exitLocal('partyLoss', true);
				return;
			}
			// A non-leader member leaving must NOT stall the remaining sync:
			// drop departed names from OUR gather/vote set so the next trigger can
			// still start for the reduced team.
			if (Array.isArray(this.members)) {
				this.members = this.members.filter((n) => roster.indexOf(n) !== -1);
				for (const n of roster) if (this.members.indexOf(n) === -1) this.members.push(n);
			}
			const partyLeader = (this.main as any).partyLeader;
			if (typeof partyLeader === 'string' && partyLeader !== this.leader) {
				this.exitLocal('partyChangedLeader', true);
			}
		} catch (_) { /* ignore */ }
	}

	/** Called from multiplayer's partySelfEvent listener (self leave/kick). */
	public onPartySelfEvent(event: string): void {
		if (event === 'leave' || event === 'kicked') {
			// The server normally emits storySyncEnd first; this is belt-and-braces.
			if (this.active && !this.isLocalLeader()) this.exitLocal('leave', true);
		}
	}

	/** logout / server loss: restore our quest state and drop the mode. */
	public onSessionCleared(): void {
		this.exitLocal('sessionEnd', true, true);
		this.pendingStartReset();
	}

	private pendingStartReset(): void {
		this.isPendingStart = false;
		this.pendingReqId = '';
		this.pendingQuest = '';
		this.pendingAt = 0;
		this.waitingOpen = false;
	}

	// --------------------------------------------------------------- statuses

	private questManager(): any {
		try { return (sc as any).quests || null; } catch (_) { return null; }
	}

	private questStatus(id: string): { available: boolean, active: boolean, solved: boolean } {
		const q = this.questManager();
		if (!q || typeof q.isQuestActive !== 'function' || typeof q.isQuestSolved !== 'function') {
			return { available: false, active: false, solved: false };
		}
		return { available: true, active: !!q.isQuestActive(id), solved: !!(q.isQuestSolved && q.isQuestSolved(id)) };
	}

	private questLabel(id: string): string {
		try {
			const q = this.questManager();
			if (!q || typeof q.getQuestName !== 'function') return id;
			const lbl = q.getQuestName(id);
			if (lbl === null || lbl === undefined) return id;
			if (typeof lbl === 'string') return lbl;
			if ((ig as any).LangLabel && typeof (ig as any).LangLabel.getText === 'function') {
				return String((ig as any).LangLabel.getText(lbl));
			}
			return String(lbl && lbl.data ? lbl.data : lbl);
		} catch (_) { return id; }
	}

	/** QuestState.getSaveData() shape, JSON-safe. Null when neither active nor
	 * solved (shouldn't happen mid-sync — eligibility gates it). */
	private serializeQuestState(id: string): any {
		try {
			const q = this.questManager();
			if (!q) return null;
			const quest = typeof q.getStaticQuest === 'function' ? q.getStaticQuest(id) : null;
			if (!quest) return null;
			const tasks = Array.isArray(quest.tasks) ? quest.tasks.length : 0;
			if (q.isQuestSolved(id)) {
				return { id, task: tasks, highest: tasks, finished: true, completed: [], labels: {} };
			}
			const st = typeof q.getQuestState === 'function' ? q.getQuestState(quest) : null;
			if (!st || typeof st.getSaveData !== 'function') return null;
			const sv = st.getSaveData();
			return {
				id,
				task: Number(sv.task) || 0,
				highest: Number(sv.highest) || 0,
				finished: !!sv.finished,
				completed: sv.completed || [],
				labels: sv.labels || {},
			};
		} catch (_) { return null; }
	}

	// ------------------------------------------------------ save snapshot/guard

	private plainClone(v: any): any {
		try { return JSON.parse(JSON.stringify(v)); } catch (_) { return v; }
	}

	private installSaveGuard(): void {
		if (this.saveGuardInstalled) return;
		const q = this.questManager();
		if (!q || typeof q.onStorageSave !== 'function') return;
		this.saveGuardInstalled = true;
		this.rawQuestSave = q.onStorageSave;
		const self = this;
		// The game's storage calls quests.onStorageSave(storageObject) on every
		// save. While synced and uncommitted we silently substitute the snapshot
		// block, so a mid-sync save can never persist the temporary progress.
		q.onStorageSave = function (box: any) {
			try {
				const tmp: any = {};
				self.rawQuestSave.call(q, tmp);
				if (self.active && !self.committed && self.snapshot) {
					box.quests = self.plainClone(self.snapshot);
				} else {
					box.quests = tmp.quests;
				}
			} catch (err) {
				// Fall through to the raw write on any surprise — a save must not throw.
				try { self.rawQuestSave.call(q, box); } catch (_) { /* ignore */ }
			}
		};
	}

	private captureSnapshot(): boolean {
		const q = this.questManager();
		if (!q || typeof q.onStorageSave !== 'function') { this.snapshot = null; return false; }
		try {
			const box: any = {};
			// Bypass our own guard: the guard is only interested in snapshots it
			// already holds; capture ALWAYS reads the real live quest model.
			(this.rawQuestSave || q.onStorageSave).call(q, box);
			if (!box.quests) return false;
			this.snapshot = this.plainClone(box.quests);
			return true;
		} catch (err) {
			console.error('[storysync] snapshot capture failed', err);
			this.snapshot = null;
			return false;
		}
	}

	private restoreSnapshot(): void {
		const q = this.questManager();
		if (!q || !this.snapshot || typeof q.onStoragePreLoad !== 'function') { this.snapshot = null; return; }
		try {
			q.onStoragePreLoad({ quests: this.plainClone(this.snapshot) });
			try { if ((ig.game as any).varsChangedDeferred) (ig.game as any).varsChangedDeferred(); } catch (_) { /* ignore */ }
			console.log('[storysync] quest snapshot restored (' + this.quest + ')');
		} catch (err) {
			console.error('[storysync] snapshot restore failed', err);
		} finally {
			this.snapshot = null;
		}
	}

	// --------------------------------------------------------- start handshake

	/** Quest-menu entry: leader requests the mode for the currently selected (or
	 * marked) quest. Returns a user-facing string for validation failures. */
	public leaderRequestSync(): string {
		if (this.active) { return t('storySyncAlreadyActive'); }
		if (this.isPendingStart) { return t('storySyncStillChecking'); }
		const roster = Array.isArray(this.main.partyMembers) ? this.main.partyMembers : [];
		if (roster.length < 2) { return t('storySyncNeedParty'); }
		if (!(this.main as any).isPartyLeader) { return t('storySyncLeaderOnly'); }
		const id = this.candidateQuestId();
		if (!id) { return t('storySyncNoQuestSelected'); }
		const st = this.questStatus(id);
		if (!st.available) { return t('storySyncQuestEngineUnavailable'); }
		if (!st.active || st.solved) { return t('storySyncLeaderQuestMustBeActive'); }
		this.pendingQuest = id;
		this.pendingReqId = '';
		this.pendingAt = Date.now();
		this.isPendingStart = true;
		this.installSaveGuard();
		try { this.conn.storySyncRequest(id); } catch (e) { this.pendingStartReset(); return t('storySyncNetworkError'); }
		console.log('[storysync] requested quest=' + id);
		return '';
	}

	/** Public cancel path (quest-menu button + HUD bar). */
	public leaderCancelSync(confirm: boolean): void {
		if (!this.active || !this.isLocalLeader()) return;
		if (!confirm) {
			storyWindow(t('storySyncCancelTitle'), t('storySyncCancelConfirmBody'), [
				{ label: t('storySyncCancelConfirm'), kind: 'danger', onClick: () => this.leaderCancelSync(true) },
				{ label: t('storySyncCancelStay'), kind: 'ghost', onClick: () => { /* close only */ } },
			], true);
			return;
		}
		try { this.conn.storySyncCancel(this.quest); } catch (_) { /* ignore */ }
		showMpToast({ title: t('storySyncCancelRequested') });
	}

	private onCheckRequested(reqId: string, quest: string): void {
		if (!this.questStatus(quest).available) {
			try { this.conn.storySyncCheckResult(reqId, quest, false, false, false); } catch (_) { /* ignore */ }
			return;
		}
		if (this.isLocalLeader() || this.isPendingStart) {
			this.pendingReqId = reqId;
			this.pendingQuest = quest;
			this.pendingAt = Date.now();
			this.isPendingStart = true;
		}
		const st = this.questStatus(quest);
		try { this.conn.storySyncCheckResult(reqId, quest, st.available, st.active, st.solved); } catch (_) { /* ignore */ }
		this.openCheckingWindow();
		console.log('[storysync] eligibility answered req=' + reqId + ' quest=' + quest + ' active=' + st.active + ' solved=' + st.solved);
	}

	private openCheckingWindow(): void {
		// Leader sees the real wait state; members get a transient toast + we keep
		// the HUD quiet — the server pushes success/failure within ~15s.
		if (!this.isPendingStart || !(this.main as any).isPartyLeader) {
			showMpToast({ title: t('storySyncCheckingMember') });
			return;
		}
		if (this.waitingOpen) return;
		this.waitingOpen = true;
		const handle = storyWindow(t('storySyncCheckingTitle'), t('storySyncCheckingBody').replace('{quest}', this.questLabel(this.pendingQuest)), [
			{ label: t('storySyncCheckingStash'), kind: 'ghost', onClick: () => { /* close only */ } },
		], false);
		// If the server's answer never arrives close the modal ourselves.
		const checkEnds = this.pendingAt + CHECK_LOCAL_TIMEOUT;
		const iv = (window as any).setInterval(() => {
			if (!this.isPendingStart) { (window as any).clearInterval(iv); return; }
			if (Date.now() >= checkEnds) {
				this.pendingStartReset();
				try { handle.close(); } catch (_) { /* ignore */ }
				showMpToast({ title: t('storySyncCheckTimeout') });
				(window as any).clearInterval(iv);
			}
		}, 1000);
	}

	private onStartFailed(data: { reqId: string, quest: string, reason: string, names: string[] }): void {
		const ours = (this.isPendingStart && data.quest === this.pendingQuest) || this.active;
		this.pendingStartReset();
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
		try { this.refreshQuestButton(); } catch (_) { /* ignore */ }
		if (!ours && !data.reason) return;
		const reasonText = this.failureText(data.reason, data.names || []);
		console.warn('[storysync] start failed: ' + data.reason + ' names=' + JSON.stringify(data.names));
		if ((this.main as any).isPartyLeader && (data.reason === 'membersNotReady' || data.reason === 'leaderNotActive')) {
			storyWindow(t('storySyncFailedTitle'), reasonText, [{ label: t('storySyncFailedOk'), onClick: () => { /* close */ } }], true);
		} else {
			showMpToast({ title: t('storySyncFailedTitle'), subtitle: reasonText });
		}
	}

	private failureText(reason: string, names: string[]): string {
		switch (reason) {
			case 'notLeader': return t('storySyncFailNotLeader');
			case 'busy': return t('storySyncFailBusy');
			case 'offline': return t('storySyncFailOffline').replace('{names}', names.join('、') || '?');
			case 'membersNotReady': return t('storySyncFailMembersNotReady').replace('{names}', names.join('、') || '?');
			case 'leaderNotActive': return t('storySyncFailLeaderNotActive');
			case 'timeout': return t('storySyncFailTimeout');
			case 'partyGone': return t('storySyncFailPartyGone');
			case 'partyChanged': return t('storySyncFailPartyChanged');
			default: return t('storySyncFailUnknown');
		}
	}

	// --------------------------------------------------------- join eligibility

	private onJoinCheckRequested(reqId: string, quest: string): void {
		const st = this.questStatus(quest);
		console.log('[storysync] join check req=' + reqId + ' quest=' + quest + ' active=' + st.active + ' solved=' + st.solved);
		try { this.conn.storySyncJoinCheckResult(reqId, quest, st.available, st.active, st.solved); } catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------- mode envelope

	private onStart(data: { quest: string, leader: string, members: string[] }): void {
		if (!data || typeof data.quest !== 'string' || typeof data.leader !== 'string') return;
		if (this.active && this.quest === data.quest) {
			// A mid-way joiner handshake push also refreshes membership.
			this.leader = data.leader;
			this.members = Array.isArray(data.members) ? data.members.slice() : [];
			return;
		}
		if (this.active) this.exitLocal('replaced', true);
		this.pendingStartReset();
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
		this.installSaveGuard();
		this.quest = data.quest;
		this.leader = data.leader;
		this.members = Array.isArray(data.members) ? data.members.slice() : [];
		this.snapshot = null;
		this.committed = false;
		this.finishedSynced = false;
		this.currentEventSeq = 0;
		this.currentEventActive = false;
		this.currentEventPendingSince = 0;
		this.skipRequested = false;
		this.skipPromptOpen = false;
		this.passivePrompted = Object.create(null);
		this.waitingTrigger = null;
		this.waitingPromptSince = 0;
		this.waitingOpen = false;
		this.lastSent = '';
		this.leaderCompleteAt = 0;

		const captured = this.captureSnapshot();
		this.active = true;
		if (!captured) {
			// Without a snapshot the restore half of the contract is unavailable —
			// fail the mode closed locally instead of silently leaking progress.
			console.error('[storysync] snapshot capture failed — refusing to enter sync');
			this.exitLocal('snapshotFailed', false);
			showMpToast({ title: t('storySyncSnapshotFailed') });
			return;
		}
		console.log('[storysync] MODE START quest=' + this.quest + ' leader=' + this.leader +
			' members=' + JSON.stringify(this.members) + ' snapshot=true I-am-leader=' + this.isLocalLeader());
		this.lockQuestHud();
		if (this.isLocalLeader()) {
			this.markStateDirty();
			showMpToast({ title: t('storySyncStartedLeader'), subtitle: this.questLabel(this.quest) });
		} else {
			showMpToast({ title: t('storySyncStartedMember'), subtitle: this.questLabel(this.quest) });
		}
		try { this.refreshQuestButton(); } catch (_) { /* ignore */ }
	}

	private lockQuestHud(): void {
		const q = this.questManager();
		if (!q || typeof q.isMarkedQuest !== 'function' || typeof q.markQuest !== 'function') return;
		try {
			const st = this.questStatus(this.quest);
			if (st.active && !st.solved && !q.isMarkedQuest(this.quest)) q.markQuest(this.quest);
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------- state relay

	public markStateDirty(): void {
		this.stateTimer = 0;
		this.stateHeartbeat = STATE_HEARTBEAT;
	}

	private sendStateIfLeader(force: boolean): void {
		if (!this.active || !this.isLocalLeader()) return;
		const state = this.serializeQuestState(this.quest);
		if (!state) return;
		const json = JSON.stringify(state);
		if (!force && json === this.lastSent) { this.stateHeartbeat -= ig.system.tick; return; }
		this.lastSent = json;
		try {
			this.conn.storySyncState(this.quest, state, (ig.game && (ig.game as any).mapName) || '');
		} catch (_) { /* ignore */ }
	}

	private onState(data: { from: string, quest: string, state: any, map?: string }): void {
		if (!this.active || data.quest !== this.quest) return;
		if (typeof data.from === 'string' && data.from === this.localName()) return; // our own echo
		if (this.isLocalLeader()) return;
		this.applySyncedState(data.state);
	}

	private applySyncedState(state: any): void {
		try {
			if (!state || state.id !== this.quest) return;
			const q = this.questManager();
			const quest = q && typeof q.getStaticQuest === 'function' ? q.getStaticQuest(this.quest) : null;
			if (!q || !quest) return;
			// A member who has ALREADY solved the quest stays solved — the story
			// plays, but their finished state is never rewound or rewarded again.
			if (q.isQuestSolved(this.quest)) return;
			if (state.finished) {
				this.tryFinishSyncedQuest(state);
				return;
			}
			let st = typeof q.getQuestState === 'function' ? q.getQuestState(quest) : null;
			if (!st) {
				if (this.questStatus(this.quest).active) {
					// Wait for the next packet rather than re-activating (the game
					// state may be mid-load).
					return;
				}
				if (typeof q.activateStaticQuest === 'function') {
					q.activateStaticQuest(this.quest);
					st = q.getQuestState(quest);
				}
				if (!st) return;
			}
			st.setLoadData({
				finished: false,
				task: Number(state.task) || 0,
				highest: Number(state.highest) || 0,
				completed: state.completed || [],
				labels: state.labels || {},
			});
			try { (sc as any).Model.notifyObserver(q, 1, st); } catch (_) { /* ignore */ }
			try { if ((ig.game as any).varsChangedDeferred) (ig.game as any).varsChangedDeferred(); } catch (_) { /* ignore */ }
		} catch (err) {
			console.warn('[storysync] apply state failed', err);
		}
	}

	/** Apply the FINAL completed progress through the game's own finish path so
	 * exactly one native QuestSolvedDialog + reward lands for unfinished members. */
	private tryFinishSyncedQuest(state: any): void {
		try {
			const q = this.questManager();
			const quest = q && typeof q.getStaticQuest === 'function' ? q.getStaticQuest(this.quest) : null;
			if (!q || !quest || q.isQuestSolved(this.quest)) return;
			const st = typeof q.getQuestState === 'function' ? q.getQuestState(quest) : null;
			if (!st) return;
			if (this.finishedSynced) return;
			const taskCount = Array.isArray(quest.tasks) ? quest.tasks.length : Number(state.task || 0);
			st.setLoadData({
				finished: false,
				task: Math.max(taskCount, Number(state.task) || 0),
				highest: Math.max(taskCount, Number(state.highest) || 0),
				completed: state.completed || [],
				labels: state.labels || {},
			});
			this.finishedSynced = true;
			q.setQuestFinished(quest);
			console.log('[storysync] member quest completion queued via native setQuestFinished: ' + this.quest);
		} catch (err) {
			console.warn('[storysync] finish-synced quest failed', err);
		}
	}

	// -------------------------------------------------------------- quest runs

	private onResend(data: { quest: string }): void {
		if (!this.active || !this.isLocalLeader() || data.quest !== this.quest) return;
		// Force a fresh packet for a mid-way joiner.
		this.lastSent = '';
		this.markStateDirty();
	}

	// ------------------------------------------------------------- engine hooks

	/** Called from registered update each frame; installs hooks lazily once the
	 * needed engine classes exist, pumps the leader state stream, and keeps the
	 * HUD bar / waiting prompt / skip state coherent. */
	private tick(): void {
		try {
			this.ensureEngineHooks();
			if (this.active) {
				if (this.isLocalLeader()) {
					this.stateTimer -= ig.system.tick || 0;
					this.stateHeartbeat -= ig.system.tick || 0;
					if (this.stateTimer <= 0) {
						this.stateTimer = STATE_SEND_INTERVAL;
						this.sendStateIfLeader(false);
					} else if (this.stateHeartbeat <= 0) {
						this.stateHeartbeat = STATE_HEARTBEAT;
						this.sendStateIfLeader(false);
					}
					if (this.leaderCompleteAt && Date.now() >= this.leaderCompleteAt) {
						this.leaderCompleteAt = 0;
						const finalState = this.serializeQuestState(this.quest);
						if (finalState && finalState.finished) {
							try { this.conn.storySyncComplete(this.quest, finalState); } catch (_) { /* ignore */ }
							console.log('[storysync] leader broadcast completion: ' + this.quest);
						}
					}
				}
				// A pending start whose server reply never lands eventually resets.
				if (this.isPendingStart && Date.now() - this.pendingAt > CHECK_LOCAL_TIMEOUT) {
					this.pendingStartReset();
					try { closeStoryWindows(); } catch (_) { /* ignore */ }
					showMpToast({ title: t('storySyncCheckTimeout') });
				}
			}
			this.updateHudBar();
			this.updateWaitingPrompt();
		} catch (_) { /* never break the frame */ }
	}

	private ensureEngineHooks(): void {
		this.installQuestObserver();
		this.installSaveGuard();
		this.installModelSkipHook();
		this.installCutsceneWrapper();
		this.installQuestModelHooks();
		this.installTriggerHooks();
		this.installEventStepHooks();
		this.installQuestMenuHooks();
	}

	private installQuestObserver(): void {
		try {
			if (this.questObserverInstalled) return;
			const q = this.questManager();
			if (!q) return;
			this.questObserverInstalled = true;
			const self = this;
			(sc as any).Model.addObserver(q, {
				modelChanged(model: any, msg: number, data: any) {
					try {
						if (!self.active || model !== self.questManager()) return;
						if (!self.isLocalLeader()) return;
						const EV: any = (sc as any).QUEST_MODEL_EVENT || {};
						const questId = data && data.quest && data.quest.id;
						const relevant = questId === undefined || questId === self.quest;
						if (relevant && (msg === EV.UPDATE || msg === EV.TASK_DONE || msg === EV.TASK_UNDONE || msg === EV.SUBTASK_DONE)) {
							self.markStateDirty();
						}
						if (msg === EV.FINISHED && questId === self.quest && !self.leaderCompleteAt) {
							self.markStateDirty();
							// Let the game's notifyObserver unwind before broadcasting.
							self.leaderCompleteAt = Date.now() + 120;
							console.log('[storysync] leader quest FINISHED observed: ' + self.quest);
						}
					} catch (_) { /* observer must never throw */ }
				},
			});
			console.log('[storysync] quest observer installed');
		} catch (_) { /* ignore */ }
	}

	private installModelSkipHook(): void {
		try {
			if (this.modelSkipInstalled) return;
			const GM: any = (sc as any).GameModel;
			if (!GM || typeof GM.inject !== 'function') return;
			this.modelSkipInstalled = true;
			const self = this;
			GM.inject({
				skipCutscene(this: any) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl && ctl.handleSkipKey(this)) return undefined;
					return this.parent();
				},
			});
			console.log('[storysync] skip-cutscene hook installed');
		} catch (_) { /* ignore */ }
	}

	private installCutsceneWrapper(): void {
		try {
			if (this.cutsceneWrapperInstalled) return;
			const CUT: any = (sc as any).Cutscene;
			if (!CUT || typeof CUT.startEvent !== 'function') return;
			this.cutsceneWrapperInstalled = true;
			const orig = CUT.startEvent;
			const self = this;
			CUT.startEvent = function (type: number, ev: any, name?: string, extra?: any) {
				const ctl: StorySyncController = (window as any).__mpStory;
				if (ctl && ctl.interceptStoryEventStart(type, ev)) return null;
				return orig.apply(this, arguments as any);
			};
			console.log('[storysync] Cutscene.startEvent wrapper installed');
		} catch (_) { /* ignore */ }
	}

	private installQuestModelHooks(): void {
		try {
			if (this.questModelHooksInstalled) return;
			const QM: any = (sc as any).QuestModel;
			if (!QM || typeof QM.inject !== 'function') return;
			this.questModelHooksInstalled = true;
			const self = this;
			QM.inject({
				getQuestEvent(this: any, quest: any) {
					const ev = this.parent(quest);
					if (ev) ev._mpStoryQuestSolvedEvent = true;
					return ev;
				},
				markQuest(this: any, id: string) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl && ctl.isLocalMember() && ctl.isQuestLockedForMembers()) {
						if (id !== ctl.quest) {
							if (Date.now() - ctl.lastLockToastAt > SUPPRESS_TOAST_COOLDOWN) {
								ctl.lastLockToastAt = Date.now();
								showMpToast({ title: t('storySyncQuestLocked') });
							}
							return;
						}
						if (ctl.questManager() && ctl.questManager().isMarkedQuest(id)) return; // can't un-lock
					}
					return this.parent(id);
				},
			});
			console.log('[storysync] QuestModel hooks installed');
		} catch (_) { /* ignore */ }
	}

	public lastLockToastAt = 0;
	public isQuestLockedForMembers(): boolean {
		return this.isLocalMember();
	}

	/** True when the member's LOCAL attempt to start a story cutscene must be
	 * suppressed: only the leader plays/authorizes story events. Quest-solved
	 * reward dialogs + our own remote replay are explicitly allowed. */
	private interceptStoryEventStart(type: number, ev: any): boolean {
		try {
			if (!this.active || !this.isLocalMember()) return false;
			const EV: any = (ig as any).EVENT_TYPE || {};
			if (type === EV.PARALLEL) return false;
			if (ev && ev._mpStoryQuestSolvedEvent) return false;
			if ((window as any).__mpStoryRun && (window as any).__mpStoryRun.allow) return false;
			const now = Date.now();
			if (now - this.lastSuppressToastAt > SUPPRESS_TOAST_COOLDOWN) {
				this.lastSuppressToastAt = now;
				showMpToast({ title: t('storySyncSuppressLocalStory'), subtitle: this.questLabel(this.quest) });
			}
			console.log('[storysync] suppressed member-local story event type=' + type + ' quest=' + this.quest);
			return true;
		} catch (_) { return false; }
	}

	private lastSuppressToastAt = 0;

	private installTriggerHooks(): void {
		try {
			if (this.triggersInstalled) return;
			const ET: any = (ig.ENTITY as any).EventTrigger;
			const LE: any = (ig.ENTITY as any).LocationEvent;
			if (!ET || !LE || typeof ET.inject !== 'function' || typeof LE.inject !== 'function') return;
			this.triggersInstalled = true;
			const self = this;
			const stash = function (this: any, a: any, b: any, c: any, e: any) {
				this.parent(a, b, c, e);
				try { this._mpStorySettings = e ? self.plainClone(e) : null; } catch (_) { this._mpStorySettings = null; }
			};
			ET.inject({
				init: stash,
				update(this: any) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl && ctl.maybeGateTrigger(this, 'trigger')) return;
					this.parent();
				},
			});
			LE.inject({
				init: stash,
				update(this: any) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl && ctl.maybeGateTrigger(this, 'location')) return;
					this.parent();
				},
			});
			console.log('[storysync] story-trigger gates installed');
		} catch (_) { /* ignore */ }
	}

	/** Returns true when the controller consumed the frame (the caller skips its
	 * native update). Ready-check mirrors the engine's own trigger predicates. */
	public maybeGateTrigger(trig: any, kind: 'trigger' | 'location'): boolean {
		try {
			if (!this.active) return false;
			if (!trig || !trig.coll) return false;
			const g: any = ig.game;
			if (!g || typeof g.isEventStartReady !== 'function') return false;
			let ready = false;
			if (kind === 'trigger') {
				if (!g.isEventStartReady()) return false;
				const running = trig.eventCall && typeof trig.eventCall.isRunning === 'function' && trig.eventCall.isRunning();
				if (running) return false;
				ready = trig.startCondition && trig.startCondition.evaluate() && !(trig.endCondition && trig.endCondition.evaluate())
					&& !(trig.triggerVar && (ig.vars as any).get(trig.triggerVar)) && !g.isTeleporting();
			} else {
				if (trig.eventCall && typeof trig.eventCall.isRunning === 'function' && trig.eventCall.isRunning()) return false;
				if (trig.triggerVar && (ig.vars as any).get(trig.triggerVar)) return false; // native once-per-map semantics
				ready = this.locationEventReady(trig);
			}
			if (!ready) return false;
			if (this.isLocalLeader()) {
				this.leaderTriggerReady(trig, kind);
			} else {
				this.memberTriggerReady(trig, kind);
			}
			return true; // leader or member: the engine must not start it itself
		} catch (_) { return false; }
	}

	/** Mirrors ig.ENTITY.LocationEvent.update's native gating (radius / screen /
	 * combat / conditions), without starting anything. */
	private locationEventReady(trig: any): boolean {
		try {
			const model: any = (sc as any).model;
			if (!model) return false;
			if (model.isCombatActive && model.isCombatActive()) return false;
			if (model.message && typeof model.message.isSideMessageVisible === 'function' && model.message.isSideMessageVisible()) return false;
			if (!model.isGame || !model.isGame() || !model.isRunning || !model.isRunning()) return false;
			if (!(ig as any).EntityTools || typeof (ig as any).EntityTools.isInScreen !== 'function') return false;
			if (!(ig as any).EntityTools.isInScreen(trig, -48, -32)) return false;
			if (!trig.startCondition || !trig.startCondition.evaluate()) return false;
			const player = ig.game && (ig.game as any).playerEntity;
			if (!player || !player.coll) return false;
			const radius = Number(trig.radius) || 0;
			if (radius) {
				const c = trig.coll;
				const d = (ig.CollTools as any).getScreenDistance ? (ig.CollTools as any).getScreenDistance(c, player.coll) : 0;
				if (d > radius) return false;
			}
			const heightCompare = Number(trig.heightCompare) || 0;
			if (heightCompare === 1 && player.coll.pos.z < trig.coll.pos.z) return false;  // ABOVE
			if (heightCompare === 2 && player.coll.pos.z > trig.coll.pos.z) return false;  // BELOW
			return true;
		} catch (_) { return false; }
	}

	private triggerEventOf(trig: any): any {
		try {
			if (trig.event) return trig.event;
			const raw = trig._mpStorySettings;
			if (raw && raw.event) return new (ig as any).Event({ name: trig.name || undefined, steps: raw.event });
		} catch (_) { /* ignore */ }
		return null;
	}

	private triggerKey(trig: any): string {
		try {
			if (trig.mapId !== undefined && trig.mapId !== null) return String(trig.mapId);
			if (trig.name) return String(trig.name).slice(0, 48);
		} catch (_) { /* ignore */ }
		return '';
	}

	// -------------------------------------------------------- leader-side gather

	/** Leaders: all remaining members must be within GATHER_RADIUS of the local
	 * trigger (and roughly the same height) before the local event is allowed. */
	private absentMembersFor(trig: any): string[] {
		const absent: string[] = [];
		const self = this.localName();
		const tc = trig.coll && trig.coll.pos;
		if (!tc) return this.members.filter((m) => m !== self);
		for (const name of this.members) {
			if (name === self) continue;
			const pl: any = this.main.players && this.main.players[name];
			const e: any = pl && pl.entity;
			if (!e || e._killed || !e.coll || !e.coll.pos) { absent.push(name); continue; }
			const dx = e.coll.pos.x - tc.x;
			const dy = e.coll.pos.y - tc.y;
			const dz = Math.abs((e.coll.pos.z || 0) - tc.z);
			if (dx * dx + dy * dy > GATHER_RADIUS * GATHER_RADIUS || dz > GATHER_Z_DELTA) absent.push(name);
		}
		return absent;
	}

	private leaderTriggerReady(trig: any, kind: 'trigger' | 'location'): void {
		const key = this.triggerKey(trig);
		const absent = this.absentMembersFor(trig);
		console.log('[storysync] leader trigger ready kind=' + kind + ' key=' + key + ' absent=' + JSON.stringify(absent));
		if (!absent.length) {
			this.startAuthoritativeEvent(trig, kind);
			return;
		}
		this.waitingTrigger = trig;
		this.waitingPromptSince = this.waitingPromptSince || Date.now();
	}

	private memberTriggerReady(trig: any, kind: 'trigger' | 'location'): void {
		const key = kind + ':' + this.triggerKey(trig);
		const now = Date.now();
		if (!this.passivePrompted[key] || now - this.passivePrompted[key] > 10000) {
			this.passivePrompted[key] = now;
			showMpToast({ title: t('storySyncWaitingLeader'), subtitle: this.questLabel(this.quest) });
		}
	}

	private updateWaitingPrompt(): void {
		try {
			if (!this.active || !this.isLocalLeader() || !this.waitingTrigger || this.waitingTrigger._killed) {
				if (this.waitingOpen) { closeStoryWindows(); this.waitingOpen = false; }
				this.waitingTrigger = null;
				this.waitingPromptSince = 0;
				return;
			}
			const trig = this.waitingTrigger;
			const absent = this.absentMembersFor(trig);
			if (!absent.length) {
				// Everyone arrived between frames — fire the event now.
				this.waitingTrigger = null;
				this.waitingPromptSince = 0;
				if (this.waitingOpen) { try { closeStoryWindows(); } catch (_) { /* ignore */ } this.waitingOpen = false; }
				this.startAuthoritativeEvent(trig, trig instanceof (ig.ENTITY as any).LocationEvent ? 'location' : 'trigger');
				return;
			}
			if (this.waitingOpen) return;
			const now = Date.now();
			if (now - this.waitingPromptSince < NUDGE_PROMPT_COOLDOWN) return;
			this.waitingPromptSince = now;
			this.waitingOpen = true;
			const names = absent.map((n) => '· ' + n).join('\n');
			storyWindow(
				t('storySyncGatherTitle'),
				t('storySyncGatherBody').replace('{quest}', this.questLabel(this.quest)).replace('{names}', names),
				[
					{
						label: t('storySyncGatherNudge'), kind: 'primary',
						onClick: () => {
							// The requester is already here; tell the absent members.
							try { this.conn.storySyncNudge(this.quest, absent.slice()); } catch (_) { /* ignore */ }
							showMpToast({ title: t('storySyncNudgeSent'), subtitle: absent.join('、') });
						},
					},
					{ label: t('storySyncGatherClose'), kind: 'ghost', onClick: () => { this.waitingOpen = false; } },
				],
				true,
			);
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------- authoritative event start

	private startAuthoritativeEvent(trig: any, kind: 'trigger' | 'location'): void {
		try {
			const ev = this.triggerEventOf(trig);
			if (!ev) {
				showMpToast({ title: t('storySyncTriggerMissing') });
				console.warn('[storysync] trigger event missing key=' + this.triggerKey(trig));
				return;
			}
			const map = (ig.game as any).mapName || '';
			const key = this.triggerKey(trig);
			if (!map || !key) return;
			const EV: any = (ig as any).EVENT_TYPE || {};
			const type = kind === 'location' ? (EV.PARALLEL || 1) : (Number(trig.eventType) || EV.CUTSCENE || 2);
			const token = { allow: true };
			(window as any).__mpStoryRun = token;
			let call: any = null;
			try {
				call = (sc as any).Cutscene.startEvent(type, ev, trig.name || ('mpSync:' + key));
			} finally {
				if ((window as any).__mpStoryRun === token) delete (window as any).__mpStoryRun;
			}
			if (!call) {
				showMpToast({ title: t('storySyncTriggerStartFailed') });
				return;
			}
			trig.eventCall = call;
			if (kind === 'location' && trig.triggerVar) {
				try { (ig.vars as any).set(trig.triggerVar, 1); } catch (_) { /* ignore */ }
			}
			// The leader's engine event is ALREADY running locally — mark it such
			// immediately (the server relay echo only carries the vote seq, it must
			// not resurrect a stale 2.5s pending grace for skip handling).
			this.currentEventActive = true;
			this.currentEventPendingSince = 0;
			this.skipRequested = false;
			this.attachEventEnd(call);
			try {
				this.conn.storySyncEvent(this.quest, map, key, kind, type);
			} catch (_) { /* ignore */ }
			console.log('[storysync] leader started story event kind=' + kind + ' key=' + key + ' map=' + map);
		} catch (err) {
			console.warn('[storysync] authoritative event start failed', err);
		}
	}

	private attachEventEnd(call: any): void {
		try {
			const prev = call.onEnd;
			const self = this;
			call.onEnd = function (eventCall: any) {
				try { self.onSyncedEventEnded(); } catch (_) { /* ignore */ }
				if (prev) {
					try { return prev.call(this, eventCall); } catch (_) { /* ignore */ }
				}
				return undefined;
			};
		} catch (_) { /* ignore */ }
	}

	private onSyncedEventEnded(): void {
		if (this.currentEventActive || this.currentEventPendingSince) {
			console.log('[storysync] synced story event ended (seq=' + this.currentEventSeq + ')');
		}
		// Leader tells the server so an open no-timeout skip vote can be aborted
		// for off-map/afk members instead of stranding their vote modal forever.
		if (this.currentEventSeq && this.isLocalLeader()) {
			try { this.conn.storySyncEventEnd(this.currentEventSeq); } catch (_) { /* ignore */ }
		}
		this.currentEventActive = false;
		this.currentEventPendingSince = 0;
		this.skipRequested = false;
		this.skipPromptOpen = false;
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
	}

	// ---------------------------------------------------------------- event relay

	private onEvent(data: { from: string, quest: string, map: string, key: string, kind: 'trigger' | 'location', type: number, seq: number }): void {
		if (!this.active || data.quest !== this.quest) return;
		const mapNow = (ig.game as any).mapName || '';
		const selfName = this.localName();
		this.currentEventSeq = data.seq || 0;
		this.skipRequested = false;
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
		this.waitingTrigger = null;
		this.waitingPromptSince = 0;
		this.waitingOpen = false;
		if (data.from === selfName) {
			// Leader echo carries the authoritative seq while the event already runs.
			if (!this.currentEventActive) this.currentEventPendingSince = Date.now();
			return;
		}
		if (mapNow !== data.map) {
			showMpToast({ title: t('storySyncEventOffMap'), subtitle: this.questLabel(this.quest) });
			console.log('[storysync] story event relayed from another map (' + data.map + '), we are on ' + mapNow);
			return;
		}
		const trig = this.findTrigger(data.key, data.kind);
		if (!trig) {
			console.warn('[storysync] matching trigger not found for event key=' + data.key + ' kind=' + data.kind);
			showMpToast({ title: t('storySyncEventMissingTrigger') });
			return;
		}
		this.memberReplayEvent(trig, data.kind, data.type, data.seq);
	}

	private findTrigger(key: string, kind: 'trigger' | 'location'): any {
		try {
			const entities: any[] = (ig.game as any).entities || [];
			const ET: any = (ig.ENTITY as any).EventTrigger;
			const LE: any = (ig.ENTITY as any).LocationEvent;
			for (let i = 0; i < entities.length; i++) {
				const e = entities[i];
				if (!e || e._killed) continue;
				if (kind === 'trigger' && ET && e instanceof ET) { if (this.triggerKey(e) === key) return e; }
				else if (kind === 'location' && LE && e instanceof LE) { if (this.triggerKey(e) === key) return e; }
			}
			// mapId may be missing on some maps: fall back to the assigned name.
			for (let i = 0; i < entities.length; i++) {
				const e = entities[i];
				if (!e || e._killed || !e.name || String(e.name) !== key) continue;
				if (kind === 'trigger' && ET && e instanceof ET) return e;
				if (kind === 'location' && LE && e instanceof LE) return e;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	private memberReplayEvent(trig: any, kind: 'trigger' | 'location', type: number, seq: number): void {
		try {
			const ev = this.triggerEventOf(trig);
			if (!ev) {
				showMpToast({ title: t('storySyncTriggerMissing') });
				return;
			}
			const token = { allow: true };
			(window as any).__mpStoryRun = token;
			let call: any = null;
			try {
				call = (sc as any).Cutscene.startEvent(type, ev, trig.name || ('mpSync:' + this.triggerKey(trig)));
			} finally {
				if ((window as any).__mpStoryRun === token) delete (window as any).__mpStoryRun;
			}
			if (!call) { showMpToast({ title: t('storySyncTriggerStartFailed') }); return; }
			trig.eventCall = call;
			if (kind === 'location' && trig.triggerVar) {
				try { (ig.vars as any).set(trig.triggerVar, 1); } catch (_) { /* ignore */ }
			}
			this.currentEventSeq = seq;
			this.currentEventActive = true;
			this.currentEventPendingSince = 0;
			this.skipRequested = false;
			this.attachEventEnd(call);
			console.log('[storysync] member replaying story event seq=' + seq + ' kind=' + kind + ' key=' + this.triggerKey(trig));
		} catch (err) {
			console.warn('[storysync] member event replay failed', err);
		}
	}

	/** True while a leader/member client is inside the synced story video (with a
	 * short grace window covering the leader-relay round trip). */
	private inSyncedStoryVideo(): boolean {
		if (!this.active) return false;
		if (this.currentEventActive) return true;
		if (this.currentEventPendingSince && Date.now() - this.currentEventPendingSince < 2500) return true;
		return false;
	}

	// ------------------------------------------------------------------- skipping

	private handleSkipKey(model: any): boolean {
		try {
			if (!this.active) return false;
			if (!this.inSyncedStoryVideo()) return false;
			if (!model || typeof model.isCutscene !== 'function' || !model.isCutscene()) return false;
			if (model.skipBlock) return false;
			if (!this.currentEventSeq) return false;
			if (this.skipRequested || this.skipPromptOpen) return true; // swallow repeats
			if (Date.now() - this.skipLastHandled < 1200) return true;
			this.skipLastHandled = Date.now();
			this.openSkipRequestPrompt();
			return true;
		} catch (_) { return false; }
	}

	private openSkipRequestPrompt(): void {
		this.skipRequested = true;
		this.skipPromptOpen = true;
		storyWindow(
			t('storySyncSkipTitle'),
			t('storySyncSkipConfirmBody').replace('{quest}', this.questLabel(this.quest)),
			[
				{
					label: t('storySyncSkipConfirm'), kind: 'primary',
					onClick: () => {
						this.skipPromptOpen = false;
						try { this.conn.storySyncSkipVote(this.currentEventSeq); } catch (_) { /* ignore */ }
						showMpToast({ title: t('storySyncSkipVoteSent') });
					},
				},
				{ label: t('storySyncSkipCancel'), kind: 'ghost', onClick: () => { this.skipPromptOpen = false; } },
			],
			false,
		);
	}

	private onSkipVoteRequested(data: { seq: number, from: string }): void {
		if (!this.active || data.seq !== this.currentEventSeq) return;
		if (data.from === this.localName()) return;
		this.skipPromptOpen = true;
		storyWindow(
			t('storySyncSkipVoteTitle'),
			t('storySyncSkipVoteBody').replace('{name}', data.from).replace('{quest}', this.questLabel(this.quest)),
			[
				{
					label: t('storySyncSkipYes'), kind: 'primary',
					onClick: () => {
						this.skipPromptOpen = false;
						try { this.conn.storySyncSkipAnswer(data.seq, true); } catch (_) { /* ignore */ }
					},
				},
				{
					label: t('storySyncSkipNo'), kind: 'danger',
					onClick: () => {
						this.skipPromptOpen = false;
						try { this.conn.storySyncSkipAnswer(data.seq, false); } catch (_) { /* ignore */ }
					},
				},
			],
			false, // never time out — the user chose "votes never expire"
		);
	}

	private onSkipVoteResult(data: { seq: number, pass: boolean, reason?: string, from?: string }): void {
		this.skipRequested = false;
		this.skipPromptOpen = false;
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
		if (data.seq !== this.currentEventSeq) {
			console.log('[storysync] stale skip result seq=' + data.seq + ' current=' + this.currentEventSeq + ' — ignored');
			return;
		}
		if (data.pass) {
			this.performSkip();
			return;
		}
		showMpToast({
			title: t('storySyncSkipRejected'),
			subtitle: data.reason === 'interrupted' ? t('storySyncSkipInterrupted')
				: data.reason === 'eventEnded' ? t('storySyncSkipEventEnded')
					: t('storySyncSkipDeclinedBy').replace('{name}', data.from || '?'),
		});
	}

	private performSkip(): void {
		try {
			const model: any = (sc as any).model;
			if (!model) return;
			if (typeof model.startSkip === 'function' && (model.isCutscene() || model.message.isMenuMode())) {
				model.startSkip();
				console.log('[storysync] unanimous skip — fast-forward locally');
			}
		} catch (_) { /* ignore */ }
	}

	// ------------------------------------------------------------------ nudges

	private onNudged(data: { from: string, quest: string, to: string[] }): void {
		if (!this.active || data.quest !== this.quest) return;
		if (Array.isArray(data.to) && data.to.length && data.to.indexOf(this.localName()) === -1) return;
		showMpToast({ title: t('storySyncNudgeTitle').replace('{name}', data.from) });
	}

	// ------------------------------------------------------------ mode exit paths

	private onEnd(data: { quest: string, reason: string, state?: any, by?: string, leader?: string }): void {
		if (data.quest !== this.quest) {
			// A server-side end for our previous quest while WE weren't active in
			// this controller can happen after a reconnect edge — just acknowledge.
			console.log('[storysync] end for non-current quest ignored: ' + data.quest + ' reason=' + data.reason);
			return;
		}
		console.log('[storysync] MODE END reason=' + data.reason + ' quest=' + this.quest);
		if (data.reason === 'complete') {
			if (!this.isLocalLeader() && !this.solvedAlready(this.quest) && data.state && data.state.finished) {
				this.tryFinishSyncedQuest(data.state);
			}
			this.exitLocal('complete', false);
			showMpToast({ title: t('storySyncCompleted'), subtitle: this.questLabel(this.quest) });
			return;
		}
		const isSelfLeave = data.reason === 'leave' && data.by === this.localName();
		this.exitLocal(data.reason, true);
		switch (data.reason) {
			case 'cancel': showMpToast({ title: t('storySyncCancelled'), subtitle: this.questLabel(this.quest) }); break;
			case 'leaderLeft':
			case 'partyEnd': showMpToast({ title: t('storySyncEndedParty'), subtitle: this.questLabel(this.quest) }); break;
			case 'leave': showMpToast({ title: t('storySyncSelfLeft') }); break;
			default: break;
		}
	}

	private solvedAlready(id: string): boolean {
		try { return !!(this.questManager() && this.questManager().isQuestSolved(id)); } catch (_) { return true; }
	}

	/** restore=true restores the pre-sync snapshot (cancel/leave/party loss);
	 * commit=true SUPPRESSES restore for a leader who just native-completed the
	 * quest locally (their live state is the completion and must persist). */
	private exitLocal(reason: string, restore: boolean, force?: boolean): void {
		try {
			if (!this.active && !this.isPendingStart && reason !== 'sessionEnd') return;
			if (this.active) {
				console.log('[storysync] exitLocal reason=' + reason + ' restore=' + restore + ' quest=' + this.quest);
				if (restore && this.snapshot) this.restoreSnapshot();
				if (!restore) this.committed = true;              // completion persists
				this.active = false;
				this.committed = true;                            // save guard disarms
				this.snapshot = null;
				this.currentEventSeq = 0;
				this.currentEventActive = false;
				this.currentEventPendingSince = 0;
				this.skipRequested = false;
				this.skipPromptOpen = false;
				this.waitingTrigger = null;
				this.waitingPromptSince = 0;
				this.waitingOpen = false;
				this.leaderCompleteAt = 0;
				this.finishedSynced = false;
				try { closeStoryWindows(); } catch (_) { /* ignore */ }
			}
			if (force || !this.active) this.pendingStartReset();
			try { this.refreshQuestButton(); } catch (_) { /* ignore */ }
		} catch (err) {
			console.warn('[storysync] exitLocal failed', err);
			// Failsafe: never leave the save guard armed after a broken exit.
			this.active = false;
			this.committed = true;
			this.snapshot = null;
		}
	}

	// ------------------------------------------------------------ trigger steps

	private installEventStepHooks(): void {
		try {
			if (this.eventStepsHooksInstalled) return;
			const ES: any = (ig as any).EVENT_STEP;
			if (!ES || !ES.START_STATIC_QUEST || !ES.SOLVE_QUEST_CONDITION) return;
			const self = this;
			const protect = function (method: string) {
				const cls = ES[method];
				if (!cls || cls._mpStoryStepHooked || typeof cls.inject !== 'function') return;
				cls._mpStoryStepHooked = true;
				const inj: any = {};
				inj.start = function (this: any, stepData: any, eventCall: any) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl && ctl.shouldSuppressEventQuestStep(this, method)) return;
					return this.parent(stepData, eventCall);
				};
				cls.inject(inj);
			};
			protect('START_STATIC_QUEST');
			protect('SOLVE_QUEST_CONDITION');
			this.eventStepsHooksInstalled = true;
			console.log('[storysync] quest event-step guards installed');
		} catch (_) { /* ignore */ }
	}

	private shouldSuppressEventQuestStep(step: any, method: string): boolean {
		try {
			if (!this.active || !this.isLocalMember()) return false;
			const target = method === 'START_STATIC_QUEST' ? step.quest : step.questId;
			return target === this.quest;
		} catch (_) { return false; }
	}

	// ---------------------------------------------------------------- quest menu

	private installQuestMenuHooks(): void {
		try {
			if (this.menuHooksInstalled) return;
			const QM: any = (sc as any).QuestMenu;
			if (!QM || typeof QM.inject !== 'function') return;
			this.menuHooksInstalled = true;
			const self = this;
			QM.inject({
				showMenu(this: any) {
					this.parent();
					try {
						const ctl: StorySyncController = (window as any).__mpStory;
						if (ctl) ctl.questMenuOpened(this);
					} catch (_) { /* UI hook must not break the menu */ }
				},
				hideMenu(this: any) {
					try {
						const ctl: StorySyncController = (window as any).__mpStory;
						if (ctl) ctl.questMenuClosed(this);
					} catch (_) { /* ignore */ }
					this.parent();
				},
				exitMenu(this: any) {
					try {
						// Native menus can reach exitMenu without hideMenu (back key,
						// defeat popups). The parallel button group MUST leave the
						// interact stack there too or it would keep listening in
						// other menus/world states.
						const ctl: StorySyncController = (window as any).__mpStory;
						if (ctl) ctl.questMenuClosed(this);
					} catch (_) { /* ignore */ }
					this.parent();
				},
			});
			console.log('[storysync] quest-menu hooks installed');
		} catch (_) { /* ignore */ }
	}

	public questMenuOpened(menu: any): void {
		try {
			this.questMenu = menu;
			this.attachQuestBarButton(menu, true);
		} catch (_) { /* ignore */ }
	}

	public questMenuClosed(menu: any): void {
		try {
			if (this.questMenuGroup && (sc as any).menu && (sc as any).menu.buttonInteract) {
				try { (sc as any).menu.buttonInteract.removeParallelGroup(this.questMenuGroup); } catch (_) { /* ignore */ }
			}
			this.questMenuGroup = null;
			this.questMenu = null;
			// Keep questMenuButton: it is a child of the menu and gets re-mounted as
			// a parallel button group on the next showMenu (re-adding it would stack
			// duplicates on every open).
		} catch (_) { /* ignore */ }
	}

	private attachQuestBarButton(menu: any, attachGroup: boolean): void {
		try {
			if (!this.questMenuButton) {
				const BT: any = (sc as any).BUTTON_TYPE;
				const btn = new (sc as any).ButtonGui(t('storySyncEntryShort'), 0, true, BT ? BT.SMALL : undefined);
				btn.keepMouseFocus = true;
				btn.setAlign((ig as any).GUI_ALIGN.X_RIGHT, (ig as any).GUI_ALIGN.Y_TOP);
				btn.setPos(8, 4);
				const self = this;
				btn.onButtonPress = function () { self.onQuestUiButton(); };
				menu.addChildGui(btn);
				this.questMenuButton = btn;
			}
			if (attachGroup && (sc as any).menu && (sc as any).menu.buttonInteract && !this.questMenuGroup) {
				const group = new (sc as any).ButtonGroup();
				group.addFocusGui(this.questMenuButton, 0, 0);
				(sc as any).menu.buttonInteract.addParallelGroup(group);
				this.questMenuGroup = group;
			}
			this.refreshQuestButton();
		} catch (_) { /* ignore */ }
	}

	private refreshQuestButton(): void {
		try {
			if (!this.questMenuButton || typeof this.questMenuButton.setText !== 'function') return;
			let label = t('storySyncEntryShort');
			if (this.active) label = this.isLocalLeader() ? t('storySyncCancelShort') : t('storySyncActiveShort');
			else if (this.isPendingStart) label = t('storySyncCheckingShort');
			this.questMenuButton.setText(label, false);
			this.questMenuButton.setActive(this.active || this.isPendingStart || this.canStartNow());
		} catch (_) { /* ignore */ }
	}

	private canStartNow(): boolean {
		return !!(this.main && Array.isArray(this.main.partyMembers) && this.main.partyMembers.length > 1 && (this.main as any).isPartyLeader);
	}

	private candidateQuestId(): string {
		const q = this.questManager();
		if (!q) return '';
		// 1) The row the player just SELECTED in the quest list (what the original
		// feature asks for), provided it is active for the leader.
		// 2) Otherwise the task currently marked with ★ (the route the persistent
		// top-bar button synchronizes).
		// 3) A single accepted quest as a last-resort convenience.
		try {
			if (this.questMenu && this.questMenu.questListBox && this.questMenu.questListBox._curElement
				&& this.questMenu.questListBox._curElement.data && this.questMenu.questListBox._curElement.data.quest) {
				const selected = this.questMenu.questListBox._curElement.data.quest;
				if (selected && selected.id && q.isQuestActive && q.isQuestActive(selected.id)) return selected.id;
			}
		} catch (_) { /* ignore */ }
		try {
			if (typeof q.getMarkedQuest === 'function') {
				const marked = q.getMarkedQuest();
				if (marked && marked.id) return marked.id;
			}
		} catch (_) { /* ignore */ }
		try {
			const list = q.getQuestList && q.getQuestList((sc as any).QUEST_LIST_TYPE.ACTIVE);
			if (Array.isArray(list) && list.length === 1 && list[0] && list[0].id) return list[0].id;
		} catch (_) { /* ignore */ }
		return '';
	}

	private onQuestUiButton(): void {
		const err = !this.active && !this.isPendingStart ? this.leaderRequestSync() : '';
		if (err) {
			showMpToast({ title: err, subtitle: this.active ? this.questLabel(this.quest) : undefined });
			return;
		}
		if (this.active) {
			if ((this.main as any).isPartyLeader) this.leaderCancelSync(false);
			else showMpToast({ title: t('storySyncActiveMember'), subtitle: this.questLabel(this.quest) });
			return;
		}
		if (!this.isPendingStart) showMpToast({ title: t('storySyncLeaderOnly') });
		// pending: the checking window is already up — ignore further presses.
	}

	// ------------------------------------------------------------- HUD strip

	private hudBarHtml(): string | null {
		if (!this.active) return null;
		let state = this.isLocalLeader() ? t('storySyncBarLeader') : t('storySyncBarMember');
		if (this.inSyncedStoryVideo()) state = t('storySyncBarPlaying');
		let html = '<span class="mpStoryBarTag">' + t('storySyncBarTitle') + '</span>'
			+ '<span>' + this.questLabel(this.quest) + '</span>'
			+ '<span class="mpStoryBarState">' + state + '</span>';
		if (this.isLocalLeader()) {
			html += '<button class="mpStoryBarCancel">' + t('storySyncBarCancel') + '</button>';
		}
		return html;
	}

	private updateHudBar(): void {
		try {
			if (typeof document === 'undefined' || !document.body) return;
			const html = this.hudBarHtml();
			if (!html) {
				if (this.hudBar) { this.hudBar.remove(); this.hudBar = null; }
				this.hudBarSignature = '';
				return;
			}
			if (!this.hudBar || !document.body.contains(this.hudBar[0])) {
				this.hudBar = $('<div class="mpStoryBar"></div>');
				$(document.body).append(this.hudBar);
				this.hudBarSignature = '';
			}
			if (this.hudBarSignature === html) return; // per-frame pump: only rebuild on change
			this.hudBarSignature = html;
			this.hudBar.html(html);
			const self = this;
			this.hudBar.off('click', '.mpStoryBarCancel');
			this.hudBar.on('click', '.mpStoryBarCancel', () => { try { self.leaderCancelSync(false); } catch (_) { /* ignore */ } });
		} catch (_) { /* ignore */ }
	}
}

/** Let netSync's cutscene-entity streamer know member replay events exist (the
 * host's authoritative enemy block already covers them — members must not also
 * stream their own cutscene monsters as csPuppets during story sync). */
export function storySyncSuppressMemberCutsceneStream(): boolean {
	try {
		const ctl: StorySyncController = (window as any).__mpStory;
		return !!(ctl && typeof ctl.isLocalMember === 'function' && ctl.isLocalMember());
	} catch (_) { return false; }
}