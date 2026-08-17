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
 *    ready-check waits until every remaining member's mirror is within the
 *    gather radius of the trigger, then the leader starts the engine event and
 *    relays {map, key, kind, type}; members replay the SAME local event while
 *    their own trigger starts are suppressed. Skip votes require every member's
 *    yes. Story NPC dialogues use a much tighter ring around the NPC.
 *  - Exit matrix:
 *      complete   -> apply final state, keep completion, one native reward for
 *                    members who hadn't solved it, stop the save guard;
 *      cancel / leaderLeft / leave / partyEnd -> restore the snapshot;
 *      a member leaving/kicked affects only that member; others keep syncing.
 */

const GATHER_RADIUS = 480;
const GATHER_Z_DELTA = 96;
/** 1.70.81: story NPC dialogues need the whole party STANDING AT the NPC, not
 * merely inside the same block. The 480px automatic-trigger radius covers most
 * of a map block; NPC gather uses a much tighter ring around the character. */
const NPC_GATHER_RADIUS = 160;
const STATE_SEND_INTERVAL = 0.25;   // seconds — leader quest-state coalescing
const STATE_HEARTBEAT = 1.5;        // seconds — periodic re-send for self-heal
const NUDGE_PROMPT_COOLDOWN = 8000; // ms — don't spam the waiting popup
const CHECK_LOCAL_TIMEOUT = 17000;  // ms — belt-and-braces vs the server's 15s
const SUPPRESS_TOAST_COOLDOWN = 4000;
/** Synthetic target for the MAIN-STORY sync mode. Not a static quest: the
 * top-bar button syncs this while the quest LIST is open; a selected static
 * quest is only synced from the quest DETAIL page (支线任务同步). */
const PLOT_QUEST_ID = 'plot.main';

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
.mpStoryScrim { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh;
	z-index: 10010; background: rgba(0,0,0,0.62); animation: mpStoryFade 0.15s ease-out; }
.mpStoryBox { position: fixed; left: 50%; top: 50%; transform: translate(-50%,-50%);
	width: 680px; max-width: 92vw; background: rgba(6,18,30,0.96);
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
.mpTriggerBanner { position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
	z-index: 9996; display: flex; align-items: center; gap: 10px; max-width: 94vw;
	padding: 7px 14px; background: rgba(6,18,30,0.92); border: 1px solid #6fc7ff;
	border-radius: 8px; color: #dff3ff;
	font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif;
	font-size: 13px; box-shadow: 0 0 12px rgba(111,199,255,0.35); }
.mpTriggerBanner .mpTriggerTag { color: #6fc7ff; font-weight: bold; white-space: nowrap; }
.mpTriggerBanner .mpTriggerState { color: #ffd98c; white-space: nowrap; }
.mpTriggerBanner .mpTriggerRows { display: flex; align-items: center; gap: 6px; }
.mpTriggerBanner .mpDiamond { width: 12px; height: 12px; transform: rotate(45deg);
	display: inline-block; image-rendering: pixelated; }
.mpTriggerBanner .mpDiamond.on { background: #5be36e; box-shadow: 0 0 6px rgba(91,227,110,0.8); }
.mpTriggerBanner .mpDiamond.off { background: #66727a; box-shadow: none; }
.mpTriggerBanner button { background: #155a86; color: #eaf7ff; border: 1px solid #6fc7ff;
	border-radius: 999px; padding: 3px 12px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.mpTriggerBanner button:hover { background: #1d79b7; }
.mpTriggerBanner button:disabled { opacity: 0.5; cursor: default; }
.mpTriggerBanner button.mpSkipVoteYes { background: #1f7a45; border-color: #5be36e; color: #eafff0; }
.mpTriggerBanner button.mpSkipVoteYes:hover { background: #29965a; }
.mpTriggerBanner button.mpSkipVoteNo { background: #5c1f28; border-color: #ff8e9f; color: #ffe3e7; }
.mpTriggerBanner button.mpSkipVoteNo:hover { background: #7c2a36; }
.mpStoryComm { position: fixed; left: 0; top: 0; width: 100vw; height: 100vh;
	z-index: 10030; pointer-events: none; text-align: center;
	padding-top: calc(33vh - 130px); animation: mpStoryCommBack 3.4s ease forwards; }
.mpStoryCommGlow { position: absolute; left: 50%; top: calc(33vh - 130px); width: 640px; height: 220px;
	transform: translate(-50%,-50%); border-radius: 50%;
	background: radial-gradient(circle, rgba(255,198,64,0.28) 0%, rgba(255,198,64,0.06) 55%, transparent 72%);
	filter: blur(6px); animation: mpStoryCommPulse 1.5s ease-in-out infinite; }
.mpStoryCommDuty { position: relative; font-family: 'Noto Sans SC','Microsoft YaHei',sans-serif;
	font-size: 27px; font-weight: bold; letter-spacing: 12px; color: #8fd6ff;
	text-shadow: 0 0 12px rgba(111,199,255,0.8); margin-bottom: 14px;
	animation: mpStoryZoomIn 0.38s cubic-bezier(.2,1.4,.4,1) forwards; }
.mpStoryCommTitle { position: relative; font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif;
	font-size: 62px; font-weight: 900; letter-spacing: 10px; color: #ffd068;
	background: linear-gradient(180deg, #fff7cf 12%, #ffe08a 38%, #f4a91c 62%, #8a5110 95%);
	-webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
	text-shadow: 0 3px 0 rgba(70,35,0,0.45), 0 0 26px rgba(255,196,80,0.95);
	animation: mpStoryZoomIn 0.5s cubic-bezier(.2,1.5,.4,1) forwards; }
.mpStoryCommSub { position: relative; margin-top: 16px; font-size: 16px; letter-spacing: 3px;
	color: #eaf7ff; text-shadow: 0 0 10px rgba(111,199,255,0.9);
	animation: mpStoryZoomIn 0.62s cubic-bezier(.2,1.5,.4,1) forwards; }
.mpStoryCommLine { position: relative; width: 520px; max-width: 76vw; height: 2px;
	margin-top: 10px; background: linear-gradient(90deg, transparent, #ffd068 18%, #fff7cf 50%, #ffd068 82%, transparent);
	transform: scaleX(0); animation: mpStoryLine 0.5s ease-out 0.18s forwards; }
@keyframes mpStoryCommBack { 0%, 82% { opacity: 1; } 100% { opacity: 0; visibility: hidden; } }
@keyframes mpStoryZoomIn { 0% { transform: scale(0.55); opacity: 0; } 100% { transform: scale(1); opacity: 1; } }
@keyframes mpStoryLine { to { transform: scaleX(1); } }
@keyframes mpStoryCommPulse { 0%,100% { opacity: 0.55; transform: translate(-50%,-50%) scale(0.9); }
	50% { opacity: 0.95; transform: translate(-50%,-50%) scale(1.05); } }
.mpStoryStar { position: fixed; right: 14px; bottom: 14px; z-index: 9995;
	width: 40px; height: 40px; pointer-events: auto; cursor: help;
	display: flex; align-items: center; justify-content: center;
	filter: drop-shadow(0 0 6px rgba(255,205,70,0.8));
	animation: mpStarGleam 1.6s ease-in-out infinite; }
.mpStoryStar svg { width: 36px; height: 36px; image-rendering: pixelated;
	shape-rendering: crispEdges; overflow: visible; }
.mpStoryStar:hover { transform: scale(1.08); cursor: help; }
@keyframes mpStarGleam { 0%,100% { filter: drop-shadow(0 0 6px rgba(255,205,70,0.8)); }
	50% { filter: drop-shadow(0 0 13px rgba(255,220,90,0.95)); } }
.mpStoryStar::after { content: attr(data-tip); position: absolute; right: 44px; top: 50%;
	transform: translateY(-50%) translateX(-6px); background: rgba(6,18,30,0.96);
	border: 1px solid #6fc7ff; border-radius: 6px; padding: 8px 12px; color: #dff3ff;
	font-family: 'Noto Sans SC','Microsoft YaHei','Segoe UI',sans-serif; font-size: 13px;
	white-space: nowrap; opacity: 0; pointer-events: none;
	transition: opacity 0.15s ease, transform 0.15s ease; }
.mpStoryStar:hover::after { opacity: 1; transform: translateY(-50%) translateX(0); }
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

	private skipVoteSeq = 0;
	private skipVoteFrom = '';
	private skipVoteAnswers: { [name: string]: boolean } = Object.create(null);
	private skipVoteBanner: JQuery | null = null;
	private skipVoteSignature = '';
	private skipLastHandled = 0;

	private questMenu: any = null;
	private questMenuButton: any = null;
	private questMenuHotkeyFn: (() => any) | null = null;
	private questButtonSignature = '';
	private triggerBanner: JQuery | null = null;
	private triggerBannerKey = '';
	private triggerBannerSignature = '';
	private triggerBannerTrig: any = null;
	private triggerBannerKind: 'trigger' | 'location' | 'npc' = 'trigger';
	private triggerBannerSeenAt = 0;
	private triggerBannerSent = false;
	private triggerZoneLog: { [key: string]: number } = Object.create(null);
	private leaderCameraHandle: any = null;
	private leaderCameraEntity: any = null;
	private leaderCameraBaseCount = 0;
	private localHideApplied = false;
	private localHideBaseAlpha = 1;

	/** 1.70.79: capture the camera-stack depth BEFORE a story event starts.
	 * NPC/EventTrigger starts push their own camera targets synchronously, so
	 * recording the baseline later made end-cleanup keep the event target —
	 * the member's view stayed on the last NPC/camera position. */
	private prepareLeaderCameraBase(): void {
		try {
			if (this.leaderCameraBaseCount > 0) return;
			const cam: any = (ig as any).camera;
			if (!cam) return;
			this.leaderCameraBaseCount = (typeof cam.getTargetCount === 'function')
				? cam.getTargetCount() : (Array.isArray(cam.targets) ? cam.targets.length : 0);
		} catch (_) { /* ignore */ }
	}
	private npcHookInstalled = false;
	private npcApplyBypass = false;
	private hudStar: JQuery | null = null;

	private updateRegistered = false;
	private questObserverInstalled = false;
	private saveGuardInstalled = false;
	private rawQuestSave: any = null;
	private plotSaveGuardInstalled = false;
	private rawVarsGetJson: any = null;
	private mainPlotSnapshot: number | null = null;
	private triggersInstalled = false;
	private modelSkipInstalled = false;
	private cutsceneWrapperInstalled = false;
	private messageHookInstalled = false;
	private dialogApplyBypass = false;
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
					+ ' skipVote=' + self.skipVoteSeq
					+ ' waiting=' + !!(self.waitingTrigger)
					+ ' triggerBanner=' + self.triggerBannerKey);
				if (self.active && q) {
					const st = self.serializeQuestState(self.quest);
					console.log('[mpstory] local quest state:', JSON.stringify(st));
				}
			} catch (e) { console.warn('[mpstory] failed', e); }
		};
		// Trigger-zone diagnostic: list every EventTrigger/LocationEvent near the
		// local player and why it is/isn't ready. Run it AT the silent story
		// point when "everyone arrived but nothing played" and send the lines.
		(window as any).__mpstorytrig = () => {
			try {
				const g: any = ig.game;
				const player = g && g.playerEntity;
				const ents: any[] = (g && g.entities) || [];
				const ET: any = (ig.ENTITY as any).EventTrigger;
				const LE: any = (ig.ENTITY as any).LocationEvent;
				let n = 0;
				for (const e of ents) {
					if (!e || e._killed || !e.coll) continue;
					const isT = ET && e instanceof ET;
					const isL = LE && e instanceof LE;
					if (!isT && !isL) continue;
					const d = player && player.coll ? Math.round(Math.sqrt(
						Math.pow(e.coll.pos.x - player.coll.pos.x, 2) + Math.pow(e.coll.pos.y - player.coll.pos.y, 2))) : -1;
					if (d > 700) continue;
					n++;
					let cond = '-', end = '-', hasEvent = !!e.event, raw = !!e._mpStorySettings;
					try { cond = e.startCondition ? String(e.startCondition.evaluate()) : '-'; } catch (_) { cond = 'throw'; }
					try { end = e.endCondition ? String(e.endCondition.evaluate()) : '-'; } catch (_) { end = 'throw'; }
					let tv = '-';
					try { tv = e.triggerVar ? String((ig.vars as any).get(e.triggerVar)) : '-'; } catch (_) { tv = 'throw'; }
					console.log('[mpstorytrig] ' + (isT ? 'EVENT-TRIGGER' : 'LOCATION-EVENT')
						+ ' name=' + (e.name || '(none)') + ' mapId=' + e.mapId
						+ ' dist=' + d + ' type=' + e.eventType
						+ ' start=' + cond + ' end=' + end + ' var=' + tv
						+ ' event=' + hasEvent + ' rawSettings=' + raw
						+ ' pos=' + Math.round(e.coll.pos.x) + ',' + Math.round(e.coll.pos.y) + ' z=' + Math.round(e.coll.pos.z));
				}
				if (!n) console.log('[mpstorytrig] no story trigger within 700px of the player');
				if (!self.active) console.log('[mpstorytrig] NOT in story-sync mode (this only works while syncing)');
			} catch (e) { console.warn('[mpstorytrig] failed', e); }
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
		try { c.onStorySyncNpcRequest((data) => this.onNpcRequest(data)); } catch (e) { console.error('[storysync] wire npcRequest failed', e); }
		try { c.onStorySyncEnd((data) => this.onEnd(data)); } catch (e) { console.error('[storysync] wire end failed', e); }
		try { c.onStorySyncSkipVote((data) => this.onSkipVoteRequested(data)); } catch (e) { console.error('[storysync] wire skipVote failed', e); }
		try { c.onStorySyncSkipVoteUpdate((data) => this.onSkipVoteUpdate(data)); } catch (e) { console.error('[storysync] wire skipVoteUpdate failed', e); }
		try { c.onStorySyncSkipResult((data) => this.onSkipVoteResult(data)); } catch (e) { console.error('[storysync] wire skipResult failed', e); }
		try { c.onStorySyncNudge((data) => this.onNudged(data)); } catch (e) { console.error('[storysync] wire nudge failed', e); }
		try { c.onStorySyncDialogNext((data) => this.onDialogNext(data)); } catch (e) { console.error('[storysync] wire dialogNext failed', e); }
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
	/** 1.70.70: true while a synced story video is actually running (used by
	 * netSync's mirror-fade decision-maker to hide every non-leader character). */
	public storyEventActive(): boolean { return this.active && this.inSyncedStoryVideo(); }
	/** The authoritative story host's username (the one mirror that stays visible). */
	public storyLeader(): string { return this.leader; }

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

	private isPlotQuest(id: string): boolean {
		return id === PLOT_QUEST_ID;
	}

	/** Main-story progress lives in the global var `plot.line` (the engine's
	 * chapter index derives from it). CrossCode has no "accept" step for the
	 * main story, so in plot mode every loaded save is eligible; the leader's
	 * plotline is later streamed as the authoritative story position. */
	private mainPlotLine(): number | null {
		try {
			if (!(ig as any).vars || typeof (ig as any).vars.get !== 'function') return null;
			const v = Number((ig as any).vars.get('plot.line'));
			return isFinite(v) ? v : null;
		} catch (_) { return null; }
	}

	private questStatus(id: string): { available: boolean, active: boolean, solved: boolean } {
		if (this.isPlotQuest(id)) {
			const line = this.mainPlotLine();
			return { available: line !== null, active: line !== null, solved: false };
		}
		const q = this.questManager();
		if (!q || typeof q.isQuestActive !== 'function' || typeof q.isQuestSolved !== 'function') {
			return { available: false, active: false, solved: false };
		}
		return { available: true, active: !!q.isQuestActive(id), solved: !!(q.isQuestSolved && q.isQuestSolved(id)) };
	}

	private questLabel(id: string): string {
		try {
			if (this.isPlotQuest(id)) return t('storySyncMainLabel');
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
			if (this.isPlotQuest(id)) {
				const line = this.mainPlotLine() || 0;
				return { id, task: line, highest: line, finished: false, completed: [], labels: {} };
			}
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

	/** Main-story mode must ALSO protect `plot.line` from persisting during sync:
	 * the global vars are serialized through ig.vars.getJson() on every save, so
	 * wrap it once and substitute the pre-sync plotline while active/uncommitted. */
	private installPlotSaveGuard(): void {
		try {
			if (this.plotSaveGuardInstalled) return;
			const v: any = (ig as any).vars;
			if (!v || typeof v.getJson !== 'function') return;
			this.plotSaveGuardInstalled = true;
			this.rawVarsGetJson = v.getJson;
			const self = this;
			v.getJson = function () {
				try {
					const out = self.rawVarsGetJson.call(v);
					if (out && out.storage && self.active && !self.committed
						&& self.isPlotQuest(self.quest) && self.mainPlotSnapshot !== null) {
						out.storage.plot = out.storage.plot || {};
						out.storage.plot.line = self.mainPlotSnapshot;
					}
					return out;
				} catch (_) {
					try { return self.rawVarsGetJson.call(v); } catch (__) { return null; }
				}
			};
			console.log('[storysync] plot.line save guard installed');
		} catch (_) { /* ignore */ }
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
			// Main-story mode additionally snapshots plot.line here (same moment).
			if (this.isPlotQuest(this.quest)) {
				const line = this.mainPlotLine();
				if (line === null) return false;
				this.mainPlotSnapshot = line;
			}
			return true;
		} catch (err) {
			console.error('[storysync] snapshot capture failed', err);
			this.snapshot = null;
			this.mainPlotSnapshot = null;
			return false;
		}
	}

	private restoreSnapshot(): void {
		// Main-story plotline first, and unconditionally: quest data may be
		// unavailable during a forced session teardown, but plot.line MUST go
		// back to the player's own save regardless.
		try {
			if (this.isPlotQuest(this.quest) && this.mainPlotSnapshot !== null
				&& (ig as any).vars && typeof (ig as any).vars.set === 'function') {
				(ig as any).vars.set('plot.line', this.mainPlotSnapshot);
				if ((ig.game as any).varsChangedDeferred) (ig.game as any).varsChangedDeferred();
			}
		} catch (_) { /* ignore */ }
		const q = this.questManager();
		if (!q || !this.snapshot || typeof q.onStoragePreLoad !== 'function') {
			this.snapshot = null;
			this.mainPlotSnapshot = null;
			return;
		}
		try {
			q.onStoragePreLoad({ quests: this.plainClone(this.snapshot) });
			try { if ((ig.game as any).varsChangedDeferred) (ig.game as any).varsChangedDeferred(); } catch (_) { /* ignore */ }
			console.log('[storysync] quest snapshot restored (' + this.quest + ')');
		} catch (err) {
			console.error('[storysync] snapshot restore failed', err);
		} finally {
			this.snapshot = null;
			this.mainPlotSnapshot = null;
		}
	}

	// --------------------------------------------------------- start handshake

	/** Quest-menu entry: leader requests the mode for the currently selected (or
	 * marked) quest. Returns a user-facing string for validation failures. */
	public leaderRequestSync(): string {
		if (this.active) { return t('storySyncAlreadyActive'); }
		if (this.isPendingStart) { return t('storySyncStillChecking'); }
		const id = this.candidateQuestId();
		if (!id) { return t('storySyncNoQuestSelected'); }
		return this.beginLeaderSyncRequest(id);
	}

	/** Top-bar 剧情同步 (quest LIST page): sync the MAIN STORY itself. No static
	 * quest needs to be accepted — every save's plot.line is always eligible. */
	public leaderRequestMainPlotSync(): string {
		if (this.active) { return t('storySyncAlreadyActive'); }
		if (this.isPendingStart) { return t('storySyncStillChecking'); }
		return this.beginLeaderSyncRequest(PLOT_QUEST_ID);
	}

	private beginLeaderSyncRequest(id: string): string {
		const roster = Array.isArray(this.main.partyMembers) ? this.main.partyMembers : [];
		if (roster.length < 2) { return t('storySyncNeedParty'); }
		if (!(this.main as any).isPartyLeader) { return t('storySyncLeaderOnly'); }
		const st = this.questStatus(id);
		if (!st.available) { return t('storySyncQuestEngineUnavailable'); }
		if (!this.isPlotQuest(id) && (!st.active || st.solved)) { return t('storySyncLeaderQuestMustBeActive'); }
		this.pendingQuest = id;
		this.pendingReqId = '';
		this.pendingAt = Date.now();
		this.isPendingStart = true;
		this.installSaveGuard();
		this.installPlotSaveGuard();
		try { this.conn.storySyncRequest(id); } catch (e) { this.pendingStartReset(); return t('storySyncNetworkError'); }
		console.log('[storysync] requested ' + (this.isPlotQuest(id) ? 'MAIN STORY' : 'quest=' + id));
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
		const bodyKey = this.isPlotQuest(this.pendingQuest) ? 'storySyncCheckingBodyMain' : 'storySyncCheckingBody';
		const handle = storyWindow(t('storySyncCheckingTitle'), t(bodyKey).replace('{quest}', this.questLabel(this.pendingQuest)), [
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
		this.installPlotSaveGuard();
		this.quest = data.quest;
		this.leader = data.leader;
		this.members = Array.isArray(data.members) ? data.members.slice() : [];
		this.snapshot = null;
		this.mainPlotSnapshot = null;
		this.committed = false;
		this.finishedSynced = false;
		this.currentEventSeq = 0;
		this.currentEventActive = false;
		this.currentEventPendingSince = 0;
		this.resetSkipVote();
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
		// 1.70.62: auto-close any open menu (backpack/quest/quick menu) on BOTH
		// sides, then broadcast the FF14-style "duty commenced" text banner to the
		// whole party.
		try { this.closeGameMenus(); } catch (_) { /* ignore */ }
		try { this.playCommencementBanner(); } catch (_) { /* ignore */ }
	}

	private lockQuestHud(): void {
		if (this.isPlotQuest(this.quest)) return; // main story has no quest-star lock
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
			// Main-story state: just move the plotline and let the engine's
			// varsChanged pump recalculate the chapter/lore.
			if (this.isPlotQuest(this.quest)) {
				const line = Math.max(0, Number(state.task) || 0);
				(ig as any).vars.set('plot.line', line);
				if ((ig.game as any).varsChangedDeferred) (ig.game as any).varsChangedDeferred();
				return;
			}
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
			if (this.isPlotQuest(this.quest)) return; // main story has no quest reward path
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
			this.updateGameStar();
			if (this.questMenu) { try { this.refreshQuestButton(); } catch (_) { /* ignore */ } }
			this.updateTriggerBanner();
			this.updateWaitingPrompt();
			this.updateLeaderCamera();
			this.updateLocalPlayerStoryHide();
		} catch (_) { /* never break the frame */ }
	}

	private ensureEngineHooks(): void {
		this.installQuestObserver();
		this.installSaveGuard();
		this.installPlotSaveGuard();
		this.installModelSkipHook();
		this.installCutsceneWrapper();
		this.installMessageHook();
		this.installNpcHook();
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

	/** 1.70.68 dialogue sync: any party member pressing "next" inside the current
	 * synced story video advances the message on EVERY client. We only relay
	 * while a dialogue is actually blocking (showMessage set blocking=true) and
	 * there is no open CHOICE (choices branch the story — they stay local). */
	private installMessageHook(): void {
		try {
			if (this.messageHookInstalled) return;
			const MSG: any = (sc as any).MessageModel;
			if (!MSG || typeof MSG.inject !== 'function') return;
			this.messageHookInstalled = true;
			MSG.inject({
				onInteraction(this: any) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl) {
						if (ctl.dialogApplyBypass) return this.parent();
						if (ctl.shouldRelayDialogNext(this)) {
							this.parent();
							try { ctl.conn.storySyncDialogNext(); } catch (_) { /* ignore */ }
							return undefined;
						}
					}
					return this.parent();
				},
			});
			console.log('[storysync] message-onInteraction hook installed');
		} catch (_) { /* ignore */ }
	}

	/** Called inside the wrapper for every local "next". */
	public shouldRelayDialogNext(msg: any): boolean {
		try {
			if (!this.active || !this.inSyncedStoryVideo()) return false;
			if (!msg || !msg.blocking) return false;
			if (msg.hasChoice && msg.hasChoice()) return false;
			return true;
		} catch (_) { return false; }
	}

	private onDialogNext(data: { from: string, quest: string }): void {
		try {
			if (!this.active || data.quest !== this.quest || data.from === this.localName()) return;
			if (!this.inSyncedStoryVideo()) return;
			const msg: any = (sc as any).model && (sc as any).model.message;
			if (!msg || !msg.blocking || (msg.hasChoice && msg.hasChoice())) return;
			if (typeof msg.onInteraction !== 'function') return;
			this.dialogApplyBypass = true;
			try { msg.onInteraction(); } finally { this.dialogApplyBypass = false; }
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
		// Only the SIDE-quest sync mode locks the star/favorite mark. Main-story
		// sync must leave the quest tab fully usable.
		return this.isLocalMember() && !this.isPlotQuest(this.quest);
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
			if (ev && ev._mpBlockerEvent) return false; // 1.70.76: local gate scenes always play
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
					// 1.70.76: blocker/entry-gate scenes are started DIRECTLY per client.
					// No gather, no broadcast, no leader authority. The direct start
					// also bypasses the member-side Cutscene.startEvent suppression by
					// carrying the allow-token, so the gate really plays everywhere.
					if (ctl && ctl.shouldPlayBlockerLocally(this)) {
						if (!ctl.startBlockerLocally(this)) {
							const prev = (window as any).__mpStoryRun;
							(window as any).__mpStoryRun = { allow: true };
							try { this.parent(); } finally {
								if (prev === undefined) delete (window as any).__mpStoryRun;
								else (window as any).__mpStoryRun = prev;
							}
						}
						return;
					}
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

	/** 1.70.71: gate STORY NPC interactions the same way as automatic triggers.
	 * Trade/shop/arena/quest NPC events stay native; only SIMPLE dialogue NPCs
	 * (and xeno callback dialogues) enter the gather flow. */
	private installNpcHook(): void {
		try {
			if (this.npcHookInstalled) return;
			const NPC: any = (ig.ENTITY as any).NPC;
			if (!NPC || typeof NPC.inject !== 'function') return;
			this.npcHookInstalled = true;
			NPC.inject({
				onInteraction(this: any) {
					const ctl: StorySyncController = (window as any).__mpStory;
					if (ctl) {
						if (ctl.npcApplyBypass) return this.parent();
						if (ctl.maybeGateNpcInteraction(this)) return undefined;
					}
					return this.parent();
				},
			});
			console.log('[storysync] NPC interaction gate installed');
		} catch (_) { /* ignore */ }
	}

	public maybeGateNpcInteraction(npc: any): boolean {
		try {
			if (!this.active || !npc || npc._killed) return false;
			if (npc.eventCall && typeof npc.eventCall.isRunning === 'function' && npc.eventCall.isRunning()) return false;
			const st = npc.npcStates && npc.npcStates[npc.activeStateIdx];
			if (!st) return false;
			const EV_TYPE: any = (sc as any).NPC_EVENT_TYPE;
			// 1.70.74: only QUEST-type NPCs join the story gather. Ordinary SIMPLE
			// dialogue NPCs keep playing locally per player — nobody else is
			// forced to read a normal conversation.
			const isQuest = st.npcEventObj && st.npcEventType === (EV_TYPE ? EV_TYPE.QUEST : 2)
				&& st.npcEventObj instanceof (ig as any).Event;
			if (!isQuest) return false;
			const map = (ig.game as any).mapName || '';
			const key = this.triggerKey(npc);
			if (!map || !key) return false;
			this.showTriggerBanner(npc, 'npc');
			try { this.conn.storySyncNpcRequest(this.quest, map, key); } catch (_) { /* ignore */ }
			console.log('[storysync] story NPC interaction waiting for party: ' + key);
			return true;
		} catch (_) { return false; }
	}

	private onNpcRequest(data: { from: string, quest: string, map: string, key: string }): void {
		try {
			if (!this.active || data.quest !== this.quest || data.from === this.localName()) return;
			if (((ig.game as any).mapName || '') !== data.map) return;
			const npc = this.findNpc(data.key);
			if (npc) this.showTriggerBanner(npc, 'npc');
			else console.log('[storysync] npc gather request for a map/npc we cannot see (key=' + data.key + ')');
		} catch (_) { /* ignore */ }
	}

	private findNpc(key: string): any {
		try {
			const NPC: any = (ig.ENTITY as any).NPC;
			const entities: any[] = (ig.game as any).entities || [];
			for (let i = 0; i < entities.length; i++) {
				const e = entities[i];
				if (!e || e._killed || !(NPC && e instanceof NPC)) continue;
				if (this.triggerKey(e) === key) return e;
				if (e.name && String(e.name) === key) return e;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	/** Leader-side: everyone is at the story NPC — run the ORIGINAL NPC
	 * interaction (native blocking event + enterCutscene) and relay it. */
	private startAuthoritativeNpcEvent(npc: any): void {
		try {
			const map = (ig.game as any).mapName || '';
			const key = this.triggerKey(npc);
			if (!map || !key) return;
			const EV: any = (ig as any).EVENT_TYPE || {};
			const type = EV.CUTSCENE || 2;
			this.prepareLeaderCameraBase(); // 1.70.79: BEFORE the NPC pushes its own camera target
			console.log('[storysync] starting authoritative NPC story key=' + key
				+ ' name=' + (npc.name || '(none)') + ' map=' + map);
			this.npcApplyBypass = true;
			try { npc.onInteraction(); } finally { this.npcApplyBypass = false; }
			if (!npc.eventCall) {
				showMpToast({ title: t('storySyncTriggerStartFailed') });
				return;
			}
			this.currentEventActive = true;
			this.currentEventPendingSince = 0;
			this.resetSkipVote();
			this.attachEventEnd(npc.eventCall);
			try { this.conn.storySyncEvent(this.quest, map, key, 'npc', type); } catch (_) { /* ignore */ }
		} catch (err) {
			console.warn('[storysync] authoritative NPC event start failed', err);
		}
	}

	private memberReplayNpcEvent(npc: any, seq: number): void {
		try {
			console.log('[storysync] member replaying NPC story seq=' + seq + ' key=' + this.triggerKey(npc));
			this.prepareLeaderCameraBase(); // 1.70.79: before the local NPC start pushes camera
			this.npcApplyBypass = true;
			try { npc.onInteraction(); } finally { this.npcApplyBypass = false; }
			if (npc.eventCall) {
				this.currentEventSeq = seq;
				this.currentEventActive = true;
				this.currentEventPendingSince = 0;
				this.resetSkipVote();
				this.attachEventEnd(npc.eventCall);
			}
		} catch (err) {
			console.warn('[storysync] member NPC replay failed', err);
		}
	}

	/** 1.70.72: classify a trigger as a BLOCKER (barrier / before-enter / runner
	 * gate) rather than a party story beat. Heuristic (fail-open to gather for
	 * anything plot-progressing or teleporting):
	 *   - any CHANGE_VAR_NUMBER of plot.line or TELEPORT -> NOT a blocker;
	 *   - otherwise a name matching block/barrier/before/runaway (or the known
	 *     Berg/Trail/Apollo gates) -> blocker;
	 *   - otherwise an NPC-runner sequence (SET/RESET_NPC_RUNNERS) with no
	 *     plot/teleport steps -> blocker.
	 * Blockers play natively on each client, so a lone player is stopped at the
	 * gate exactly like solo play. */
	private isBlockerTrigger(trig: any): boolean {
		try {
			if (!trig) return false;
			const raw = trig._mpStorySettings || null;
			const evType = Number(trig.eventType) || 0;
			const EV: any = (ig as any).EVENT_TYPE || {};
			if (evType === EV.PARALLEL || (EV.PARALLEL === undefined && evType === 1)) return false;
			const name = String((trig.name || (raw && raw.name) || '') as string);
			const steps = raw && raw.event;
			let hasPlot = false;
			let hasTeleport = false;
			let hasRunner = false;
			let hasArMsg = false;
			const walk = (v: any): void => {
				if (v === null || v === undefined) return;
				if (Array.isArray(v)) { for (const x of v) walk(x); return; }
				if (typeof v !== 'object') return;
				if (typeof v.type === 'string') {
					if (v.type === 'TELEPORT') hasTeleport = true;
					if (v.type === 'SET_NPC_RUNNERS' || v.type === 'RESET_NPC_RUNNERS') hasRunner = true;
					if (v.type === 'SHOW_AR_MSG') hasArMsg = true;
					if (v.type === 'CHANGE_VAR_NUMBER'
						&& v.varName && String(v.varName).indexOf('plot.line') === 0) hasPlot = true;
				}
				for (const k in v) walk(v[k]);
			};
			walk(steps);
			const BLOCKER_NAMES = new Set(['BeforeEnteringTheMine', 'BeforeTrailBuldingEnter',
				'BeforeTrailBuldingEnter2', 'ApolloBlocker', 'ApollBarrier1', 'ApollBarrier2',
				'runAwayBlocker', 'BeforeDoorScene']);
			// 1.70.77: known gate names take precedence. BeforeEnteringTheMine
			// contains a plot/teleport branch (the "yes, enter the dungeon" choice),
			// but it is still an entry gate — it must play locally, not as a party
			// story beat, otherwise one player's choice teleports/affects everyone.
			if (BLOCKER_NAMES.has(name)) return true;
			if (hasPlot || hasTeleport) return false;
			// SHOW_AR_MSG is the engine's "Access denied"-style HUD warning used
			// by entry gates — never a party story beat.
			if (hasArMsg) return true;
			if (/block|barrier|before|runaway|gate|deny|forbid|access/i.test(name)) return true;
			if (hasRunner && name && /npc|runner|gate|before|block|barrier/i.test(name)) return true;
			return false;
		} catch (_) { return false; }
	}

	/** 1.70.74: blocker triggers are NOT story beats — they play locally on
	 * whichever client reaches them (nobody else is forced to read them). */
	public shouldPlayBlockerLocally(trig: any): boolean {
		try {
			if (!this.active || !trig) return false;
			if (trig.eventCall && typeof trig.eventCall.isRunning === 'function' && trig.eventCall.isRunning()) return false;
			return this.isBlockerTrigger(trig);
		} catch (_) { return false; }
	}

	/** 1.70.76: actually START the blocker locally, directly from the trigger's
	 * own loaded/raw event. Returns true when the controller launched it; false
	 * means the trigger was not ready (the caller then falls back to a native
	 * update under the allow-token, which is a no-op for the same reason). */
	public startBlockerLocally(trig: any): boolean {
		try {
			if (!this.active || !this.isBlockerTrigger(trig)) return false;
			const g: any = ig.game;
			if (!g || typeof g.isEventStartReady !== 'function' || !g.isEventStartReady()) return false;
			if (!trig.startCondition || !trig.startCondition.evaluate()) return false;
			if (trig.endCondition && trig.endCondition.evaluate()) return false;
			if (trig.triggerVar && (ig.vars as any).get(trig.triggerVar)) return false;
			if (g.isTeleporting && g.isTeleporting()) return false;
			const ev = this.triggerEventOf(trig);
			if (!ev) return false;
			try { ev._mpBlockerEvent = true; } catch (_) { /* ignore */ }
			const EV: any = (ig as any).EVENT_TYPE || {};
			const type = Number(trig.eventType) || EV.CUTSCENE || 2;
			const prev = (window as any).__mpStoryRun;
			(window as any).__mpStoryRun = { allow: true };
			let call: any = null;
			try {
				call = (sc as any).Cutscene.startEvent(type, ev, trig.name || ('mpBlocker:' + this.triggerKey(trig)));
			} finally {
				if (prev === undefined) delete (window as any).__mpStoryRun;
				else (window as any).__mpStoryRun = prev;
			}
			if (!call) return false;
			trig.eventCall = call;
			if (trig.triggerVar) {
				try { (ig.vars as any).set(trig.triggerVar, true); } catch (_) { /* ignore */ }
			}
			console.log('[storysync] blocker cutscene played LOCALLY (no relay): key='
				+ this.triggerKey(trig) + ' name=' + (trig.name || '(none)') + ' type=' + type);
			return true;
		} catch (_) { return false; }
	}

	/** Returns true when the controller consumed the frame (the caller skips its
	 * native update). Ready-check mirrors the engine's own trigger predicates. */
	public maybeGateTrigger(trig: any, kind: 'trigger' | 'location'): boolean {
		try {
			if (!this.active) return false;
			if (!trig || !trig.coll) return false;
			const EV: any = (ig as any).EVENT_TYPE || {};
			// 1.70.66: gate ONLY story events. PARALLEL EventTriggers (snow on/off,
			// ambient effects) and every LocationEvent are environmental — they must
			// keep running natively on each client, otherwise we swallow harmless
			// weather switches and spam "entered trigger zone" for non-story spots.
			if (kind === 'location') return false;
			const typeNum = Number(trig.eventType) || (EV.PARALLEL || 1); // same default as ig.ENTITY.EventTrigger
			if (typeNum === EV.PARALLEL || (EV.PARALLEL === undefined && typeNum === 1)) return false;
			// 1.70.72: entry-gate / blocker scenes never gather. These cutscenes
			// exist to STOP a player crossing into a dungeon (e.g.
			// bergen.mine-entrance BeforeEnteringTheMine): waiting for the whole
			// party would leave the barrier open and let players walk through.
			// They play natively per client instead.
			if (this.isBlockerTrigger(trig)) return false;
			this.triggerBannerSeenAt = Date.now();
			const g: any = ig.game;
			if (!g || typeof g.isEventStartReady !== 'function') return false;
			let ready = false;
			if (kind === 'trigger') {
				if (!g.isEventStartReady()) {
					this.clearTriggerBannerIf(trig, kind);
					return false;
				}
				const running = trig.eventCall && typeof trig.eventCall.isRunning === 'function' && trig.eventCall.isRunning();
				if (running) return false;
				ready = trig.startCondition && trig.startCondition.evaluate() && !(trig.endCondition && trig.endCondition.evaluate())
					&& !(trig.triggerVar && (ig.vars as any).get(trig.triggerVar)) && !g.isTeleporting();
			} else {
				if (trig.eventCall && typeof trig.eventCall.isRunning === 'function' && trig.eventCall.isRunning()) return false;
				if (trig.triggerVar && (ig.vars as any).get(trig.triggerVar)) { this.clearTriggerBannerIf(trig, kind); return false; }
				ready = this.locationEventReady(trig);
			}
			if (!ready) {
				this.clearTriggerBannerIf(trig, kind);
				return false;
			}
			this.showTriggerBanner(trig, kind);
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

	/** Leaders: all remaining members must be within the gather radius of the
	 * local trigger (and roughly the same height) before the local event is
	 * allowed. NPC dialogues use the tight NPC ring; automatic triggers use the
	 * wide zone radius. */
	private absentMembersFor(trig: any, kind: 'trigger' | 'location' | 'npc' = 'trigger'): string[] {
		const absent: string[] = [];
		const self = this.localName();
		const tc = trig.coll && trig.coll.pos;
		if (!tc) return this.members.filter((m) => m !== self);
		const radius = kind === 'npc' ? NPC_GATHER_RADIUS : GATHER_RADIUS;
		for (const name of this.members) {
			if (name === self) continue;
			const pl: any = this.main.players && this.main.players[name];
			const e: any = pl && pl.entity;
			if (!e || e._killed || !e.coll || !e.coll.pos) { absent.push(name); continue; }
			const dx = e.coll.pos.x - tc.x;
			const dy = e.coll.pos.y - tc.y;
			const dz = Math.abs((e.coll.pos.z || 0) - tc.z);
			if (dx * dx + dy * dy > radius * radius || dz > GATHER_Z_DELTA) absent.push(name);
		}
		return absent;
	}

	/** Trigger-zone banner: replaces BOTH the old leader modal and the old
	 * member toast. Shown while OUR player satisfies the trigger conditions;
	 * auto-hides when we leave, the event starts, the map changes, or the mode
	 * exits. The diamond row shows every REAL member (this.members — bots are
	 * never part of the server roster): green = inside the zone, grey = outside. */
	private showTriggerBanner(trig: any, kind: 'trigger' | 'location' | 'npc'): void {
		const key = kind + ':' + this.triggerKey(trig);
		if (this.triggerBannerKey === key && this.triggerBannerTrig === trig) return;
		this.triggerBannerKey = key;
		this.triggerBannerTrig = trig;
		this.triggerBannerKind = kind;
		this.triggerBannerSignature = '';
		this.triggerBannerSeenAt = Date.now();
		// 1.70.69: keep ONE console line per trigger for the whole session (nearby
		// triggers satisfy their conditions on alternating frames — logging even
		// every 10s produced the repeated onEnter/arrive spam). __mpstorytrig()
		// remains available for live diagnosis.
		if (!this.triggerZoneLog[key]) {
			this.triggerZoneLog[key] = Date.now();
			console.log('[storysync] entered trigger zone kind=' + kind + ' key=' + this.triggerKey(trig)
				+ ' name=' + (trig.name || '(none)') + ' eventType=' + trig.eventType);
		}
	}

	private clearTriggerBannerIf(trig: any, kind: 'trigger' | 'location'): void {
		if (!this.triggerBannerTrig) return;
		const key = kind + ':' + this.triggerKey(trig);
		if (this.triggerBannerKey !== key || this.triggerBannerTrig !== trig) return;
		console.log('[storysync] left trigger zone kind=' + kind + ' key=' + this.triggerKey(trig));
		this.hideTriggerBanner();
	}

	private hideTriggerBanner(): void {
		try { if (this.triggerBanner) { this.triggerBanner.remove(); this.triggerBanner = null; } } catch (_) { /* ignore */ }
		this.triggerBannerKey = '';
		this.triggerBannerSignature = '';
		this.triggerBannerTrig = null;
		this.triggerBannerKind = 'trigger';
		this.triggerBannerSeenAt = 0;
		this.triggerBannerSent = false;
		this.triggerZoneLog = Object.create(null);
	}

	private updateTriggerBanner(): void {
		try {
			if (!this.active || !this.triggerBannerTrig) {
				if (this.triggerBanner) this.hideTriggerBanner();
				return;
			}
			const trig = this.triggerBannerTrig;
			// NPC banners have no per-frame trigger update: keep them alive only
			// while the LOCAL player stays near the NPC (leave -> banner disappears).
			if (this.triggerBannerKind === 'npc') {
				const p = (ig.game as any).playerEntity;
				const tc = trig && trig.coll && trig.coll.pos;
				const pc = p && p.coll && p.coll.pos;
				const near = !!(p && !p._killed && tc && pc
					&& Math.pow(pc.x - tc.x, 2) + Math.pow(pc.y - tc.y, 2) <= NPC_GATHER_RADIUS * NPC_GATHER_RADIUS
					&& Math.abs((pc.z || 0) - (tc.z || 0)) <= GATHER_Z_DELTA);
				if (!near) { this.hideTriggerBanner(); return; }
				this.triggerBannerSeenAt = Date.now();
			}
			// The trigger's update() stops being called (entity off screen / map
			// change / trigger disabled): treat >1.5s of silence as "left zone".
			if (Date.now() - this.triggerBannerSeenAt > 1500) {
				this.hideTriggerBanner();
				return;
			}
			const kind = this.triggerBannerKind;
			const absent = this.absentMembersFor(trig, kind);
			// Leader authority: as soon as everyone is inside, fire the engine event.
			if (this.isLocalLeader()) {
				if (!absent.length) {
					this.waitingTrigger = trig;
					if (!this.triggerBannerSent) {
						this.triggerBannerSent = true;
						this.hideTriggerBanner();
						if (kind === 'npc') this.startAuthoritativeNpcEvent(trig);
						else this.startAuthoritativeEvent(trig, kind);
					}
					return;
				}
			}
			const self = this.localName();
			const text = this.isLocalLeader() ? t('storySyncTriggerBannerLeader') : t('storySyncTriggerBannerMember');
			const rows: string[] = [];
			const ordered = Array.isArray(this.members) ? this.members.slice() : [];
			for (const name of ordered) {
				const on = name === self || absent.indexOf(name) === -1;
				rows.push('<span class="mpDiamond ' + (on ? 'on' : 'off') + '" title="' + name + '"></span>');
			}
			const absentNames = absent.map((n) => '· ' + n).join('<br>');
			let html = '<span class="mpTriggerTag">' + t('storySyncTriggerBannerTag') + '</span>'
				+ '<span class="mpTriggerState">' + text + '</span>'
				+ '<span class="mpTriggerRows">' + rows.join('') + '</span>';
			if (absent.length) {
				html += '<button class="mpTriggerNudge" title="' + t('storySyncGatherNudge') + '">'
					+ t('storySyncGatherNudge') + '</button>';
			}
			if (this.triggerBannerSignature === html) return;
			this.triggerBannerSignature = html;
			if (!this.triggerBanner || !document.body.contains(this.triggerBanner[0])) {
				this.triggerBanner = $('<div class="mpTriggerBanner"></div>');
				$(document.body).append(this.triggerBanner);
			}
			this.triggerBanner.html(html);
			const selfRef = this;
			this.triggerBanner.off('click', '.mpTriggerNudge');
			this.triggerBanner.on('click', '.mpTriggerNudge', () => {
				try {
					if (!absent.length) return;
					selfRef.conn.storySyncNudge(selfRef.quest, absent.slice());
					console.log('[storysync] nudge sent to ' + JSON.stringify(absent));
				} catch (_) { /* ignore */ }
			});
			if (absentNames) this.triggerBanner.attr('data-absent', absentNames);
		} catch (_) { /* ignore */ }
	}

	/** 1.70.70 camera focus: while a synced story video is running, the camera
	 * stays glued to the STORY LEADER (on members: their leader mirror; on the
	 * leader themselves: their own player entity). The handle is kept on TOP of
	 * ig.camera.targets every frame, so a cutscene camera step can't pull the
	 * view off the leader; the story video end removes the handle and the
	 * normal camera stack resumes. */
	private updateLeaderCamera(): void {
		try {
			const cam: any = (ig as any).camera;
			if (!cam || typeof cam.pushTarget !== 'function') { this.clearLeaderCamera(); return; }
			if (!this.storyEventActive()) { this.clearLeaderCamera(); return; }
			let ent: any = null;
			if (this.isLocalLeader()) {
				ent = (ig.game as any).playerEntity;
			} else {
				const pl = this.main.players && this.main.players[this.leader];
				ent = pl && pl.entity;
			}
			if (!ent || ent._killed || !ent.coll) { this.clearLeaderCamera(); return; }
			if (this.leaderCameraEntity !== ent || !this.leaderCameraHandle) {
				this.clearLeaderCamera();
				const ET: any = (ig as any).Camera && (ig as any).Camera.EntityTarget;
				const TH: any = (ig as any).Camera && (ig as any).Camera.TargetHandle;
				if (!ET || !TH) return;
				// Use the pre-event baseline captured by prepareLeaderCameraBase();
				// only fall back to now if we were too late (defensive).
				if (this.leaderCameraBaseCount <= 0) this.prepareLeaderCameraBase();
				this.leaderCameraHandle = new TH(new ET(ent), 0, 0);
				this.leaderCameraEntity = ent;
				cam.pushTarget(this.leaderCameraHandle, 'FAST');
			}
			const h = this.leaderCameraHandle;
			if (h && !cam.isActiveTarget(h)) {
				// An engine camera step pushed another target on top this frame.
				// Re-assert leader focus immediately.
				try { cam.removeTarget(h, 0); } catch (_) { /* ignore */ }
				cam.pushTarget(h, 'FAST');
			}
		} catch (_) { /* never break the frame */ }
	}

	private clearLeaderCamera(): void {
		try {
			const h = this.leaderCameraHandle;
			this.leaderCameraHandle = null;
			this.leaderCameraEntity = null;
			const cam: any = (ig as any).camera;
			if (h && cam && typeof cam.removeTarget === 'function') {
				try { cam.removeTarget(h, 'FAST'); } catch (_) { /* ignore */ }
			}
			// 1.70.74: our per-frame re-assert kept the leader handle on TOP, so
			// the engine's own camera push/pop pairs (NPC onEventStart/End,
			// RESET_CAMERA) can pop OUR handle and leave their target behind.
			// After removing our handle, pop every target the video pushed on
			// top of the pre-story stack — the final transition lands back on
			// the local player's normal camera.
			if (cam && typeof cam.popTarget === 'function' && this.leaderCameraBaseCount > 0
				&& Array.isArray(cam.targets)) {
				const base = this.leaderCameraBaseCount;
				this.leaderCameraBaseCount = 0;
				let guard = 16;
				while (cam.targets.length > base && guard-- > 0) {
					try { cam.popTarget('FAST'); } catch (_) { break; }
				}
			} else {
				this.leaderCameraBaseCount = 0;
			}
		} catch (_) { /* ignore */ }
	}

	/** 1.70.78: while a synced story video plays, MEMBERS hide their OWN local
	 * player (alpha 0) — the only visible character is the leader's. The leader
	 * client keeps its own player visible. Restores the previous alpha when the
	 * video ends (or the mode exits). */
	private updateLocalPlayerStoryHide(): void {
		try {
			const shouldHide = this.storyEventActive() && this.isLocalMember();
			const p = (ig.game as any).playerEntity;
			if (shouldHide) {
				if (p && p.animState && !p._killed) {
					if (!this.localHideApplied) {
						this.localHideApplied = true;
						this.localHideBaseAlpha = (typeof p.animState.alpha === 'number') ? p.animState.alpha : 1;
					}
					p.animState.alpha = 0;
				}
			} else if (this.localHideApplied) {
				this.localHideApplied = false;
				if (p && p.animState) {
					try { p.animState.alpha = this.localHideBaseAlpha; } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
	}

	/** Leftover from the modal gather flow — now a no-op (kept as the tick
	 * call site already routes through updateTriggerBanner). */
	private updateWaitingPrompt(): void { }

	// ------------------------------------------------- authoritative event start

	private startAuthoritativeEvent(trig: any, kind: 'trigger' | 'location'): void {
		try {
			this.hideTriggerBanner();
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
			this.prepareLeaderCameraBase(); // 1.70.79: before the event pushes camera steps
			console.log('[storysync] starting authoritative event kind=' + kind + ' key=' + key
				+ ' name=' + (trig.name || '(none)') + ' type=' + type + ' map=' + map);
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
			this.resetSkipVote();
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
				// 1.70.78: run the ENGINE's end first (native enterGame / camera
				// pops), THEN our cleanup — resetting actions before the engine's
				// end would get overwritten by the native onEventEnd bookkeeping.
				let r: any = undefined;
				if (prev) {
					try { r = prev.call(this, eventCall); } catch (_) { /* ignore */ }
				}
				try { self.onSyncedEventEnded(); } catch (_) { /* ignore */ }
				return r;
			};
		} catch (_) { /* ignore */ }
	}

	private onSyncedEventEnded(): void {
		if (this.currentEventActive || this.currentEventPendingSince) {
			console.log('[storysync] synced story event ended (seq=' + this.currentEventSeq + ')');
		}
		// 1.70.78: the player may have been walking when the cutscene grabbed
		// them; a half-finished NAVIGATE/MOVE action can survive event end and
		// keep dragging the character. Cancel + null the action and zero the
		// movement inputs so the player regains control immediately.
		try {
			const p = (ig.game as any).playerEntity;
			if (p) {
				if (typeof p.cancelAction === 'function') { try { p.cancelAction(); } catch (_) { /* ignore */ } }
				if (typeof p.setAction === 'function') { try { p.setAction(null); } catch (_) { /* ignore */ } }
				if (p.coll) {
					try { p.coll.accelDir.x = 0; p.coll.accelDir.y = 0; } catch (_) { /* ignore */ }
					try { p.coll.vel.x = 0; p.coll.vel.y = 0; } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
		// Leader tells the server so an open no-timeout skip vote can be aborted
		// for off-map/afk members instead of stranding their vote banner forever.
		if (this.currentEventSeq && this.isLocalLeader()) {
			try { this.conn.storySyncEventEnd(this.currentEventSeq); } catch (_) { /* ignore */ }
		}
		this.currentEventActive = false;
		this.currentEventPendingSince = 0;
		this.resetSkipVote();
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
	}

	// ---------------------------------------------------------------- event relay

	private onEvent(data: { from: string, quest: string, map: string, key: string, kind: 'trigger' | 'location' | 'npc', type: number, seq: number }): void {
		if (!this.active || data.quest !== this.quest) return;
		const mapNow = (ig.game as any).mapName || '';
		const selfName = this.localName();
		this.currentEventSeq = data.seq || 0;
		this.resetSkipVote();
		try { closeStoryWindows(); } catch (_) { /* ignore */ }
		this.waitingTrigger = null;
		this.waitingPromptSince = 0;
		this.waitingOpen = false;
		this.hideTriggerBanner();
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
		if (data.kind === 'npc') {
			const npc = this.findNpc(data.key);
			if (!npc) {
				console.warn('[storysync] matching story NPC not found for event key=' + data.key);
				showMpToast({ title: t('storySyncEventMissingTrigger') });
				return;
			}
			this.memberReplayNpcEvent(npc, data.seq);
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
			this.resetSkipVote();
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
			if (!model || typeof model.isCutscene !== 'function') return false;
			// 1.70.80: the engine routes BOTH cutscene skipping and blocking-story
			// dialogue skipping through GameModel.skipCutscene. Requiring
			// isCutscene() made the latter fall through to the NATIVE single-player
			// skip, so the party vote never opened for dialogue-heavy scenes.
			const inSkipableVideo = !!model.isCutscene()
				|| !!(model.message && typeof model.message.isMenuMode === 'function' && model.message.isMenuMode());
			if (!inSkipableVideo) return false;
			if (model.skipBlock) return false;
			if (!this.currentEventSeq) return false;
			if (Date.now() - this.skipLastHandled < 1200) return true;
			this.skipLastHandled = Date.now();
			this.requestSkipVote();
			return true;
		} catch (_) { return false; }
	}

	/** Any member (leader or member) pressing skip either opens a new ballot or —
	 * when a ballot is already open and we haven't voted — sends our YES. */
	private requestSkipVote(): void {
		const seq = this.currentEventSeq;
		const self = this.localName();
		if (this.skipVoteSeq === seq) {
			if (this.skipVoteAnswers[self] !== undefined) return; // already voted
			this.skipVoteAnswers[self] = true;
			this.renderSkipVoteBanner();
			try { this.conn.storySyncSkipAnswer(seq, true); } catch (_) { /* ignore */ }
			console.log('[storysync] joined open skip vote seq=' + seq + ' with YES');
			return;
		}
		// Optimistic local ballot (we are instantly green); the server echo
		// re-syncs the authoritative answers map for everyone.
		this.skipVoteSeq = seq;
		this.skipVoteFrom = self;
		this.skipVoteAnswers = Object.create(null);
		this.skipVoteAnswers[self] = true;
		this.renderSkipVoteBanner();
		try { this.conn.storySyncSkipVote(seq); } catch (_) { /* ignore */ }
		console.log('[storysync] skip vote requested seq=' + seq);
	}

	private mergeSkipVoteAnswers(answers: any): void {
		if (!answers || typeof answers !== 'object') return;
		for (const k in answers) {
			if (answers[k] === true) this.skipVoteAnswers[k] = true;
		}
	}

	private onSkipVoteRequested(data: { seq: number, from: string, answers?: { [name: string]: boolean } }): void {
		if (!this.active || !data || data.seq !== this.currentEventSeq) return;
		this.skipVoteSeq = data.seq;
		this.skipVoteFrom = data.from || this.localName();
		this.skipVoteAnswers = Object.create(null);
		this.mergeSkipVoteAnswers(data.answers);
		this.renderSkipVoteBanner();
		console.log('[storysync] skip vote opened seq=' + data.seq + ' by=' + this.skipVoteFrom);
	}

	private onSkipVoteUpdate(data: { seq: number, answers?: { [name: string]: boolean } }): void {
		if (!this.active || !data || data.seq !== this.currentEventSeq) return;
		if (this.skipVoteSeq !== data.seq) {
			this.skipVoteSeq = data.seq;
			this.skipVoteFrom = this.localName();
		}
		this.mergeSkipVoteAnswers(data.answers);
		this.renderSkipVoteBanner();
	}

	/** 1.70.80 top-of-screen vote banner (replaces the full-screen vote modal):
	 * green diamonds = accepted, grey = not yet answered. The local player keeps
	 * 接受 / 拒绝 buttons until they answer; any NO cancels the whole ballot. */
	private renderSkipVoteBanner(): void {
		try {
			if (typeof document === 'undefined' || !document.body) return;
			if (!this.active || !this.skipVoteSeq || this.skipVoteSeq !== this.currentEventSeq) {
				this.hideSkipVoteBanner();
				return;
			}
			const self = this.localName();
			const ordered: string[] = Array.isArray(this.members) ? this.members.slice() : [];
			// Roster drift protection: every answered name must have a diamond even
			// if our local members copy is a moment behind a mid-way join.
			for (const k in this.skipVoteAnswers) {
				if (ordered.indexOf(k) === -1) ordered.push(k);
			}
			if (ordered.indexOf(this.skipVoteFrom) === -1 && this.skipVoteFrom) ordered.unshift(this.skipVoteFrom);
			if (ordered.indexOf(self) === -1) ordered.push(self);
			const rows: string[] = [];
			for (const name of ordered) {
				const on = this.skipVoteAnswers[name] === true;
				rows.push('<span class="mpDiamond ' + (on ? 'on' : 'off') + '" title="' + name + '"></span>');
			}
			const requester = this.skipVoteFrom || self;
			const text = requester === self ? t('storySyncSkipVoteBannerSelf') : t('storySyncSkipVoteBanner').replace('{name}', requester);
			let html = '<span class="mpTriggerTag">' + t('storySyncSkipVoteTag') + '</span>'
				+ '<span class="mpTriggerState">' + text + '</span>'
				+ '<span class="mpTriggerRows">' + rows.join('') + '</span>';
			const answered = this.skipVoteAnswers[self] !== undefined;
			if (!answered) {
				html += '<button class="mpSkipVoteYes">' + t('storySyncSkipYes') + '</button>'
					+ '<button class="mpSkipVoteNo">' + t('storySyncSkipNo') + '</button>';
			}
			if (this.skipVoteSignature === html && this.skipVoteBanner && document.body.contains(this.skipVoteBanner[0])) return;
			this.skipVoteSignature = html;
			if (!this.skipVoteBanner || !document.body.contains(this.skipVoteBanner[0])) {
				this.hideSkipVoteBanner();
				this.skipVoteBanner = $('<div class="mpTriggerBanner mpSkipVoteBanner"></div>');
				$(document.body).append(this.skipVoteBanner);
			}
			this.skipVoteBanner.html(html);
			const selfRef = this;
			const seq = this.skipVoteSeq;
			this.skipVoteBanner.off('click', '.mpSkipVoteYes');
			this.skipVoteBanner.off('click', '.mpSkipVoteNo');
			this.skipVoteBanner.on('click', '.mpSkipVoteYes', () => {
				try {
					if (selfRef.skipVoteSeq !== seq) return;
					if (selfRef.skipVoteAnswers[selfRef.localName()] !== undefined) return;
					selfRef.skipVoteAnswers[selfRef.localName()] = true;
					selfRef.renderSkipVoteBanner();
					try { selfRef.conn.storySyncSkipAnswer(seq, true); } catch (_) { /* ignore */ }
				} catch (_) { /* ignore */ }
			});
			this.skipVoteBanner.on('click', '.mpSkipVoteNo', () => {
				try {
					if (selfRef.skipVoteSeq !== seq) return;
					if (selfRef.skipVoteAnswers[selfRef.localName()] !== undefined) return;
					// Mark us as answered immediately (buttons disappear); the server
					// result packet closes the banner for the whole party.
					selfRef.skipVoteAnswers[selfRef.localName()] = false;
					selfRef.renderSkipVoteBanner();
					try { selfRef.conn.storySyncSkipAnswer(seq, false); } catch (_) { /* ignore */ }
				} catch (_) { /* ignore */ }
			});
		} catch (_) { /* ignore */ }
	}

	private hideSkipVoteBanner(): void {
		try {
			if (this.skipVoteBanner) { this.skipVoteBanner.remove(); this.skipVoteBanner = null; }
		} catch (_) { /* ignore */ }
		this.skipVoteSignature = '';
	}

	private resetSkipVote(): void {
		this.skipVoteSeq = 0;
		this.skipVoteFrom = '';
		this.skipVoteAnswers = Object.create(null);
		this.hideSkipVoteBanner();
	}

	private onSkipVoteResult(data: { seq: number, pass: boolean, reason?: string, from?: string }): void {
		if (this.skipVoteSeq === data.seq) this.resetSkipVote();
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
				this.mainPlotSnapshot = null;
				this.currentEventSeq = 0;
				this.currentEventActive = false;
				this.currentEventPendingSince = 0;
				this.resetSkipVote();
				this.waitingTrigger = null;
				this.waitingPromptSince = 0;
				this.waitingOpen = false;
				this.hideTriggerBanner();
				this.clearLeaderCamera();
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
			this.attachQuestBarButton(menu);
		} catch (_) { /* ignore */ }
	}

	public questMenuClosed(menu: any): void {
		try {
			// 1.70.62: our button lives in the ENGINE's top hotkey bar (the row
			// that shows 设为常用 / 排序 / 帮助). Unregister it from both the
			// global-button list and the hotkey-callback list — BUT keep the
			// ButtonGui itself: the hotkey bar detaches the hook on hide and re-
			// attaches the same hook on the next open (creating a new one each
			// time would stack duplicates).
			if (this.questMenuButton && (sc as any).menu && (sc as any).menu.buttonInteract) {
				try { (sc as any).menu.buttonInteract.removeGlobalButton(this.questMenuButton); } catch (_) { /* ignore */ }
			}
			if (this.questMenuHotkeyFn && (sc as any).menu && Array.isArray((sc as any).menu.hotkeysCallbacks)) {
				const arr = (sc as any).menu.hotkeysCallbacks;
				for (let i = arr.length; i--;) {
					if (arr[i] === this.questMenuHotkeyFn) { arr.splice(i, 1); break; }
				}
			}
			this.questMenuHotkeyFn = null;
			this.questMenu = null;
		} catch (_) { /* ignore */ }
	}

	private attachQuestBarButton(menu: any): void {
		try {
			if (!this.questMenuButton) {
				const BT: any = (sc as any).BUTTON_TYPE;
				const btn = new (sc as any).ButtonGui(t('storySyncEntryShort'), 0, true, BT ? BT.SMALL : undefined);
				btn.keepMouseFocus = true;
				const self = this;
				btn.onButtonPress = function () { self.onQuestUiButton(); };
				// Do NOT set a position: sc.MainMenu.TopBar._positionHotKeys aligns
				// every hotkey button X_RIGHT / Y_TOP itself, in callback order.
				// Our callback is unshifted BEFORE the engine's, so it renders
				// immediately to the LEFT of 设为常用 (hotkeyTask).
				this.questMenuButton = btn;
			}
			const menuModel: any = (sc as any).menu;
			if (!menuModel || !Array.isArray(menuModel.hotkeysCallbacks)) return;
			// Idempotent per-open registration.
			if (!this.questMenuHotkeyFn) {
				const self = this;
				this.questMenuHotkeyFn = function () { return self.questMenuButton; };
			}
			if (menuModel.hotkeysCallbacks.indexOf(this.questMenuHotkeyFn) === -1) {
				menuModel.hotkeysCallbacks.unshift(this.questMenuHotkeyFn);
			}
			if (menuModel.buttonInteract
				&& (!this.questMenuButton.buttonInteract || this.questMenuButton.buttonInteract !== menuModel.buttonInteract)) {
				menuModel.buttonInteract.addGlobalButton(this.questMenuButton, null); // visible via hotkey bar; mouse-only, no key stolen
			}
			menuModel.commitHotkeys(true);
			this.refreshQuestButton();
		} catch (_) { /* ignore */ }
	}

	private refreshQuestButton(): void {
		try {
			if (!this.questMenuButton || typeof this.questMenuButton.setText !== 'function') return;
			// 1.70.64: list page -> 剧情同步 (main story); quest DETAIL page ->
			// 支线任务同步 (the static quest currently open).
			const inDetail = !!(this.questMenu && (sc as any).menu && (sc as any).menu.questDetailMode);
			const active = this.active || this.isPendingStart;
			const sig = (inDetail ? 'D' : 'L') + '|' + (this.active ? (this.isLocalLeader() ? 'L' : 'M') : 'N') + '|' + (this.isPendingStart ? 'P' : '-');
			if (this.questButtonSignature === sig) return; // engine repoints the hook position without us
			this.questButtonSignature = sig;
			let label = inDetail ? t('storySyncQuestEntryShort') : t('storySyncEntryShort');
			if (this.active) label = this.isLocalLeader() ? t('storySyncCancelShort') : t('storySyncActiveShort');
			else if (this.isPendingStart) label = t('storySyncCheckingShort');
			this.questMenuButton.setText(label, false);
			this.questMenuButton.setActive(active || this.canStartNow());
			// Width changed with the label: tell the native hotkey bar to re-lay
			// out the top row (otherwise the buttons can overlap by a few pixels).
			try { if ((sc as any).menu && typeof (sc as any).menu.updateHotkeys === 'function') (sc as any).menu.updateHotkeys(); } catch (_) { /* ignore */ }
		} catch (_) { /* ignore */ }
	}

	private canStartNow(): boolean {
		return !!(this.main && Array.isArray(this.main.partyMembers) && this.main.partyMembers.length > 1 && (this.main as any).isPartyLeader);
	}

	private candidateQuestId(): string {
		const q = this.questManager();
		if (!q) return '';
		// On the DETAIL page the open quest IS the target — this also works when
		// the list selection was refreshed/cleared by the menu transition.
		try {
			if (this.questMenu && (sc as any).menu && (sc as any).menu.questDetailMode
				&& this.questMenu.questDetailBox && this.questMenu.questDetailBox.currentQuest
				&& this.questMenu.questDetailBox.currentQuest.id) {
				return this.questMenu.questDetailBox.currentQuest.id;
			}
		} catch (_) { /* ignore */ }
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
		const inDetail = !!(this.questMenu && (sc as any).menu && (sc as any).menu.questDetailMode);
		let err = '';
		if (!this.active && !this.isPendingStart) {
			err = inDetail ? this.leaderRequestSync() : this.leaderRequestMainPlotSync();
		}
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

	/** 1.70.62: close the regular menu / quick menu so a just-started story sync
	 * drops every player straight back into the game world for the intro banner.
	 * Mirrors the engine's own menu-key code path (model.enterRunning), which
	 * drives MainMenu._exitMenu + sc.menu.exitMenu and clears the menu stack. */
	private closeGameMenus(): void {
		try {
			const model: any = (sc as any).model;
			if (!model) return;
			if (typeof model.isMenu !== 'function' && typeof model.isQuickMenu !== 'function') return;
			if (model.isMenu && model.isMenu()) {
				model.enterRunning();
			} else if (model.isQuickMenu && model.isQuickMenu()) {
				model.enterRunning();
			}
		} catch (_) { /* never hard-fail the sync start */ }
	}

	/** 1.70.62: FF14-duty-commence-style big glowing text for every party member
	 * (leader included). Pure overlay — no pointer interception, auto-fades after
	 * the CSS animation (3.4s). */
	private playCommencementBanner(): void {
		try {
			if (typeof document === 'undefined' || !document.body) return;
			try { $('.mpStoryComm').remove(); } catch (_) { /* ignore */ }
			const box = $('<div class="mpStoryComm"></div>');
			box.append('<div class="mpStoryCommGlow"></div>');
			box.append('<div class="mpStoryCommDuty">' + t('storySyncCommDuty') + '</div>');
			box.append('<div class="mpStoryCommTitle">' + t('storySyncCommTitle') + '</div>');
			box.append('<div class="mpStoryCommLine"></div>');
			box.append('<div class="mpStoryCommSub">' + t('storySyncCommSub').replace('{quest}', this.questLabel(this.quest)) + '</div>');
			$(document.body).append(box);
			(window as any).setTimeout(() => {
				try { box.remove(); } catch (_) { /* ignore */ }
			}, 3500);
		} catch (_) { /* ignore */ }
	}

	/** Bottom-right PIXEL four-point star shown for the ENTIRE sync; hovering it
	 * says the mode is active (tooltip via CSS). Managed per-frame. */
	private updateGameStar(): void {
		try {
			if (typeof document === 'undefined' || !document.body) return;
			if (!this.active) {
				if (this.hudStar) { this.hudStar.remove(); this.hudStar = null; }
				return;
			}
			if (!this.hudStar || !document.body.contains(this.hudStar[0])) {
				const svg = '<svg viewBox="0 0 11 11" shape-rendering="crispEdges">'
					+ '<path fill="#fff3b0" d="M5 0h1v2h1v1h-1v1h1v1h-1v1h1v1h-1v1h1v1h-1v2h-1v-2h-1v-1h1v-1h-1v-1h1v-1h-1v-1h1v-1h-1v-1h1v-1h-1z"/>'
					+ '<path fill="#ffd13e" d="M4 2h3v1h1v3h-1v1h-3v-1h-1v-3h1z"/>'
					+ '<path fill="#fff7cf" d="M5 3h1v3h-1z"/></svg>';
				this.hudStar = $('<div class="mpStoryStar" data-tip="' + t('storySyncStarTip') + '">' + svg + '</div>');
				$(document.body).append(this.hudStar);
			}
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