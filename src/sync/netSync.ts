import { Multiplayer } from '../multiplayer';
import { ILootDrop } from '../connection';
import { t } from '../i18n';
import { isSharedTownNow, isSharedTownMap, currentAreaPath } from '../util/areaUtil';
import { showItemUse } from '../ui/itemUseIndicator';
import { showRemoteHeal } from '../ui/healSync';

/**
 * New sync system — whole-state broadcast, replacing the original mod's per-entity
 * delta events (updateEntityPosition/State/Target/Animation + registerEntity buckets).
 * Those listeners are disabled in multiplayer.ts (USE_NET_SYNC) when this is active.
 *
 * Design (self-healing, no packet-loss states):
 *  - PLAYERS: every client streams its OWN full state (pos/face/anim/hp/sp) each
 *    frame. The receiver applies it to that player's mirror + party model. Missed a
 *    frame? The next one corrects it. The mirror keeps its collision, so the local
 *    player can hit it -> shared combat.
 *  - ENEMIES: only the instance host streams a compact block of EVERY live enemy's
 *    state (~15x/sec). Each snap carries the enemy's identity so members refer to the
 *    SAME creature the host does:
 *        i  = uid  — the host-stamped unique entity id (ig.Entity._lastId). Unlike
 *             mapId this is set for EVERY enemy, including EnemySpawner-spawned ones
 *             (which get mapId=0). Members look the uid up in a live registry built
 *             from the block.
 *        mi = mapId — for static map enemies this matches the member's own map enemy
 *             (same map data), so the member adopts ITS already-typed, already-placed
 *             enemy as the puppet (no re-spawn, correct appearance).
 *        t  = enemyInfo.type — lets a member spawn a correctly-typed fallback puppet
 *             when it has no matching map enemy (e.g. a host EnemySpawner creature the
 *             member stripped).
 *    Members do NOT run the Enemy AI on puppets (round 17): the AI's stateTimers /
 *    attack cycle were never synced, so member-side monster behaviour (attack timing,
 *    telegraphs) drifted from the host. Puppets advance only via the captured
 *    Combatant.update (anim / HP-bar / stun) while their position stays locked +
 *    interpolated from the block. Attack TIMING is host-driven: the host detects an
 *    attack anim edge and relays enemyAttack, which the member replays on its puppet
 *    toward the local player (setTarget + playAnim; the authoritative damage/feedback
 *    still arrive via the host's combatHit). An enemy the host no longer reports died
 *    there -> the member kills its puppet (and any local ghost the host never owned).
 *  - SERVER: just relays playerState (any) and entityState (host-only). Stateless.
 */

interface IEnemySnap {
	i: number;        // uid (host-stamped; unique per enemy instance)
	mi: number;       // mapId (0 for EnemySpawner-spawned enemies)
	t: string;        // enemyInfo.type (for typed fallback spawns)
	x: number; y: number; z: number;
	fx: number; fy: number;
	a: string;        // current anim name
	h: number;        // currentHp
	m: number;        // maxHp
	tg: number;       // 1 when the host enemy currently has a target (engaged)
	tn: string;       // ROUND 47: the host enemy's current target NAME — '' = idle,
	                  // '__host__' = the local player, else a member's name. Lets a
	                  // member tell "engaged on ME" (mirror red) from "engaged on
	                  // someone else" (still hostile to the group). The plain tg flag
	                  // couldn't, so a de-aggro off the member read as still-red.
	sp?: number;      // ROUND 61: currentSp — the guard/break bar. Synced so the
	                  // member's puppet shows the host's break progress.
	msp?: number;     // ROUND 61: maxSp (baseParams.sp), the guard bar ceiling.
	brk?: number;     // ROUND 61: break/vulnerable flag — 1 while the host enemy is
	                  // guard-broken (its status Gui shows the red "broken" flash the
	                  // member could never see). 0/absent = not broken.
	hd?: number;      // ROUND 62: _hidden — 1 while the host enemy is genuinely HIDDEN
	                  // (phased out via HIDE). The member's puppet mirrors this and becomes
	                  // untargetable (its coll is untracked via _mpRehide, and
	                  // onPreDamageModification refunds the hit). The hillkat/meerkat does
	                  // NOT use HIDE — its burrow is SET_COLL_TYPE PASSIVE (see `psv`).
	psv?: number;     // ROUND 63: SET_COLL_TYPE PASSIVE — 1 while the host enemy is
	                  // untargetable-but-VISIBLE (the meerkat's earthIn/earthDig burrow).
	                  // Balls skip PASSIVE colls natively (COLLISION_MAP[PROJECTILE] has no
	                  // PASSIVE entry), so mirroring coll.type=PASSIVE on the puppet
	                  // reproduces the host's "can't hit it underground" without hiding it.
	vul?: number;     // ROUND 63: VULNERABLE annotation — 1 while the host enemy's
	                  // annotate.passive === VULNERABLE (the meerkat's 2s "charge light"
	                  // red-flash window where a charged ball breaks it). The member's
	                  // puppet mirrors this as the red BLINK_COLOR flash it never showed.
	sh?: IShieldSnap[]; // ROUND 66: the host enemy's ACTIVE shields (ADD_SHIELD state
	                  // guards like the hedgehog's roll-up "full" shield). The member's
	                  // puppet runs no AI, so these state-driven shields never attach
	                  // locally — without them a poised/guarding enemy takes FULL damage
	                  // from the member instead of the shield-reduced (silver-number)
	                  // chip. Synced verbatim so the puppet's native isShielded applies
	                  // the same factor / hitResist / direction gates as the host.
}

/** ROUND 66: one active shield connection, serialized from the host enemy's
 * shieldsConnections. k = COMBAT_SHIELDS registry key ('DIRECTIONAL'/'PARTS'/'BASE'),
 * n = shield name, bf = baseFactor, ef = elementFactors, hr/so/st = hitResist /
 * stableOverride / strength (numeric enum values), nt = neutralize, rg/bk =
 * DIRECTIONAL range/back, pt/iv = PARTS parts/inverse. */
interface IShieldSnap {
	k: string; n: string; bf: number; ef: number[]; hr: number; so: number; st: number;
	nt: number; rg?: number; bk?: number; pt?: string[] | null; iv?: number;
}

export class NetSync {
	/** uid -> puppet enemy (member side). Null-prototype: keyed by the numeric uid. */
	private puppets: { [uid: number]: any } = Object.create(null);
	private mapName = '';
	private sendTimer = 0;
	/** Round 21: host enemy-block send interval in seconds (default 1/30 = 30Hz,
	 * was hardcoded 0.066 = ~15Hz). Set via setBlockInterval by the option latch at
	 * host-acquire (multiplayer.getHostTickInterval); the 15Hz cutscene-entity and
	 * botState streams are NOT affected. */
	public blockInterval = 1 / 30;
	private _lastNoMirrorLog = 0;
	/** Per-puppet last-played anim so we only re-issue the SHOW_ANIMATION action on
	 * CHANGE (the action persists; replaying it every snapshot is needless GC churn
	 * and would restart loops). Keyed by uid. */
	private lastAnim: { [uid: number]: string } = Object.create(null);
	/** Enemy types currently being loaded for a fallback spawn. sc.EnemyType.load() is
	 * async; without this guard the first few blocks (before the type is resident) each
	 * spawn a duplicate fallback puppet. While a type is pending we skip its spawns. */
	private pendingTypes: { [type: string]: boolean } = Object.create(null);
	/** uid -> timestamp of a member-side kill. While fresh, the host block must NOT
	 * respawn that puppet (the real enemy is dying/dead on the host too). Prevents the
	 * "killed it but it pops back" flicker between the member's kill and the host's block
	 * catching up. */
	private memberKills: { [uid: number]: number } = Object.create(null);
	/** Round 14 (fix 5): member-side deaths pending the delayed death-FX sequence.
	 * Member kills use kill(true) (silent, no FX), so we stage the puppet for
	 * ~500ms total (round 16: 220ms flinch/blink + 280ms boom window ≈ vanilla
	 * DYING): flinch anim + pre_die blink immediately, then boom + silent kill. */
	private _mpDeathQueue: Array<{ e: any, at: number, doLootMirror: boolean }> = [];
	/** Round 14 (fix 1): accumulated ig.system.tick for the host-side combat
	 * re-evaluation (~every 0.5s) that un-sticks combatMode when the last enemy
	 * de-aggros a mirror. */
	private _mpCombatEvalTimer = 0;
	// ---- local death / respawn state (own player; both host and member) ----
	private _mpDead = false;
	private _mpDeadAt = 0;
	private _mpSpecHandle: any = null;
	private _mpSpecEntity: any = null;
	private _mpPlayerCamDetached = false;
	private _mpDeathGui: any = null;
	private _mpDeathGuiText = '';
	private _mpDeathPos: { x: number, y: number, z: number } | null = null;
	private _mpDeathMap = '';
	private _mpSafeRespawnPos: { x: number, y: number, z: number } | null = null;
	private _mpDeathCollType: any = null;
	/** Round 11: corpse stays visible with death FX for ~1s, then gets hidden. */
	private _mpCorpseHidden = false;
	/** Round 11: original MOUSE1/MOUSE2 bindings (aim/dash) captured while spectating. */
	private _mpOrigMouseBinds: { m1?: string, m2?: string } | null = null;
	/** Set to Date.now() the first frame we notice the WHOLE party is down (we are
	 * dead and no live teammate mirror exists). Held for ~2s before triggering the
	 * vanilla checkpoint reload — a teammate respawning in that window clears it and
	 * cancels the reload. 0 = not all-dead. */
	private _mpAllDeadAt = 0;
	/** True from the moment we fire the vanilla defeat flow until the checkpoint
	 * teleport actually begins (the cinematic takes ~3.5s). Blocks re-triggering. */
	private _mpCheckpointReloading = false;
	/** Timestamp when the checkpoint reload was fired (stall safety net). */
	private _mpCheckpointReloadAt = 0;
	/** The stall safety net already forced a raw loadCheckpoint once. */
	private _mpCheckpointForced = false;
	/** Gate for the ig.game.respawn shadow: true ONLY while respawnAtCheckpoint is
	 * making its own deliberate vanilla-flow call. Every other respawn call while
	 * connected is a native defeat leak and gets swallowed (round 8). */
	private _mpAllowRespawn = false;
	// ---- party charge time-stop sync (round 10) ----
	/** True while WE hold the shared 'mpCharge' slow-motion handle (any party
	 * member is charging a skill). Cleared when the last charger releases. */
	private _mpChargeFrozen = false;
	// ---- hit-while-in-menu monitor (round 11) ----
	/** Last-seen local currentHp; a DROP while the inventory menu is open means we
	 * got hit and must auto-close the bag (menus no longer pause while partied). */
	private _mpLastLocalHp = -1;
	// ---- round 16 (issue 4): party-size monster HP scaling (host side) ----
	/** Per-extra-party-member max-HP fraction from the server handshake
	 * (default 0.5 = +50% HP per additional party member). Set via setHpScale();
	 * the HOST multiplies enemy max/current HP at spawn by
	 * 1 + _mpHpScale * (partySize - 1). Clamped [0, 10]. */
	private _mpHpScale = 0.5;
	// ---- round 19: cutscene compatibility ----
	/** True while the LOCAL player is inside a story cutscene (sc.model.isCutscene()).
	 * Maintained by the enterCutscene/enterGame wraps installed in install(). Drives
	 * mirror fading (Part 2) and the member-side aggro guard (Part 4). */
	public inCutscene = false;
	/** Fired by the enterGame wrap when a cutscene ends (multiplayer.ts wires it to
	 * fire any regroup/teleport request stashed mid-cutscene). */
	public onCutsceneEnd?: () => void;
	/** ROUND 107: fired by the enterCutscene wrap (multiplayer wires bot
	 * independence to it — see beginBotCutsceneIndependence). */
	public onCutsceneStart?: () => void;
	/** Round 19 (Part 3): member-side cutscene-spawned monsters ('cs'+uid -> puppet).
	 * Deliberately SEPARATE from the host-block `puppets` map — the two spaces never
	 * interact (different spawn path, different reap rules, IGNORE collision). */
	private csPuppets: { [key: string]: any } = Object.create(null);
	/** Round 19: ~15Hz accumulator for the member cutscene-entity stream. */
	private _mpCsSendTimer = 0;
	/** Round 62: member-side VISUAL-ONLY enemy projectiles (uid -> Ball/Stone copy).
	 * Deliberately SEPARATE from `puppets` — these are PROJECTILES (Ball/Stone), not
	 * enemies; they render + rotate but never hit or damage (host-authoritative damage
	 * flows through combatHit). */
	private projectiles: { [uid: number]: any } = Object.create(null);
	/** Round 62: accumulator for the HOST enemy-projectile stream. Re-armed to
	 * `blockInterval` (the option-driven 怪物同步频率, default 1/30) so the projectile
	 * stream matches the hostile enemy-block rate instead of a hardcoded 15Hz. */
	private _mpProjSendTimer = 0;
	/** Round 62: stale-reap accumulator for visual projectile copies (member side). */
	private _mpProjReapTimer = 0;
	/** ROUND 88 (collision-map leak fix): periodic sweep accumulator. Every few
	 * seconds the impact.js spatial hash is cleaned of entries whose
	 * `_inCollisionMap` flag is false — the exact stale trail left by a locked
	 * coll that crossed a cell boundary before the tracked-bucket reindex. */
	private _mpCollSweepTimer = 0;
	/** Round 19: last-seen timestamp per cutscene-entity stream owner (username).
	 * An owner whose stream stops for >2s has its csPuppets reaped as orphans
	 * (left the map / disconnected). */
	private _mpCsOwnerSeen: { [from: string]: number } = Object.create(null);
	/** Round 19: last-applied {alpha, coll} per remote mirror ENTITY (Map keyed by
	 * the entity reference, so a freshly-respawned mirror is a fresh key and always
	 * gets its fade written on the next pass — a name-keyed cache would inherit a
	 * stale "already applied" entry and leave a mid-cutscene respawn at full alpha).
	 * Reset on map change / disconnect / cutscene end. */
	private _mpMirrorFadeCache: Map<any, { alpha: number, coll: any, hp: number, status?: boolean, ignore?: boolean }> = new Map();
	/** ROUND 85 (door stuck fix): doors whose ignoreCollision we set for a remote
	 * mirror walk. The per-frame pump restores the previous collision-ignore state
	 * after a FIXED wall-clock grace — never after openTimer, which a body standing
	 * in the doorway can pin at 1 indefinitely. */
	private _mpDoorIgnoreRestores: Array<{ door: any, prev: boolean, until: number }> = [];
	// ---- round 26: member-side local monster-hit detection (REMOVED in round 27) ----
	// The round-26 purely-local collision-gated monster-hit model (_mpPendingAtk /
	// _mpLastLocalHit / _mpLocalHitActive) is GONE: the host is now the single
	// monster-damage authority (recomputeHostMonsterHit) and the member applies the
	// verdict via applyCombatHit. Those state fields were deleted; nothing references
	// them anymore.
	// ---- round 26: counter/guard-break FX sync ----
	/** True only while WE are replaying a remote counter/guard-break dramatic effect
	 * (replayCombatFx). The sc.combat.doDramaticEffect wrap's observer skips while this
	 * is set, so a replay can never re-emit the same event (the emit-loop guard). */
	private _mpReplayingFx = false;

	// ---- ROUND 52: connect-compensation for the physical monster->member hit ----
	/** Master toggle for the anim-edge connect-compensation. The Branch B (physical
	 * connect) path stays fully operational either way; setting this false restores
	 * byte-for-byte pre-ROUND-52 behaviour.
	 * ROUND 52: RE-ENABLED, but HARD-GATED so it cannot reproduce the ROUND 50 far
	 * "phantom" hits the user rejected. The user's decisive clue (ROUND 51->52): an
	 * enemy that HOLDS the member's mirror as its target through the whole swing
	 * (`tgt=b:mirror` for spin-in AND spin-out-long) still intermittently fails to
	 * register the physical connect — because the connect is a pure geometric overlap
	 * against the NETWORK-INTERPOLATED mirror, which lags / lerps / clips the member's
	 * real position, whereas the live host player collides reliably. The physical
	 * connect alone can therefore never be made reliable against a puppet. This drain
	 * re-adds ONLY the hit a genuine swing already earned: it requires the enemy to
	 * STILL be targeting that member's mirror (the very signal the user showed is 100%
	 * correlated with a real attack) AND the mirror to be SAME-BLOCK + inside the
	 * enemy's own MELEE band at impact time. A member merely near the host is never
	 * targeted (never judged); a member who dodged out is out of the tight melee band
	 * (not judged). Only a member genuinely standing in the enemy's face — exactly who
	 * SHOULD be hit — is compensated. */
	private _mpSynthHitsEnabled = false;   // ROUND 52 ROLLBACK: reverted to pre-ROUND-49 Branch B
	/** Swing impact delay: anim edge -> verdict, ms. The hedgehog spin-in -> spin-out
	 * (the moment the roll's hitbox sweeps the target) is ~300ms, so judge at impact
	 * time (not the windup edge) — the member's guard stash is freshest then AND the
	 * impact-time melee-band re-check confirms the member is still in the enemy's
	 * face (dodged out -> not judged). */
	private readonly _mpSynthSwingDelay = 350;   // ROLLBACK value (dead while disabled)
	/** Dedup window: one verdict per (enemy, mirror) within this window. */
	private readonly _mpSynthWindowMs = 1200;
	/** ROUND 52: post-impact grace (WIDENED 80 -> 380 for symmetric dedup). A physical
	 * connect (Branch B) can land ANYWHERE in the roll — including EARLY, e.g. 50ms after
	 * the anim edge, while the drain judges at +_mpSynthSwingDelay(300ms). If that early
	 * connect stamps `_mpSynthSwing` and the drain then fires 250ms later, an 80ms grace
	 * would already have expired -> the drain would judge AGAIN -> DOUBLE DAMAGE. 380ms
	 * covers a connect anywhere in the swing vs the 300ms-deferred drain, so whichever
	 * path judges a swing first suppresses the other's echo. A connect that only lands
	 * this much later is a NEW attack, so Branch B is NOT suppressed then — it becomes
	 * the fallback that re-adds the hit the synthetic miss dropped. */
	private readonly _mpSynthGraceMs = 80;   // ROLLBACK value (dead while disabled)
	/** ROUND 52: TIGHT melee margin (px). This is the anti-phantom gate. The enemy's
	 * coll is the hitbox and it only connects while the mirror is genuinely in its
	 * face, so the compensation may only fire inside the enemy's OWN melee band
	 * (~2x coll + 28px) — never the ROUND 50 far stream-stall gap. A member who
	 * dodged out is outside this band at impact time and is NOT judged. */
	private readonly _mpSynthReachMargin = 80;   // ROLLBACK value (dead while disabled)
	/** Deferred verdicts awaiting their impact moment (drained per host frame). */
	private _mpPendingSynthHits: { dueAt: number, e: any, mir: any, targetName: string, anim: string }[] = [];

	/** ROUND 40 (diagnostics): throttled [mpsfx] console logging so the four sound/aggro
	 * issues can be pinpointed from a live session's dev-console. Off unless the user sets
	 * `window.__mpSfxDebug = 1` in the console (always quiet by default). Each call site
	 * passes a tag; identical tags are collapsed to one line per ~500ms so a hot loop
	 * (playAtEntity every frame) can't flood the console. Never throws. */
	public _sfxLog(tag: string, ...args: any[]): void {
		try {
			if (!(window as any).__mpSfxDebug) return;
			const now = Date.now();
			const map: any = (this as any)._mpSfxLast || ((this as any)._mpSfxLast = Object.create(null));
			if (map[tag] && now - map[tag] < 500) return;
			map[tag] = now;
			try { console.log('[mpsfx] ' + tag, ...args); } catch (_) { /* ignore */ }
		} catch (_) { /* never break the frame */ }
	}

	/** ROUND 79 (damage diagnostics): _sfxLog WITHOUT the 500ms per-tag collapse — the
	 * host-vs-member damage capture needs EVERY hit logged so one guarded hit on each
	 * machine lines up exactly. Same __mpSfxDebug gate; never throws. */
	public _sfxLogRaw(tag: string, ...args: any[]): void {
		try {
			if (!(window as any).__mpSfxDebug) return;
			console.log('[mpsfx] ' + tag, ...args);
		} catch (_) { /* never break the frame */ }
	}

	/** ROUND 40 (diagnostics): a one-line description of a playAtEntity (sound, entity) pair
	 * for the [mpsfx] log — the sound's path, and the entity's constructor name + uid /
	 * _mpMirror/_mpPuppet/_killed flags + whether it targets the local player. Purely a
	 * string builder; every hop is guarded. */
	public _paeDescribe(sound: any, entity: any): string {
		try {
			let path = '';
			try { path = (sound && sound.webAudioBuffer && sound.webAudioBuffer.path) || (sound && sound.multiAudio && sound.multiAudio.path) || ''; } catch (_) { path = ''; }
			if (!entity) return 'snd=' + (path || '?') + ' ent=null';
			let ctor = '?';
			try { ctor = (entity.constructor && entity.constructor.name) || '?'; } catch (_) { ctor = '?'; }
			const igAny: any = ig as any;
			const me: any = igAny.game && igAny.game.playerEntity;
			const isMe = entity === me;
			const tgt: any = entity.target;
			const tgtMe = tgt && tgt === me;
			const tgtKilled = tgt ? !!tgt._killed : undefined;
			return 'snd=' + (path || '?')
				+ ' ent=' + ctor
				+ (isMe ? '=PLAYER' : '')
				+ ' uid=' + entity.uid
				+ (entity._mpMirror ? ' MIRROR' : '')
				+ (entity._mpPuppet ? ' PUPPET' : '')
				+ (entity._killed ? ' KILLED' : '')
				+ ' tgt=' + (tgt ? ((tgt.constructor && tgt.constructor.name) || '?') + (tgtMe ? '=PLAYER' : '') + (tgtKilled ? ':killed' : '') + (tgt._mpMirror ? ':mirror' : '') : 'null');
		} catch (_) { return 'describe-failed'; }
	}

	// ---- ROUND 73 diagnostics (autumn path-3 ghost enemies) ----
	/** Once-per-key log latch for the ghost-enemy hunt. A key logs exactly once per
	 * session (no repeat spam) — use __mpGhostDump() for a full re-check anytime. */
	private _mpGhostLogged: { [key: string]: boolean } = Object.create(null);
	public ghostLog(tag: string, key: number | string, ...args: any[]): void {
		try {
			const k = tag + '|' + key;
			if (this._mpGhostLogged[k]) return;
			this._mpGhostLogged[k] = true;
			console.log('[mp-ghost] ' + tag + ' ' + key, ...args);
		} catch (_) { /* diagnostics must never break the frame */ }
	}
	/** The enemy's type name (guarded — reads either of the two engine fields). */
	public ghostName(e: any): string {
		try { return e.enemyName || (e.enemyType && (e.enemyType as any).name) || ''; } catch (_) { return ''; }
	}
	/** The three red "alt" variants reported on autumn path-3 / lake-observatory. */
	public isGhostType(n: string): boolean {
		return n === 'buffalo-alt' || n === 'hedgehog-alt' || n === 'meerkat-alt';
	}
	// ---- round 21 (issue 1): 1s no-collision grace after teleport / map-enter / revival ----
	/** CLIENT-WIDE grace deadline (Date.now() + 1000). While `now < this` (or a mirror's
	 * own _mpNoCollUntil), updateRemoteMirrorFade forces EVERY mirror's coll.type to
	 * IGNORE so the freshly-placed/revived LOCAL player can't overlap them (players and
	 * mirrors are both COLLTYPE.VIRTUAL and DO collide — COLLISION_MAP[VIRTUAL][VIRTUAL]
	 * is true). Time-based: expires on its own, never reset explicitly. Set on local
	 * soft revival (respawn) and on teleport (fireTeleport in onTeleport.ts). */
	public _mpMirrorGraceUntil = 0;
	// ---- round 22: network bandwidth optimization ----
	/** Last time we actually EMITTED a playerState packet (Date.now()). Enforces the
	 * option-driven send-rate floor (default 10Hz, hot-applied via getPlayerStateMs)
	 * + immediate-on-change gate in shouldSendPlayerState. Before this
	 * round the client streamed playerState EVERY rendered frame (60-144Hz on
	 * high-refresh displays) with no cap/gate — the biggest single upload hog. */
	private _mpLastPlayerStateAt = 0;
	/** The LAST-SENT playerState snapshot (the exact packed fields: rounded pos,
	 * face, anim, dead, hp, maxHp, sp, maxSp, cg, em, cl, cs). shouldSendPlayerState
	 * compares the freshly-packed state against this to decide immediate sends.
	 * Stored FULL (em/cl included) so the change-gate works; only the WIRE payload
	 * drops em/cl when unchanged (opt 3). */
	private _mpLastPlayerStateSnap: any = null;
	/** Main-city refactor: last time we emitted the heavy player STATE (hp/sp/etc.)
	 * while in a shared town. Position still streams at 10Hz there; state is folded
	 * into the packet only once per second (1Hz). */
	private _mpTownStateAt = 0;
	/** Solo-instance optimization: last time the ~1Hz minimal position beacon was
	 * emitted (see sendPlayerState). Keeps the server's memberPos fresh while we are
	 * the only member of our instance, without the full 10-60Hz stream. */
	private _mpSoloBeaconAt = 0;
	// ROUND 79: the _mpGuardFieldsMap map-change force-send is gone - the combat-stat
	// fields now ride EVERY playerState packet (see the packer), so no map tracking
	// is needed anymore.
	/** Round 22 (opt 2), split ROUND 23: per-uid last FULLY-ENCODED enemy snapshot for
	 * the host's NON-HOSTILE entityState block delta (enemies with NO current target,
	 * streamed at a fixed 15Hz). An enemy whose encoded fields are unchanged emits a
	 * bare liveness marker {i: uid} instead of the full state; a FULL block every ~1s
	 * self-heals late joiners / dropped blocks. Pruned of dead uids each block;
	 * cleared on map change + host promotion. */
	private _mpLastBaseEncoded: Map<number, IEnemySnap> = new Map();
	/** Round 23: per-uid last FULLY-ENCODED enemy snapshot for the host's HOSTILE
	 * entityState block delta (enemies WITH a current target, streamed at the host's
	 * blockInterval 30/60Hz). Same liveness-marker + full-block + prune machinery as
	 * the base stream — the split keeps engaged enemies streaming fast while idle
	 * enemies sit at a quiet 15Hz. */
	private _mpLastHostileEncoded: Map<number, IEnemySnap> = new Map();
	/** Round 22 (opt 2): accumulated block time (seconds) for the BASE stream. >= 1
	 * forces the next base block to be FULL (all enemies fully encoded) — time-based
	 * so it tracks the fixed 15Hz cadence instead of a fixed counter. */
	private _mpBaseFullAccum = 0;
	/** Round 23: same accumulated full-block trigger for the HOSTILE stream (tracks
	 * blockInterval 30/60Hz). */
	private _mpHostileFullAccum = 0;
	/** Round 23: base-stream send accumulator (seconds, ig.system.tick). Decremented
	 * by tick(); the base block fires when it drops <= 0 and re-arms to 1/15s. The
	 * hostile stream reuses the pre-existing `sendTimer` at blockInterval. */
	private _mpBaseTimer = 0;
	/** Round 22 (opt 2) / Round 23 (split): remote-player mirror count at the last
	 * BASE block. When it GROWS a new player just joined this instance, so the next
	 * base block is forced FULL — a late joiner receiving an all-liveness-marker block
	 * would otherwise see no idle enemies until the next 1s full block. -1 forces the
	 * very first block full (redundant with the empty delta map, harmless). */
	private _mpBaseLastPlayerCount = -1;
	// ---- round 27 (item 4): member guard-state stream -> host-authoritative damage ----
	/** Round 27 (item 4): the local player's guard-action START time (ms), for the
	 * host's perfect-guard window. A guarding local player holds a REAL guard shield
	 * whose connection.perfectGuardTime starts at the perfect window and ticks down;
	 * that window is NOT serializable, so we capture it here via a Combatant.addShield
	 * wrap and stream it to the host, which replays it on our mirror's dynamic shield
	 * (the host then judges regular vs PERFECT guard against our real timing). */
	private _mpGuardStartMs = 0;
	/** Round 27 (item 4): the LOCAL player's real guard-shield perfect window (seconds),
	 * captured when their GUARD action addShield()s — the authoritative window length.
	 * The mirror's dynamic shield falls back to 0.1*(1+gw) when this is absent. */
	private _mpGuardWindowSec = 0;
	/** Round 27 (item 4): change-gate token for the guard/defense fields. Guard press /
	 * release bumps it so shouldSendPlayerState fires an immediate packet (the host
	 * must see guard edges at ~network latency, not the 10Hz floor). */
	private _mpGuardGateToken = 0;
	private _mpGuardLastSent = -1;
	/** Round 23: the same growth-forced-full trigger for the HOSTILE stream, tracked on
	 * its OWN counter so a late joiner gets BOTH streams' first post-join blocks full —
	 * a shared counter would let whichever stream fires first consume the growth and
	 * starve the other of its forced-full (the joiner would miss one stream's enemies
	 * for up to a second). */
	private _mpHostileLastPlayerCount = -1;
	/** Round 24: the last `cb` (combat flag) this BASE stream actually emitted.
	 * sendBaseBlock skips EMPTY blocks (45-75Hz frame churn) unless the combat flag
	 * CHANGED or a force-full fired — comparing against the last emitted value keeps
	 * members' combat mode in sync without flooding. -1 (never a boolean) forces the
	 * very first block to send. Reset on map change / host promotion. */
	private _mpLastBaseCb: boolean | number = -1;
	/** Round 24: same last-emitted-cb tracker for the HOSTILE stream (sendHostileBlock). */
	private _mpLastHostileCb: boolean | number = -1;
	// ---- round 23: member-side persistent liveness stamps (block reap) ----
	/** uid -> last Date.now() this uid appeared in ANY host entityState block (a full
	 * entry or a bare liveness marker). reapStalePuppets kills adopted puppets whose
	 * uid has been absent >600ms — replaces the old per-block seenUid set so a single
	 * dropped block can't reap a live puppet. Cleared on map change. */
	private _mpUidSeen: { [uid: number]: number } = Object.create(null);
	/** mapId -> last Date.now() this static map enemy appeared in a host block.
	 * Unadopted map enemies the host no longer reports are reaped after >600ms
	 * (mirrors the old per-block seenMapId). Cleared on map change. */
	private _mpMapSeen: { [mapId: number]: number } = Object.create(null);
	/** Round 23: accumulated seconds for the ~500ms member-side stale-puppet reap
	 * (reapStalePuppets) — the block-based reap was per-block; the time-based reap
	 * trades an ~600ms delay for robustness against a single dropped block. */
	private _mpReapTimer = 0;
	/** Round 24: count of FULL-flagged entityState blocks seen since map entry (each
	 * stream fires a full block ~1s; reaching 2 means BOTH streams reported a full
	 * roster, so a map enemy missing a stamp is dead-on-host — see the map-enemy
	 * reap branch). Reset to 0 on map change / host promotion. */
	private _mpFullBlockSeen = 0;
	/** Round 24: Date.now() of the most recent entityState block received (member
	 * side). reapStalePuppets refuses to run while no block has arrived for >1200ms
	 * (host stall / dropped connection) so a hiccup can't mass-reap every puppet. */
	private _mpLastBlockAt = 0;

	/** ROUND 39 (item 1): the live SOUND HANDLES this instance started for a remote
	 * player's SUSTAINED (loop:true) sound, keyed by the remote player's name (one
	 * sustained sound per player at a time — the skill charge-up). playAtEntity
	 * returns the handle; we keep it so the soundStop packet can cut the held charge
	 * the instant the remote player releases — the old one-shot relay let the final
	 * charge level ring out to its full buffer end after release. */
	private _mpSustained: { [player: string]: any } = Object.create(null);

	/** Read by the ig.game.respawn shadow installed in install(). */
	public allowNativeRespawn(): boolean { return this._mpAllowRespawn; }

	/** ROUND 103: true when a NATIVE system owns player death rather than the
	 * multiplayer soft-death system — story PVP duels (map isolation), arena rounds
	 * and cutscenes. In those states netSync must not swallow native death hooks,
	 * must not enter its own corpse state, and must let the engine's defeat/KO flow
	 * run. */
	public nativeOwnsDeath(): boolean {
		try {
			if (this.main.isolated) return true;
			const c: any = sc as any;
			if (c.pvp && typeof c.pvp.isActive === 'function' && c.pvp.isActive()) return true;
			if (c.arena && c.arena.active) return true;
			if (this.inCutscene) return true;
			if (c.model && typeof c.model.isCutscene === 'function' && c.model.isCutscene()) return true;
		} catch (_) { /* ignore */ }
		return false;
	}

	/** ROUND 103: true while a mirror is standing over FALL terrain (water/hole)
	 * and should therefore be granted a short aggro grace. Each frame spent over
	 * fall terrain pushes the deadline forward (bounded by live playerState
	 * updates; the engine quick-fall/respawn teleports the mirror back quickly). */
	public prolongMirrorFallGrace(t: any, now: number): boolean {
		try {
			if (!t || !t.coll || !t._mpMirror) return false;
			const terr: any = (ig as any).terrain;
			if (!terr || typeof terr.getPointTerrain !== 'function') return false;
			const w = t.coll.size ? t.coll.size.x : 16;
			const h = t.coll.size ? t.coll.size.y : 16;
			const val = terr.getPointTerrain(
				t.coll.pos.x + w / 2,
				t.coll.pos.y + h / 2,
				t.coll.pos.z + 4,
				Math.min(w, 4),
				Math.min(h, 4),
			);
			if (val && typeof terr.isFallTerrain === 'function' && terr.isFallTerrain(val)) {
				t._mpWaterGraceUntil = now + 1500;
				return true;
			}
		} catch (_) { /* ignore */ }
		return !!(t && t._mpWaterGraceUntil && now < t._mpWaterGraceUntil);
	}

	/** ROUND 103: local-player fall/water flag streamed with playerState. */
	private localOverFallTerrain(): boolean {
		try {
			const p: any = ig.game && ig.game.playerEntity;
			if (!p || !p.coll) return false;
			const t: any = (ig as any).terrain;
			if (!t || typeof t.getPointTerrain !== 'function') return false;
			const w = Math.min(p.coll.size.x || 16, 4);
			const h = Math.min(p.coll.size.y || 16, 4);
			const val = t.getPointTerrain(p.coll.pos.x + (p.coll.size.x || 16) / 2,
				p.coll.pos.y + (p.coll.size.y || 16) / 2, p.coll.pos.z + 4, w, h);
			return !!(val && typeof t.isFallTerrain === 'function' && t.isFallTerrain(val));
		} catch (_) { return false; }
	}

	constructor(private main: Multiplayer) { }

	public install(): void {
		const conn = this.main.connection;
		// ROUND 41 (diag): UNGATED proof that install() ran and on WHICH host object the
		// SoundHelper hook will land. This fires once per connect. If you never see it,
		// netSync.install() is not running (=> zero [mpsfx] is explained).
		try { console.log('[netsync] install() running, SoundHelper=' + (typeof (ig as any).SoundHelper) + '/' + (typeof (ig as any).SoundHelper && (ig as any).SoundHelper.playAtEntity)); } catch (_) { /* ignore */ }
		conn.onPlayerState((p, s) => this.applyPlayerState(p, s));
		conn.onEntityState((map, list, cb, full) => this.applyEntityState(map, list, cb, full));
		// Host forwarded an enemy-hit that landed on OUR mirror: apply it to our real player.
		conn.onCombatHit((hit) => this.applyCombatHit(hit));
		// Member forwarded its damage to US (the host): apply it to the real enemy.
		// ROUND 44 (Fix A): the SAME packet also carries enough info (attackElement/
		// critical) for every NON-host recipient to replay the enemy's hurt sound/FX
		// on its own puppet — this bypasses the fragile host-native showHitEffect →
		// onShowHitEffect → enemySound relay chain that kept silently failing. The
		// attacker itself never receives this (server self-drop), so no double-play.
		conn.onEnemyDamage((hit) => {
			if (this.main.host) { this.applyEnemyDamage(hit); }
			else { this.replayEnemyHurtFxForSpectator(hit); }
		});
		// ROUND 45 (Gap A): the host applied a member's forwarded hit to a real enemy and
		// relayed enemyHurt. Replay the hurt FX on our local puppet for that uid. Only a
		// MEMBER ever receives this (broadcastHostState excludes the host sender), and the
		// attacking member already replayed its own FX, so this covers every spectator.
		conn.onEnemyHurt((hit) => this.replayEnemyHurtFx(hit));
		// Round 21: a member reported a monster hit it detected LOCALLY. Bookkeeping only
		// (their HP streams via playerState); the host must NOT re-apply any damage.
		conn.onCombatResult((hit) => this.onCombatResult(hit));
		// Round 26: a SHARED enemy (uid) had a counter/guard-break FX elsewhere (server-
		// relayed, sender excluded). Replay it on our matching puppet / real enemy so the
		// head popup + speedlines show for everyone, not just the acting member.
		conn.onCombatFx((uid, kind) => this.replayCombatFx(uid, kind));
		// Round 23: the host killed a real enemy and relayed its credits + raw drop
		// table — grant the credits and roll the drops with our own stats (Round 24
		// loot fairness; member side only; the host already got its loot from the real
		// death chain).
		conn.onLoot((loot) => this.applyLoot(loot));
		// ROUND 33 (item 2b): the host relayed an enemy's sound — replay it on our
		// matching puppet so enemies aren't silent for the member.
		conn.onEnemySound((s) => this.applyEnemySound(s));
		// ROUND 34 (item 3): a remote player relayed one of THEIR attack sounds — replay it
		// on our mirror of that player.
		conn.onPlayerSound((s) => this.applyPlayerSound(s));
		// ROUND 43 (skill-release sound): a remote player fired a skill's launch sound we
		// silenced — replay it on their mirror so 回旋斩 / charged shots are audible.
		if (typeof conn.onSkillSound === 'function') conn.onSkillSound((s) => this.applySkillSound(s));
		// ROUND 39 (item 1): a remote player RELEASED a sustained sound (the skill charge-up)
		// — cut the looped handle we started for it so the charge doesn't ring out past release.
		conn.onSoundStop((player) => this.applySoundStop(player));
		// ROUND 95: a remote player used an item — pop the item icon above their head.
		if (typeof conn.onItemUse === 'function') conn.onItemUse((player, item) => showItemUse(player, item));
		// ROUND 99: a remote player healed — spawn their green +N healing jump-number.
		if (typeof conn.onPlayerHeal === 'function') conn.onPlayerHeal((player, amount) => showRemoteHeal(player, amount));
		// ROUND 74 (plant destruct sync): a same-instance player destroyed a plant — destroy
		// our own copy at the same mapId (vanilla chain, idempotent). Guarded like
		// onSkillSound so a mixed client/server pair never crashes.
		if (typeof conn.onPlantBreak === 'function') conn.onPlantBreak((d) => this.applyPlantBreak(d));
		// Round 11: a remote player cast a special skill — replay its effect sheet
		// on their mirror.
		conn.onSkillFx((player, fx) => this.applySkillFx(player, fx));
		// Round 19: a client's cutscene-spawned monsters arrived (the server stamps
		// the stream owner as `from`). Render them as csPuppets on members.
		conn.onCutsceneEntity((from, data) => this.applyCutsceneEntity(from, data));
		// Round 62: the host streamed enemy projectiles (Ball/Stone) so members see
		// ranged attacks (弹幕). Spawn/update visual-only copies; reap absent uids.
		conn.onProjectileState((map, list) => this.applyProjectileState(map, list));
		// ROUND 82 (door transition visuals): a remote player opened a door on OUR map —
		// open our matching door so their enter/exit walk is visible.
		if (typeof conn.onDoorTransition === 'function') {
			conn.onDoorTransition((info) => this.applyRemoteDoorOpen(info));
		}

		// MEMBER-side puppet handling. Round 17: puppets run NO local Enemy AI — the AI's
		// attack clock/timers are never synced, so a member-side monster's attack timing
		// drifted from the host. update() below runs the captured Combatant.update for every
		// _mpPuppet (anim / HP-bar / stun advance, AI skipped). Positions stay host-locked
		// and lerped from the block; attack TIMING is host-driven via the enemyAttack relay
		// (applyEnemyAttack), so monsters still fight members at host-determined moments.
		// Guarded to install ONCE per process (simplify.registerUpdate / inject have no
		// deregistration; reconnecting must not stack pumps/injects).
		if (!(NetSync as any)._hooksInstalled) {
			(NetSync as any)._hooksInstalled = true;
			// The shared tick pump (registerUpdate never unregisters -> install once).
			simplify.registerUpdate(() => {
				const m = (window as any).__mpMain;
				if (m && m.netSync) m.netSync.tick();
			});
			// SUPPRESS the engine's own player-death flow while connected. Engine
			// facts (game.compiled.js): Combatant.update fires _onDeathHit when
			// params.isDefeated() -> sc.combat.onCombatantDeathHit(a, b) -> for the
			// player (b.isPlayer) ig.game.respawn() UNCONDITIONALLY: the native
			// defeat cinematic ending in a checkpoint reload + regenerate(). The
			// PartyModel.isDefeated inject only gates the party-level check, not
			// this path — so shadow the singleton method and skip it for the local
			// player while a multiplayer session is active (our countdown system
			// owns the death). Offline/solo deaths keep the native flow.
			try {
				const combatAny: any = sc as any;
				if (combatAny.combat && typeof combatAny.combat.onCombatantDeathHit === 'function'
					&& !combatAny.combat._mpDeathHitWrapped) {
					combatAny.combat._mpDeathHitWrapped = true;
					const origDeathHit = combatAny.combat.onCombatantDeathHit.bind(combatAny.combat);
					combatAny.combat.onCombatantDeathHit = function (a: any, b: any) {
						try {
							const m = (window as any).__mpMain;
							const pl: any = ig.game && ig.game.playerEntity;
							const connOk = !!(m && m.connection && m.connection.isOpen && m.connection.isOpen());
							const native = !!(m && m.netSync && m.netSync.nativeOwnsDeath && m.netSync.nativeOwnsDeath());
							if (b && pl && b === pl && m && m.netSync && connOk && !native) return;
						} catch (_) { /* fall through to native */ }
						return origDeathHit(a, b);
					};
				}
			} catch (e) { console.warn('[netsync] onCombatantDeathHit wrap failed', e); }
			// SHADOW ig.game.respawn ITSELF (round 8). The onCombatantDeathHit shadow
			// above is NOT enough: the engine's death flow kills the player entity 0.5s
			// later (Combatant.update's DYING branch -> this.kill()), and Player.onKill
			// calls ig.game.respawn() DIRECTLY — a second, independent path into the
			// defeat cinematic + checkpoint reload. That was the round-8 "host spectates
			// for an instant, then still gets the restart flow" bug. ig.game.respawn is
			// the single choke point of the vanilla defeat flow, so guard it here and let
			// ONLY our deliberate all-dead/checkpoint call through (allowNativeRespawn).
			try {
				const g: any = ig.game;
				if (g && typeof g.respawn === 'function' && !g._mpRespawnWrapped) {
					g._mpRespawnWrapped = true;
					const origRespawn = g.respawn.bind(g);
					g.respawn = function (...args: any[]) {
						try {
							const m = (window as any).__mpMain;
							const connOk = !!(m && m.connection && m.connection.isOpen && m.connection.isOpen());
							const allowed = !!(m && m.netSync && m.netSync.allowNativeRespawn && m.netSync.allowNativeRespawn());
							const native = !!(m && m.netSync && m.netSync.nativeOwnsDeath && m.netSync.nativeOwnsDeath());
							if (connOk && !allowed && !native) {
								console.log('[netsync] native ig.game.respawn suppressed (mp death system owns it)');
								return;
							}
						} catch (_) { /* fall through to native */ }
						return origRespawn(...args);
					};
				}
			} catch (e) { console.warn('[netsync] ig.game.respawn wrap failed', e); }
			// STALE-COMBATANT GUARD (round 9). The engine never cleans
			// sc.combat.activeCombatants[ENEMY] (not onLevelLoadStart, not onReset),
			// and killed enemies don't always go through the setTarget(null) removal
			// path — so THREAT entries of long-dead enemies survive map changes and
			// even back-to-title/re-login (sc.combat is a process-wide singleton), and
			// ANY updateCombatMode() re-arms combat from them forever. That was "member
			// inherits the map, then stuck in combat in every area, still stuck after
			// relogging". Purge killed entries inside the combat check itself so no
			// engine-side re-eval can ever re-arm combat from a corpse, and run one
			// purge right now to clean whatever the previous session left behind.
			try {
				const c: any = (sc as any).combat;
				if (c && typeof c.isPlayerPartyInCombat === 'function' && !c._mpInCombatWrapped) {
					c._mpInCombatWrapped = true;
					const origInCombat = c.isPlayerPartyInCombat.bind(c);
					c.isPlayerPartyInCombat = function () {
						try {
							const arr: any[] = c.activeCombatants && c.activeCombatants[(sc as any).COMBATANT_PARTY.ENEMY];
							if (arr) {
								for (let i = arr.length; i--;) {
									if (!arr[i] || arr[i]._killed) arr.splice(i, 1);
								}
							}
						} catch (_) { /* fall through to native */ }
						return origInCombat();
					};
				}
				const m0 = (window as any).__mpMain;
				if (m0 && m0.netSync && typeof m0.netSync.purgeStaleCombatants === 'function') {
					m0.netSync.purgeStaleCombatants();
				}
			} catch (e) { console.warn('[netsync] combatant-purge wrap failed', e); }
			// EXP-IN-TELEPORT GUARD (round 10). Enemy EXP is awarded by the death-check
			// in Combatant.update with NO attacker/map check — and old-map entities keep
			// updating through the teleport fade, so any enemy already at 0 HP (very often
			// killed by a teammate's forwarded damage off-screen) completes its death-check
			// DURING the fade and drops an "inexplicable" EXP gain right as the host switches
			// maps. Suppress addExperience while a teleport is in flight (connected only —
			// solo play keeps vanilla behaviour, including legitimate kill-then-run EXP).
			try {
				const pm: any = (sc as any).model && (sc as any).model.player;
				if (pm && typeof pm.addExperience === 'function' && !pm._mpExpWrapped) {
					pm._mpExpWrapped = true;
					const origAddExp = pm.addExperience.bind(pm);
					pm.addExperience = function (...args: any[]) {
						try {
							const m = (window as any).__mpMain;
							const connOk = !!(m && m.connection && m.connection.isOpen && m.connection.isOpen());
							const g: any = ig.game;
							// `teleporting` is a PERSISTENT object — only its `active` flag
							// (== isTeleporting()) marks an in-flight teleport.
							const teleporting = !!(g && ((g.isTeleporting && g.isTeleporting()) || (g.teleporting && g.teleporting.active)));
							if (connOk && teleporting) {
								console.log('[netsync] suppressed EXP award during teleport');
								return 0;
							}
						} catch (_) { /* fall through to native */ }
						return origAddExp(...args);
					};
				}
			} catch (e) { console.warn('[netsync] addExperience wrap failed', e); }
			// NO-PAUSE WHILE PARTIED / IN A SHARED TOWN (round 10, user: 关闭所有时间暂停功能;
			// ROUND 94: main cities keep time flowing while connected even SOLO — same
			// behaviour as a party). Every user-triggerable gameplay pause (ESC pause menu,
			// main menu / bag / inventory, SHIFT quick menu, skip-confirm dialog,
			// teleport-info dialog) funnels through ig.Game.setPaused(true) — the engine
			// has exactly this one pause API. While in a party with other online players,
			// or while standing in a shared town, we swallow the PAUSE (never the unpause):
			// the GUIs involved are all pauseGui=true elements, so they still open, render
			// and take input — only the world keeps simulating behind them, which is what a
			// shared-world session needs. Charge time-stop is a DIFFERENT mechanism
			// (ig.slowMotion) and is handled by the charge sync instead.
			try {
				const gp: any = (ig as any).Game && (ig as any).Game.prototype;
				if (gp && typeof gp.setPaused === 'function' && !gp._mpPausedWrapped) {
					gp._mpPausedWrapped = true;
					const origSetPaused = gp.setPaused;
					gp.setPaused = function (this: any, b: boolean) {
						try {
							if (b) {
								const m = (window as any).__mpMain;
								const connOk = !!(m && m.connection && m.connection.isOpen && m.connection.isOpen());
								const partied = !!(m && m.partyMembers && m.partyMembers.length > 1);
								const inTown = connOk && isSharedTownNow();
								if (connOk && (partied || inTown)) {
									console.log('[netsync] pause suppressed (' + (inTown ? 'shared town' : 'partied') + ')');
									return;
								}
							}
						} catch (_) { /* fall through to native */ }
						return origSetPaused.call(this, b);
					};
				}
			} catch (e) { console.warn('[netsync] setPaused wrap failed', e); }

			try {
				// Round 11 skill-FX sync: wrap the EffectSheet spawn choke points. Skill
				// visuals are SHOW_EFFECT action steps -> EffectHandle -> sheet.spawnOnTarget/
				// spawnFixed, so wrapping the sheet catches EVERY skill visual the local
				// player casts. We only broadcast the skill sheets (specials.*) targeted AT
				// the local player — sweeps are covered by the anim-based path, and the
				// receiver re-spawns the effect on the caster's mirror.
				const ES: any = (ig as any).EffectSheet;
				if (ES && ES.prototype && !ES.prototype._mpFxWrapped) {
					ES.prototype._mpFxWrapped = true;
					const SKILL_SHEETS: { [path: string]: boolean } = {
						'specials.neutral': true, 'specials.heat': true, 'specials.cold': true,
						'specials.shock': true, 'specials.wave': true, 'specials.icicles': true,
						// ROUND 42 (item 2): the Lv1 arts (回旋斩 spin-slash etc.) live on the PLAIN
						// 'special-neutral' sheet — its finisher* effects carry the real
						// close-combat-sweep-massive PLAY_SOUND (data/effects/special-neutral.json),
						// so the receiver plays the exact art whoosh. Without it only the
						// charge/release blips relayed and the skill fired in silence.
						'special-neutral': true,
						// ROUND 43 (Gap C): every OTHER skill sheet that carries its OWN PLAY_SOUND
						// but was never whitelisted — these fired in silence for spectators. The
						// ELEMENT melee skills (spin slash / dash slash / guard charge in heat/cold/
						// shock/wave) use combat.triblader's heatSpecial*/coldSpecial*/... groups,
						// which carry no PLAY_SOUND of their own — their sounds live on the
						// specials.<element> sheet the same cast also spawns (already whitelisted
						// above). The sheets below are the residual sound-carrying skill sheets:
						//   combat.pentafist  — punch + penta-dash skills (sweep-hi / dash-strong)
						//   combat.quadroguard— shield-bash + AoE-slam guard skills (shield-bash-0x)
						//   combat.hexacast   — the magic-missile pre-charge skill (charge-1s/discharge)
						//   combat.mode       — element-switch mode sounds (*-mode.ogg); not a
						//                       damaging skill but player-triggered and silent before
						//   combat.dark       — the rare dark burst skill (boss/crab/robot-fire)
						// combat.triblader is intentionally OMITTED: its wervynSweep/nSpecial* PLAY_SOUND
						// groups double the specials.* connect + hit sounds the same cast relays, so
						// adding it re-introduces the double-whoosh we removed; its element skills
						// already sound through specials.<element>.
						'combat.pentafist': true, 'combat.quadroguard': true, 'combat.hexacast': true,
						'combat.dark': true,
						// combat.mode is also OMITTED: an element-mode switch already replays
						// via syncModeChangeFx (the *-mode.ogg lives on the combat.mode sheet's
						// neutral/heat/... keys, which that path spawns natively on the mirror) —
						// whitelisting the sheet here too would play the mode sound twice.
					};
					const origSpawnOnTarget = ES.prototype.spawnOnTarget;
					ES.prototype.spawnOnTarget = function (a: string, b: any, c: any) {
						try {
							const m = (window as any).__mpMain;
							if (m && m.netSync && SKILL_SHEETS[this.path] && b && ig.game && b === ig.game.playerEntity) {
								m.netSync.broadcastSkillFx(this.path, a, null, c);
							}
						} catch (_) { /* never break the local effect */ }
						return origSpawnOnTarget.call(this, a, b, c);
					};
					const origSpawnFixed = ES.prototype.spawnFixed;
					ES.prototype.spawnFixed = function (a: string, x: number, y: number, z: number, i: any, j: any) {
						try {
							const m = (window as any).__mpMain;
							if (m && m.netSync && SKILL_SHEETS[this.path] && i && ig.game && i === ig.game.playerEntity) {
								m.netSync.broadcastSkillFx(this.path, a, { x, y, z }, j);
							}
						} catch (_) { /* never break the local effect */ }
						return origSpawnFixed.call(this, a, x, y, z, i, j);
					};
				}
			} catch (e) { console.warn('[netsync] EffectSheet wrap failed', e); }
			try {
				// Resolve the CURRENT NetSync via the live main (not the install-time
				// closure) so a reconnect's fresh instance is honoured.
				const cur = () => { const m = (window as any).__mpMain; return m && m.netSync; };
				// ROUND 19 (Part 1): cutscene latch. sc.model.isCutscene() is true for the
				// WHOLE story sequence; every story path funnels through
				// sc.GameModel.prototype.enterCutscene(b) / enterGame() — wrap that pair
				// so we know exactly when the local player is in a story sequence.
				// enterGame also fires the cutscene-end callback (multiplayer wires it to
				// fire a stashed regroup) and runs the cutscene-stream cleanup (Part 3).
				// Wrappers are try/catch'd and always call the parent.
				try {
					const GM: any = (sc as any).GameModel && (sc as any).GameModel.prototype;
					if (GM && !GM._mpCutsceneWrapped) {
						GM._mpCutsceneWrapped = true;
						if (typeof GM.enterCutscene === 'function') {
							const origEnterCutscene = GM.enterCutscene;
							GM.enterCutscene = function (this: any, b: any) {
								try {
									const ns = cur();
									if (ns) {
										ns.inCutscene = true;
										if (typeof ns.onCutsceneStart === 'function') {
											try { ns.onCutsceneStart(); } catch (_) { /* ignore */ }
										}
									}
								} catch (_) { /* ignore */ }
								return origEnterCutscene.call(this, b);
							};
						}
						if (typeof GM.enterGame === 'function') {
							const origEnterGame = GM.enterGame;
							GM.enterGame = function (this: any, ...args: any[]) {
								try {
									const ns = cur();
									if (ns) {
										ns.inCutscene = false;
										if (typeof ns.onCutsceneEnd === 'function') {
											try { ns.onCutsceneEnd(); } catch (_) { /* ignore */ }
										}
										try { ns.cutsceneCleanup(); } catch (_) { /* ignore */ }
									}
								} catch (_) { /* never break the engine */ }
								return origEnterGame.apply(this, args);
							};
						}
					}
				} catch (e) { console.warn('[netsync] GameModel cutscene wrap failed', e); }
				// Round 26: counter/guard-break FX sync. Both events funnel through
				// sc.combat.doDramaticEffect(attacker, target, kind, ...) with
				// sc.DRAMATIC_EFFECT.GUARD_COUNTER / GUARD_BREAK (engine: game.compiled.js
				// offsets 2415410/2403408). Member-side counters on puppets already play
				// natively (puppets are real Enemies with enemyType.reactions), but only the
				// acting member sees them — wrap the choke point so the observer can relay
				// the event to the instance (host + other members replay it on the same-uid
				// enemy/puppet). Replays set _mpReplayingFx, so the observer skips our own
				// replay and never re-emits (no loop).
				try {
					const combatAny: any = sc as any;
					if (combatAny.combat && typeof combatAny.combat.doDramaticEffect === 'function'
						&& !combatAny.combat._mpDramaticEffectWrapped) {
						combatAny.combat._mpDramaticEffectWrapped = true;
						const origDramatic = combatAny.combat.doDramaticEffect;
						combatAny.combat.doDramaticEffect = function (a: any, b: any, c: any, d: any) {
							try {
								const ns = cur();
								if (ns) ns.observeDramaticEffect(b, c);
							} catch (_) { /* never break the engine effect */ }
							return origDramatic.apply(this, arguments as any);
						};
					}
				} catch (e) { console.warn('[netsync] doDramaticEffect wrap failed', e); }
		// ROUND 35 (item 3): observe the engine's OWN guard sound choke point,
		// sc.combat.showHitEffect — the single function that plays EVERY guard/hit sound
		// (perfectShielded hit-counter-echo / shielded hit-block / element hit), but
		// internally via a non-positional ig.Sound.play() that never touches the
		// playAtEntity hook above. This one wrapper powers all three item-3 fixes:
		//   (1) HOST perfect-guard -> member hears it. A showHitEffect on the local player
		//       with shieldResult PERFECT/REGULAR emits a playerSound packet (the member
		//       replays it on our mirror via applyPlayerSound). The native player guard is
		//       sound-less through this observer (ig.SoundHelper has no positional API), so
		//       the member otherwise heard nothing for a host perfect guard.
		//   (2) Member-guard DOUBLE audio on the host. The member's mirror husk has a
		//       forced-inactive shield (updateShields isActive=false), so the engine judges
		//       SHIELD_RESULT.NONE on it and plays the plain element-hit sound; Round 33
		//       then layered the correct guard sound on top in recomputeHostMonsterHit ->
		//       two sounds at once. Here we detect the husk's plain-hit showHitEffect and
		//       drop the NATIVE call (recompute still plays the single correct guard sound).
		//   (3) ROUND 79: single-source guard audio. The husk's guard FX (host side) is
		//       now VISUAL-ONLY (silent native call, NO relay) — the guarding member's own
		//       client relays the one authoritative hit-block/counter-echo stamped with the
		//       member's name, which the host + every spectator replay positionally at the
		//       member's mirror. This kills the host-side double (husk-native + member relay)
		//       and the 3rd-spectator duplicate pair (host relay + member relay).
		// The hook is UNCONDITIONAL (host + member) so the member's own native guard also
		// relays; a member has no _mpMirror husks, so the suppression branches are inert
		// there. Replays set _mpReplayingFx, so our own replayed showHitEffect never
		// re-emits (no loop).
		try {
			const combatAny: any = sc as any;
			if (combatAny.combat && typeof combatAny.combat.showHitEffect === 'function'
				&& !combatAny.combat._mpShowHitEffectWrapped) {
				combatAny.combat._mpShowHitEffectWrapped = true;
				const origShowHit = combatAny.combat.showHitEffect;
				combatAny.combat.showHitEffect = function (target: any, pos: any, type: any, element: any, shieldResult: any, critical: any, a7: any, a8: any) {
					try {
						const ns = cur();
						if (ns) return ns.onShowHitEffect(origShowHit, this, target, pos, type, element, shieldResult, critical, a7, a8);
					} catch (_) { /* fall through to the native call */ }
					return origShowHit.apply(this, arguments as any);
				};
				// ROUND 41 (diag): UNGATED confirmation that the showHitEffect hook installed
				// on the live sc.combat object (drives EVERY guard/hit sound + the hitnum hook).
				try { console.log('[netsync] showHitEffect WRAPPED ok'); } catch (_) { /* ignore */ }
				// ROUND 40 (diagnostics): the hit-number hook. The engine spawns EVERY damage
				// number (player + enemy, hit + guard) from one static — wrap it so a live
				// repro shows whether the host ever judges a monster-vs-member hit (the root
				// unknown behind item 3). Damage/death routing is unchanged; we only observe.
				try {
					const HitNum: any = ig.ENTITY && (ig.ENTITY as any).HitNumber;
					if (HitNum && typeof HitNum.spawnHitNumber === 'function' && !HitNum._mpSpawnHitWrapped) {
						HitNum._mpSpawnHitWrapped = true;
						const origSpawn = HitNum.spawnHitNumber;
						// ROUND 69 (user-driven repro): the member's native window has no
						// devtools console, so mirror every hitnum line to a per-process
						// log FILE via NW.js' node integration (window.require). The user
						// just plays; we read D:\Dev_cc\hitnum-log-<pid>.txt afterwards.
						// Browser mode has no require -> file logging silently disables.
						let hitnumFs: any = null, hitnumFile: string | null = null;
						try {
							const w: any = window as any;
							const req: any = w && w.require;
							if (req) {
								hitnumFs = req('fs');
								const pid: any = (w.process && w.process.pid) || Math.floor(Math.random() * 1e9);
								hitnumFile = 'D:\\Dev_cc\\hitnum-log-' + pid + '.txt';
								hitnumFs.writeFileSync(hitnumFile, '[mpsfx] hitnum wrap installed\n');
							}
						} catch (_) { hitnumFs = null; hitnumFile = null; }
						HitNum.spawnHitNumber = function (a: any, b: any, c: any, d: any, e: any, f: any, g: any, h: any) {
							// ROUND 70 (member-hit number position): on the host, a member's
							// forwarded hit runs target.damage(mirror, ...) with the member's
							// MIRROR husk as the attacker. The native chain derives the number
							// position from the attacker via getHitCenter -> coll
							// .getOverlapCenterCoords, CLAMPED to the attacker's own coll box
							// (game.compiled.js: d.x.limit(this.pos.x, this.pos.x+size.x)) —
							// so for a ranged member attack (mirror far from the enemy) the
							// number popped at the member's head on the host's screen instead
							// of at the monster. applyEnemyDamage pins _mpHitNumPosOverride to
							// the target for the duration of that call; honor it here. Only
							// the number's position changes — knockback direction, shields,
							// spike bookkeeping all keep reading the mirror's true position.
							let nsHook: any = null;
							try { nsHook = cur(); } catch (_) { /* ignore */ }
							let ovrApplied = false;
							try {
								const ovr: any = nsHook && nsHook._mpHitNumPosOverride;
								if (ovr && typeof ovr.x === 'number') { a = ovr; ovrApplied = true; }
							} catch (_) { /* ignore */ }
							// ROUND 79 (hit-number style): the host's mirror-husk number spawns with the
							// ENGINE's own judgment (q=NONE - the husk's dynamic shield is forced inactive
							// - plus the husk's crit roll), so a member's GUARDED hit always showed the
							// PLAIN style on the host instead of the silver shield / P the member sees.
							// recomputeHostMonsterHit stashes its authoritative verdict style on the mirror
							// before the engine's number tail runs; apply it here (dmg + shield result +
							// the host-side crit roll) and consume the stash.
							try {
								const st: any = b && (b as any)._mpHitNumStyle;
								if (st) {
									if (typeof st.dmg === 'number') c = st.dmg;
									if (typeof st.shield === 'number') f = st.shield;
									g = !!st.crit;
									(b as any)._mpHitNumStyle = undefined;
								}
							} catch (_) { /* ignore */ }
							try {
								const ns = nsHook;
								if (ns) {
									const igAny: any = ig as any;
									const scAny: any = sc as any;
									const me: any = igAny.game && igAny.game.playerEntity;
									const isPlayer = b && b.party === scAny.COMBATANT_PARTY.PLAYER;
									// ROUND 68 (member number-position hunt): log WHERE the
									// number spawns (pos + delta from the local player) and WHO
									// called it (2-frame stack hint: the native onDamage chain
									// vs our spawnHitNumberOn), so a live repro tells whether
									// the member's own-hit number ever spawns at the puppet and
									// exactly which call site puts one on the player's head.
									// Direct console.log (gated on __mpSfxDebug) — _sfxLog's
									// 500ms per-tag throttle would drop most numbers.
									if ((window as any).__mpSfxDebug || hitnumFile) {
										const px: any = a && typeof a.x === 'number' ? Math.round(a.x) : '?';
										const py: any = a && typeof a.y === 'number' ? Math.round(a.y) : '?';
										let ddx: any = '?', ddy: any = '?';
										try {
											if (me && me.coll && a && typeof a.x === 'number') {
												const mc: any = me.coll;
												const ms: any = mc.size || { x: 0, y: 0 };
												ddx = Math.round(a.x - (mc.pos.x + ms.x / 2));
												ddy = Math.round(a.y - (mc.pos.y + ms.y / 2));
											}
										} catch (_) { /* ignore */ }
										let via = '';
										try {
											const st: string = (new Error().stack as any) || '';
											const frames = st.split('\n').slice(1, 6)
												.map((fr: string) => (fr.match(/at\s+([^\s(]+)/) || [])[1] || '')
												.filter((nm: string) => !!nm && nm.indexOf('spawnHitNumber') === -1);
											via = frames.slice(0, 3).join('<');
										} catch (_) { /* ignore */ }
										const line = '[mpsfx] hitnum ' + 'dmg=' + c + ' shield=' + f + ' crit=' + (g === true) +
											' onPlayer=' + (isPlayer ? 1 : 0) + ' onLocalMe=' + (b === me ? 1 : 0) +
											' name=' + (b && b.name) + ' pos=' + px + ',' + py + ' dme=' + ddx + ',' + ddy +
											' via=' + via + ' host=' + (ns.main && ns.main.host ? 1 : 0) +
											' who=' + (ns.main && ns.main.name) + ' ovr=' + (ovrApplied ? 1 : 0);
										if ((window as any).__mpSfxDebug) {
											try { console.log(line); } catch (_) { /* ignore */ }
										}
										if (hitnumFile && hitnumFs) {
											try { hitnumFs.appendFileSync(hitnumFile, line + '\n'); } catch (_) { /* ignore */ }
										}
									}
								}
							} catch (_) { /* never break the hit-number path */ }
							return origSpawn.call(this, a, b, c, d, e, f, g, h);
						};
					}
				} catch (e) { console.warn('[netsync] spawnHitNumber wrap failed', e); }
				// ROUND 41 (diag): UNGATED confirmation the hit-number hook installed (every
				// damage number — the key "a hit was judged" signal for items 2/3).
				if (ig.ENTITY && (ig.ENTITY as any).HitNumber && (ig.ENTITY as any).HitNumber._mpSpawnHitWrapped) {
					try { console.log('[netsync] spawnHitNumber WRAPPED ok'); } catch (_) { /* ignore */ }
				}
			}
		} catch (e) { console.warn('[netsync] showHitEffect wrap failed', e); }
		// ROUND 37 (item 3a): the skill CHARGE sounds (sc.CombatCharge.charge blips +
		// the charge-04 release in .stop) also bypass playAtEntity (bare .play() on an
		// ig.Sound), so the charge/skill layer was silent for watchers. Wrap both methods:
		// when the charging entity IS the local playerEntity, relay the exact asset the
		// engine is about to play (b[c-1] on charge level c, b[3] on release) on the
		// playerSound channel; the rest of the instance replays it on the player's mirror
		// (applyPlayerSound). Native behavior is untouched — we only mirror the sound.
		try {
			const CC: any = (sc as any).CombatCharge;
			if (CC && CC.prototype && !CC.prototype._mpChargeSoundWrapped) {
				CC.prototype._mpChargeSoundWrapped = true;
				const CHARGE_SOUNDS = [
					'media/sound/battle/charge-01-short.mp3',
					'media/sound/battle/charge-02-short.mp3',
					'media/sound/battle/charge-03-short.mp3',
					'media/sound/battle/charge-04.mp3', // release (stop)
				];
				// ROUND 39 (item 1): the held charge blip is now relayed as a SUSTAINED
				// (loop:true) sound and CUT by a soundStop packet on release — the old
				// one-shot (loop:false) relay let the final charge level ring out to its
				// full buffer end on the member even after the host released.
				// ROUND 41 (item 1, the ACTUAL skill-release sound): the native stop() ALSO
				// plays the release blip b[3] = charge-04.mp3 via a BARE .play() (no
				// playAtEntity), so NO observer ever carries it and the member heard the
				// charge cut but NEVER the release sound — exactly the reported "host fires
				// the charged skill, member sees the FX but hears no sound". The old relay
				// only emitted soundStop (cut the loop) and let the blip play natively. Now
				// relay the blip as a one-shot playerSound positioned on the charger's
				// mirror, AND (charged-ball case) re-assert soundStop a moment later so the
				// held charge actually cuts. Why both: a COMBAT-ART skill's stop() runs while
				// the player is still charging (charging.time >= 0 until doCombatArt ->
				// cancelCharge), so the mirror still reads as mid-charge — muting the release
				// blip under the lingering charge loop would make it inaudible, the very bug
				// we are fixing. So for a combat art we drop the soundStop and let the
				// member's ~1.5s natural loop decay fill the gap, keeping the blip loud; for a
				// charged BALL (clearCharge already zeroed charging.time) we DO still send
				// soundStop so the loop cuts crisply. The 200ms deferred re-assert gives the
				// mirror's _mpCharging=false stream update time to land first. */
				const relay = (ns: any, self: any, idx: number, isRelease: boolean) => {
					try {
						if (!ns || ns._mpReplayingFx) return;
						const igA: any = ig as any;
						if (!self || !self.entity || self.entity !== (igA.game && igA.game.playerEntity)) return;
						const conn = ns.main && ns.main.connection;
						if (!conn || !conn.isOpen()) return;
						if (isRelease) {
							const path = CHARGE_SOUNDS[3];
							const ballCase = (self.entity.charging && self.entity.charging.time === -1);
							if (typeof conn.emitPlayerSound === 'function') {
								conn.emitPlayerSound({ path, volume: 0.7, variance: 0, loop: false });
							}
							if (ballCase && typeof (conn as any).emitSoundStop === 'function') {
								(conn as any).emitSoundStop();
								setTimeout(() => { try { (conn as any).emitSoundStop(); } catch (_) { /* ignore */ } }, 200);
							}
							try { ns._sfxLog('cc.release', path, 'ballCase=' + (ballCase ? 1 : 0)); } catch (_) { /* ignore */ }
						} else if (typeof conn.emitPlayerSound === 'function') {
							const path = CHARGE_SOUNDS[Math.max(0, Math.min(3, idx))];
							conn.emitPlayerSound({ path, volume: 0.7, variance: 0, loop: true });
						}
					} catch (_) { /* never break the charge */ }
				};
				const origCharge = CC.prototype.charge;
				if (typeof origCharge === 'function') {
					CC.prototype.charge = function (this: any, c: any, e: any, f: any) {
						try { relay(cur(), this, (typeof c === 'number' ? c : 1) - 1, false); } catch (_) { /* ignore */ }
						return origCharge.apply(this, arguments as any);
					};
				}
				const origStop = CC.prototype.stop;
				if (typeof origStop === 'function') {
					CC.prototype.stop = function (this: any) {
						try { relay(cur(), this, 3, true); } catch (_) { /* ignore */ }
						return origStop.apply(this, arguments as any);
					};
				}
			}
		} catch (e) { console.warn('[netsync] CombatCharge sound wrap failed', e); }
				// ROUND 33 (item 2b): HOST-side observer on ig.SoundHelper.playAtEntity.
				// Member puppets run NO Enemy AI, so the engine's PLAY_SOUND /
				// PLAY_RANDOM_SOUND steps (and every AI/roar sound) never fire on a
				// member — enemies are completely silent for them. On the HOST the real
				// enemy's sound funnels through ig.SoundHelper.playAtEntity (both
				// PLAY_SOUND.run and PLAY_RANDOM_SOUND.run call it for non-global
				// sounds). Wrap it so that when the entity is a real synced Enemy (has a
				// uid, not a puppet/mirror) we relay {uid,path,...} to the members,
				// who replay the same sound positioned on their matching puppet
				// (applyEnemySound). Replays set _mpReplayingFx so the observer skips
				// our own member-side replay and never re-emits (no loop). Host-only:
				// the server relay broadcastHostState no-ops for a non-host sender.
				try {
					const sh: any = (ig as any).SoundHelper;
					if (sh && typeof sh.playAtEntity === 'function' && !sh._mpPlayAtEntityWrapped) {
						sh._mpPlayAtEntityWrapped = true;
						const origPlay = sh.playAtEntity;
						sh.playAtEntity = function (a: any, b: any, c: any, d: any, f: any, g: any) {
							try {
								const ns = cur();
								if (ns) {
									// ROUND 40 (diag): raw visibility into EVERY playAtEntity call
									// so we can see exactly what fires during the item-2/3/5 repro.
									try { ns._sfxLog('pae.fire', ns._paeDescribe(a, b)); } catch (_) { /* ignore */ }
									ns.observeEnemySound(a, b, c, d, g);
									// ROUND 34 (item 3): the SAME hook also catches the LOCAL
									// player's own attack sounds (melee swings / ball throw),
									// which live on an ig.ENTITY.Effect whose .target is the
									// player — observeEnemySound is host-only + Enemy-gated, so
									// it never carries them.
									ns.observePlayerSound(a, b, c, d, g);
									// ROUND 39 (item 5): data-defined effect sounds — the enemy
									// death/boom and the ball-bounce PLAY_SOUND steps fire positioned
									// on the EFFECT entity, which neither of the above catches.
									ns.observeEffectSound(a, b, c, d, g);
									// ROUND 39 (item 3): the local player's hit-receive sound
									// (material/element) is positioned directly on the playerEntity.
									ns.observePlayerHitSound(a, b, c, d, g);
								}
								} catch (_) { /* never break the engine sound */ }
							return origPlay.apply(this, arguments as any);
						};
						// ROUND 41 (diag): UNGATED wrap-confirmation — proves the hook actually
						// installed on the LIVE SoundHelper object (independent of __mpSfxDebug,
						// which apparently was not active during the user's repro). If you never
						// see this line, the wrap never ran and zero [mpsfx] is explained.
						try { console.log('[netsync] playAtEntity WRAPPED ok, typeof=' + typeof (ig as any).SoundHelper.playAtEntity); } catch (_) { /* ignore */ }
					}
				} catch (e) { console.warn('[netsync] playAtEntity wrap failed', e); }
				// Round 16 (issue 7, fix 1b): the dying-corpse frame-0 freeze. The _mpDying
				// branch below skips the FULL original update (that would run the AI), but a
				// bare return freezes the corpse on frame 0 — its anim never advances during
				// the ~500ms death window. Capture the ORIGINAL Combatant.update ONCE here
				// (same "capture a parent ref once" pattern as the getEnemyTarget patch):
				// it advances params (anim/HP-bar / SP-regen / stun) WITHOUT any enemy AI.
				// We can't reach it through Enemy.prototype.update — that also runs the AI
				// (and is what this inject already wraps). Combatant.update's death checks
				// are safe on a dying puppet: puppets have params.isDefeated() patched to
				// return false (see ensurePuppet), and _mpDying never sets this.dying, so
				// its DYING/kill branch can't fire.
				const mpCombatantUpdate = (ig.ENTITY as any).Combatant
					&& (ig.ENTITY as any).Combatant.prototype
					&& (ig.ENTITY as any).Combatant.prototype.update;
				(ig.ENTITY as any).Enemy.inject({
					// Round 17 (issue 1): member puppets NO LONGER run the full Enemy AI. The AI
					// state machine (enemyType.update -> updateAction -> startChoice) keeps its own
					// stateTimers/attack cycle that the host block never syncs, so a puppet's
					// local attack timing/telegraphs drifted further from the host the longer the
					// party stayed in the room. Instead EVERY _mpPuppet (live puppets AND the
					// _mpDying corpses) runs the captured ORIGINAL Combatant.update — it advances
					// the combat params (anim / HP-bar / SP-regen / stun timers, hit-flash) with
					// NO enemy AI. Attack TIMING is now host-driven: the host detects an attack
					// anim edge and relays enemyAttack, which applyEnemyAttack replays on the
					// puppet (setTarget + playAnim). Host-side real enemies are NOT _mpPuppet and
					// keep the full `this.parent()` AI.
					// (Promote-to-host respawns every puppet as a FRESH enemy via spawnEntity, so
					// the respawned enemy never carries _mpPuppet and regains full AI; adopted
					// member-side party BOTS are _mpPuppet too and must NOT run local AI — their
					// positions come from the leader's botState stream, so this is consistent.)
					update(this: any) {
						// Round 14 (fix 5): a puppet staged in the delayed-death queue is frozen —
						// its death anim + blink play out, then the queue's silent kill removes it.
						// Returning early here also keeps the local AI from dropping the target or
						// driving the corpse around during the ~500ms window.
						// Round 16 (issue 7): DON'T bare-return on _mpDying — that froze the corpse
						// on frame 0 (its anim never advanced through the death window, the "tick
						// very low" perception). Call the captured ORIGINAL Combatant.update instead:
						// it advances the corpse's anim/HP-bar/SP while the AI stays skipped.
						// Round 17 (issue 1): live _mpPuppet entities go through the SAME path —
						// Combatant.update keeps their combat params/anim advancing while the
						// independent AI clock is gone. Fall back to a bare return if the ref is
						// missing or throws (matches the round-16 fallback).
						// Round 28 (item 4): a remote-player MIRROR (_mpMirror) goes through the
						// SAME short-circuit. A mirror's hp is streamed to 0 on the owner's soft
						// death a few frames BEFORE playPuppetDeath latches _mpDying — and in that
						// window the full Enemy AI update's Combatant.update death check (which has
						// NO attacker/map gate, see the round-10 EXP-in-teleport guard) would award
						// the mirror husk's exp to EVERY watching client. Treating _mpMirror like
						// _mpPuppet here keeps the vanilla death chain off the mirror entirely; its
						// visual/hp/anim still advance via the captured Combatant.update, and the
						// real removal is driven by the death stream (playPuppetDeath). The husk's
						// exp/enduranceScale are now also 0 (multiplayer.json) as a second fence.
						if ((this as any)._mpDying || (this as any)._mpPuppet || (this as any)._mpMirror) {
							try {
								if (mpCombatantUpdate) return mpCombatantUpdate.call(this);
							} catch (_) { /* fall through to bare return */ }
							return;
						}
						return this.parent();
					},
					// CRASH GUARD: Enemy.onKill dereferences this.enemyType unconditionally
					// (onEntityKill + decreaseRef), but an Enemy whose enemyInfo was missing at
					// spawn has enemyType === null (class default) — and ANY teleport kills
					// every entity via clearMap, so one such enemy crashes the whole game with
					// "Cannot read property 'onEntityKill' of null". Substitute a no-op type so
					// the kill completes, and log exactly what it was so the spawn source can
					// be hunted down.
					onKill(this: any, a: any) {
						try {
							if (!this.enemyType) {
								this.enemyType = {
									name: this.enemyName || '',
									onEntityKill: function () { /* no-op */ },
									decreaseRef: function () { /* no-op */ },
									itemDrops: [], exp: 0, credit: 0, enduranceScale: 1,
								};
								console.warn('[netsync] killed an Enemy with NULL enemyType (crash guarded):'
									+ ' name=' + this.enemyName + ' mapId=' + this.mapId + ' uid=' + this.uid
									+ ' puppet=' + !!this._mpPuppet + ' mirror=' + !!this._mpMirror
									+ ' settings=' + (this.settings && this.settings.enemyInfo ? 'enemyInfo' : 'NONE')
									+ ' map=' + (ig.game && ig.game.mapName));
							}
						} catch (_) { /* ignore */ }
						const r = this.parent(a);
						// Fix 1 (host): re-evaluate combat once the kill fully completed. When
						// the LAST enemy dies while targeting a remote-player MIRROR, the
						// engine's own combat-exit never runs: Combatant.onKill's
						// setTarget(null) fires _removeTargetedBy on the mirror (base
						// Combatant — no updateCombatMode), never on the local player, so
						// setCombatMode(false) never fires and sc.model.combatMode latches
						// true -> hostInCombat() streams cb=true forever (every member held
						// in combat). By the time parent() returns, _killed===true and
						// removeActiveCombatant already ran, so isPlayerPartyInCombat (the
						// inject-wrapped version in this file splices _killed/null entries)
						// is accurate: false -> combat ends with the normal cooldown fade;
						// true (other live enemies) -> identical to vanilla continuation.
						try {
							const ns = cur();
							if (ns && ns.main && ns.main.host && this.party === (sc as any).COMBATANT_PARTY.ENEMY) {
								const m: any = sc as any;
								if (m.model && m.model.setCombatMode && m.combat && m.combat.isPlayerPartyInCombat) {
									m.model.setCombatMode(!!m.combat.isPlayerPartyInCombat());
								}
							}
						} catch (_) { /* never break a kill */ }
						return r;
					},
					// ROUND 23 (loot sync): the enemy death chain ends in Enemy.onDefeat(a).
					// When `a` is falsy (a real death, not a despawn), the engine calls
					// enemyType.resolveDefeat(this), which grants CREDITS + EXP + item drops to
					// the HOST's player only — members miss that entirely (their real enemy died
					// on the host's screen, not theirs). Relay the grant (credits + items) to the
					// instance so every member's player receives the same loot. EXP is NOT
					// relayed: members mirror it via their own death path (block-driven HP ->
					// Combatant.update death check on adopted puppets / doLootMirror for
					// predicted kills). Guards: host-only (the host owns resolveDefeat), a real
					// ENEMY party combatant, NOT a remote-player mirror and NOT a member-side
					// puppet (this branch only runs on the host, where nothing is a puppet, but
					// belt-and-braces). resolveDefeat never runs on a member — the member kills
					// its own puppets via kill(true), which skips the whole death chain.
					onDefeat(this: any, a: any) {
						const r = this.parent(a);
						try {
							const ns = cur();
							if (!a && ns && ns.main && ns.main.host
								&& this.party === (sc as any).COMBATANT_PARTY.ENEMY
								&& !this._mpMirror && !this._mpPuppet && this.enemyType) {
								ns.onHostEnemyDefeated(this);
							}
						} catch (_) { /* never break a kill */ }
						return r;
					},
					// ROUND 27 (item 4, HOST-authoritative guard): when the host's own engine
					// updates a remote-player MIRROR's shields, (re)attach a dynamic player
					// guard shield that reads the owner's STREAMED guard state (stashed on
					// the mirror as _mpGd/_mpGst/_mpGws by applyPlayerState). This lets the
					// host judge REGULAR vs PERFECT guard + the guard damage factor for a
					// member — the member's own local geometry guard model is gone, so the
					// host is now the single damage authority. The shield's isActive is a
					// live function that re-reads the streamed state each isShielded() pass
					// (the mirror is a lockEntity'd husk with no GUARD action of its own).
					updateShields(this: any) {
						try {
							if (this._mpMirror) {
								let hasDyn = false;
								for (let i = this.shieldsConnections.length; i--;) {
									const c = this.shieldsConnections[i];
									if (c && c.shield && c.shield.name === 'mpPlayerGuard') { hasDyn = true; break; }
								}
								if (!hasDyn) {
									const shield = new (sc as any).Shield({
										baseFactor: 1,       // engine base; host recompute handles reduction
										elementFactors: [1, 1, 1, 1],
										strength: 'REGULAR',
										hitResist: 'MASSIVE',
										stableOverride: 'HEAVY',
									}, 'mpPlayerGuard');
									// The shield never blocks at the ENGINE layer — the host-authoritative
									// guard lives in recomputeHostMonsterHit (which reads the same streamed
									// _mp* fields and computes the real member damage). isActive=false keeps
									// the ENGINE's mirror-husk pipeline from ever short-circuiting a hit
									// (damageFactor 0 / stableOverride) while still letting the connection
									// exist as a re-read-live guard-state holder.
									shield.isActive = function () { return false; };
									shield.getDamageFactor = function () { return 1; };
									// perfectTimeSec 0 — the connection timer is unused; guard timing is
									// judged inside recomputeHostMonsterHit from the streamed _mpGst/_mpGws.
									this.addShield(shield, 0);
								}
							}
						} catch (_) { /* never break shield updates */ }
						return this.parent();
					},
					// ROUND 80 (extra-0 guard): on the HOST a member's MIRRORED ball is a
					// real ig.ENTITY.Ball and can physically touch the real enemy natively —
					// producing a second, engine-computed ~0 damage number next to the
					// authoritative forwarded number. The onPreDamageModification branch below
					// already tries to cancel it, but only AFTER Combatant.damage's entry gates
					// and getDamage have run. Block it at the entry point instead: any
					// mirror-rooted hit on a host real enemy is ONLY allowed while
					// applyEnemyDamage has stamped the mirror with _mpForcedDamage (the one
					// authoritative chain). Every other mirror-rooted touch is the stray
					// mirrored-projectile hit and is swallowed before any number/HP write.
					damage(this: any, ...args: any[]) {
						try {
							const ns = cur();
							if (ns && ns.main.host && !(this as any)._mpMirror) {
								const attacker: any = args[0];
								const root: any = attacker && attacker.getCombatantRoot
									? (attacker.getCombatantRoot() || attacker) : attacker;
								if (root && root._mpMirror && root._mpForcedDamage == null) return false;
							}
						} catch (_) { /* detection failure: fall through to native */ }
						return this.parent(...args);
					},
					// Damage hook. Two distinct roles depending on WHO the victim is:
					//
					//  (A) victim is a PUPPET (member-side enemy): the member's hit DOES apply
					//      locally (HP drops + damage number, bot-like feedback) AND is forwarded
					//      to the host via enemyDamage so the authoritative real enemy loses the
					//      same HP. No refund anymore — the member sees their damage land. When a
					//      hit would kill the puppet we kill(true) it (death FX, no loot/kill-var)
					//      and remember the uid so the host block doesn't instantly respawn it.
					//
					//  (B) victim is a remote-player MIRROR (host side): an enemy just hit the
					//      mirror. The mirror's hp is owner-driven (the owner's playerState
					//      overwrites it every frame), so we forward the hit to the owner, whose
					//      client applies it to their REAL player (that's how a member loses HP).
					//
					// The damageResult is the 5th argument (u) — the engine caller is
					// `onPreDamageModification(f,a,c,g,u,q,t)` where `u` is the damage result.
					onPreDamageModification(this: any, a: any, ...rest: any[]) {
						const r = this.parent(a, ...rest);
						const ns = cur();
						if (!ns) return r;
						if (ns.isPuppet(this)) {
							// ROUND 67 (phantom mirror-ball hit): a TEAMMATE's (or the host's)
							// mirrored ball is a live ig.ENTITY.Ball on this client and can
							// physically connect with our puppet. Its native chain uses the
							// owner's MIRROR-husk params (multiplayer.json), so it shows a
							// bogus ~0 damage number AND branch (A) below would forward a
							// second enemyDamage — double-dipping the real enemy with the
							// husk chip. The authoritative damage already lands on the host
							// and streams back via entityState HP, so cancel the chain
							// outright (ignoreHit -> onDamage returns false: no number, no
							// HP write, no forward, no flinch). Only the LOCAL player's own
							// hits (root = ig.game.playerEntity, no _mpMirror) may proceed.
							try {
								const atkPh: any = rest[0];
								const rootPh: any = atkPh && atkPh.getCombatantRoot ? (atkPh.getCombatantRoot() || atkPh) : atkPh;
								if (rootPh && rootPh._mpMirror) {
									try { a.ignoreHit = true; } catch (_) { /* ignore */ }
									return r;
								}
							} catch (_) { /* detection failure: fall through to the normal path */ }
							// (A) member hit a puppet: let the damage stand locally, forward it to
							// the host, and handle the killing blow without loot/kill-vars.
							const dmg = rest[3]; // damageResult (u)
							if (dmg && typeof dmg.damage === 'number' && dmg.damage > 0) {
								// ROUND 35 (item 4): the real AttackInfo is rest[1] (engine arg3),
								// NOT rest[0] (arg2 = the ATTACKER entity — branch B below treats
								// rest[0] as the attacker, and Enemy.onPreDamageModification assigns
								// arg2 to damagingEntity). Passing rest[0] (the member's Ball entity)
								// gave forwardEnemyDamage/shouldFlinchForHit an object with NO numeric
								// .type / .hasHint / .attackerParams, so EVERY ball hit fell to the
								// MEDIUM(2) default and an UNCHARGED ball (real type LIGHT=1) was
								// mis-judged MEDIUM — hitstunning any non-poise enemy both locally
								// and on the host. rest[1] is the genuine defaultNeutral /
								// chargedNeutral AttackInfo (type 1/3, hasHint, attackerParams), so
								// the flinch + interrupt gates now read the same data the native
								// host ball path reads.
								// ROUND 62 (underground invulnerability): a puppet whose host
								// enemy is _hidden (burrowed/phased, hillkat earthIn) is
								// untargetable on the host — the native engine never damages a
								// _hidden enemy. The member's puppet tracked the underground
								// position (fix A), so a ball connected here and the forwarded
								// damage bypassed the host's invulnerability. Undo the local damage
								// the engine just applied and skip the forward/flinch/kill: a hit
								// on an underground enemy is a no-op, exactly like on the host.
								if (this._hidden) {
									try {
										if (this.params && typeof this.params.currentHp === 'number') {
											this.params.currentHp += dmg.damage;
										}
									} catch (_) { /* best-effort */ }
									try { ns._sfxLog('fed.hidden', 'uid=' + (this._mpUid || 0) + ' blocked underground hit dmg=' + dmg.damage); } catch (_) { /* ignore */ }
								} else {
								const atkInfoA: any = rest[1];
								// ROUND 43 (enemy-hurt sound, attacker side): this MEMBER's own client
								// suppressed the puppet's native showHitEffect to avoid a double — so the
								// attacker ALSO heard no hurt sound for their own hit. Re-run the engine's
								// showHitEffect on the puppet at the attack's real attackType/element NOW
								// (connect + material receive, works in 霸体 since sound isn't poise-gated).
								// Host + spectators get it via applyEnemyDamage's spectator replay.
								try {
									const aType: number = (atkInfoA && typeof atkInfoA.type === 'number' && atkInfoA.type > 0) ? atkInfoA.type
										: ((atkInfoA && (atkInfoA.isBall || atkInfoA.ballDamage)) ? 1 : 2);
									const aEl: number = (atkInfoA && typeof atkInfoA.element === 'number' && atkInfoA.element >= 0 && atkInfoA.element <= 4) ? atkInfoA.element : 0;
									ns.playEnemyPuppetHitFx(this, aType, aEl, !!(atkInfoA && atkInfoA.critical === true));
								} catch (_) { /* cosmetic */ }
								// ROUND 72 (style sync): forward the number's FINAL style the
								// local engine just produced, not only the damage. u (rest[3])
								// carries the rolled critical + the offensive/defensive factors
								// (number size + STRONG/WEAK appendix), rest[4] is the shield
								// result (silver GUARD style) and the hook's first arg `a`
								// carries the element-weakness flag — the same five values the
								// native spawnHitNumber tail reads. Without them spectators
								// (and the host's forced chain) could only render plain white.
								ns.forwardEnemyDamage(this, dmg.damage, atkInfoA, {
									critical: dmg.critical === true,
									shield: (typeof rest[4] === 'number') ? rest[4] : 0,
									weak: !!(a && a.weakness),
									off: (typeof dmg.baseOffensiveFactor === 'number') ? dmg.baseOffensiveFactor : 1,
									def: (typeof dmg.defensiveFactor === 'number') ? dmg.defensiveFactor : 1,
								});
								// ROUND 60 (diagnostics): the member→enemy （地鼠） report — a member's
								// ranged hit sometimes shows NO feedback locally and lands for 0~1 on the
								// host. Tag the member-side packet at its source: the local damage the
								// member saw (dmg), the forwarded attack type / ball / charged / element /
								// critical, and the puppet's shield + defense + hitStable at hit time. Paired
								// with the host's aed.* tags this shows whether the number was already tiny
								// here (a member-side puppet-shield reduction) or full here and shrank on the
								// host (a host-side engine-chain reduction / forced-damage miss).
								try {
									const pA: any = this.params;
									const shA: any = this.shield;
									ns._sfxLog('fed.out', 'uid=' + (this._mpUid || 0), 'dmg=' + dmg.damage,
										't=' + ((atkInfoA && typeof atkInfoA.type === 'number') ? atkInfoA.type : ((atkInfoA && (atkInfoA.isBall || atkInfoA.ballDamage)) ? 1 : 2)),
										'ball=' + (!!(atkInfoA && (atkInfoA.isBall || atkInfoA.ballDamage)) ? 1 : 0),
										'chg=' + ((atkInfoA && typeof atkInfoA.hasHint === 'function' && atkInfoA.hasHint('CHARGED')) ? 1 : 0),
										'el=' + ((atkInfoA && typeof atkInfoA.element === 'number') ? atkInfoA.element : 0),
										'crit=' + (!!(atkInfoA && atkInfoA.critical === true) ? 1 : 0),
										'sh=' + ((shA && typeof shA.name === 'string') ? shA.name : (shA ? 'obj' : 0)),
										'gd=' + ((pA && typeof pA.getStat === 'function') ? Math.round((pA.getStat('defense') || 0)) : -1),
										'hs=' + (typeof this.hitStable === 'number' ? this.hitStable : -1));
								} catch (_) { /* never break the forward path */ }
								// Group aggro, exactly like the host: the engine's neighbour
								// notify runs when an enemy ACQUIRES a target, so hitting one
								// member of a cluster aggros the whole cluster here too (and
								// the host's own group aggro streams back via the block's tg).
								ns.notifyGroupAggro(this);
								// Fix 2: immediate flinch. The puppet is lockEntity-locked, so
								// the engine's native damage-flinch setCurrentAnim is dropped by
								// the lock (raw string writes no-op) — write the flinch through
								// the lock. No knockback here: the host's position block conveys
								// the knocked-back position, and a local knockback would fight
								// interpolatePuppets.
								// ROUND 33 (item 3): only flinch for an attack that would natively
								// interrupt the enemy. The old unconditional call flinched on EVERY
								// member hit — so a weak UNCHARGED ball (no hitstun in vanilla) still
								// played walkAnims.damage, which read as "every attack staggers the
								// enemy". Gate on the same interrupt rule the host applies in
								// applyEnemyDamage (typeNum > hitStable): a LIGHT uncharged ball
								// (typeNum 1, stable 0) skips the flinch; melee / charged balls /
								// knockback skills still stagger as vanilla.
								if (ns.shouldFlinchForHit(this, atkInfoA)) ns.syncPuppetHitFlinch(this);
								// PREDICTED kill: this hook runs BEFORE the engine applies the
								// damage, so currentHp still holds the PRE-hit value — project
								// the outcome. (A plain <=0 check here never fired: the killing
								// blow slipped through, the puppet was re-adopted from the next
								// host block at the host's stale hp, and the monster visibly
								// resurrected.)
								if (this.params && this.params.currentHp - dmg.damage <= 0 && !this._killed) {
									const uid = this._mpUid || 0;
									if (uid) ns.noteMemberKill(uid);
									// Round 14 (fix 5): drop the puppet from the block-apply registry
									// BEFORE the death queue runs — with puppets[uid]/lastAnim[uid]
									// gone, ensurePuppet's fast path can't re-adopt a dying puppet
									// during the ~500ms FX window (noteMemberKill is the second fence).
									if (uid) { delete ns.puppets[uid]; delete ns.lastAnim[uid]; }
									// Round 14 (fix 5): stage the delayed death instead of the instant
									// silent kill — flinch anim + pre_die blink now, boom at 220ms then
									// silent kill at ~500ms (processDeathQueue, two-stage; round 16). The
									// _mpTg lock-release (old Fix 1) and the EXP/combat-rank mirror (old
									// Fix 2) moved into the queue's doLootMirror branch, which runs just
									// before the silent kill there.
									ns.playPuppetDeath(this, true);
								}
							}
						}
					} else if (this._mpMirror) {
							// (B) host: an entity hit a remote player's mirror. rest[0] is the
							// attacker — its position rides along so the owner can knock their
							// player away from the hit (round 11).
							// ROUND 21: MONSTER hits are no longer forwarded. The member now
							// detects enemy hits LOCALLY (applyEnemyAttack drives a native
							// localPlayer.damage() and reports back via combatResult), so a
							// forwarded combatHit would double-damage the member (mirror stats +
							// the hand-rolled guard formula were exactly the round-20 mess this
							// replaces). The vanilla mirror damage still lands here — it drives
							// the hit anim / aggro for everyone watching. PVP (a player or
							// player-mirror attacker) is UNCHANGED and still forwards: the
							// member cannot detect another player's hits locally.
							let fwdB = true;
							try {
								const atkB: any = rest[0];
								const rootB: any = atkB && atkB.getCombatantRoot ? (atkB.getCombatantRoot() || atkB) : atkB;
								// Host real enemies (and member-side puppets) are ENEMY-party;
								// player attackers (local player / remote mirror) are PLAYER-party.
								if (rootB && (rootB._mpPuppet
									|| rootB.party === (sc as any).COMBATANT_PARTY.ENEMY)) fwdB = false;
								// ROUND 26 (fail-closed): a hit that did NOT come from a verified
								// PLAYER-party attacker is NOT PvP and must NOT forward. The old
								// logic only withheld hits it could positively identify as monster
								// attacks — anything unidentified (no getCombatantRoot, odd party,
								// null root) still forwarded as a combatHit that the member applied
								// with no geometry check (applyCombatHit), reproducing the "damage
								// at attack-raise, any distance" report. Only a positively-verified
								// player attacker may forward now.
								else if (!(rootB && rootB.party === (sc as any).COMBATANT_PARTY.PLAYER)) fwdB = false;
							} catch (_) {
								// ROUND 26: was "default: forward" — now fail-closed. A monster
								// hit that errors out of detection must die here, not arrive as a
								// phantom combatHit. PvP forwards only from verified attackers.
								fwdB = false;
							}
							if (fwdB) ns.forwardMirrorHit(this, rest[3], rest[0]);
							// ROUND 27 (item 4, HOST-authoritative): a MONSTER (ENEMY-party)
							// attacker — whose hit is WITHHELD above (fwdB false) — is now
							// recomputed HERE on the host against the member's REAL streamed
							// guard state + defense and forwarded. The member's own round-26
							// local geometry model (the source of the "enemy damages you
							// without attacking, at any distance" phantom damage) is being
							// removed (Step D), so the host is now the single damage authority
							// for monster→member hits. The vanilla mirror damage above still
							// plays the hit anim/aggro for watchers; THIS recompute only
							// decides what HP the member actually loses.
							else {
								try {
									const atkM: any = rest[0];
									const rootM: any = atkM && atkM.getCombatantRoot ? (atkM.getCombatantRoot() || atkM) : atkM;
									const du: any = rest[3]; // damageResult the engine computed against the mirror husk
									if (rootM && du && rootM.party === (sc as any).COMBATANT_PARTY.ENEMY
										&& !rootM._mpPuppet && !rootM._mpMirror) {
											// ROUND 41 (item 3): the attack actually CONNECTED on this
											// member's mirror — so the fight is REAL even if the member
											// is far from the host. Latch the enemy ENGAGED-DEFENSIVE on
											// the victim and pin its target back, so the vanilla
											// updateTarget lose-check (distance > loseDistance for
											// loseTime) can't de-aggro it off the far mirror and the
											// host keeps judging their hits. This is the ONLY thing that
											// keeps a far member hittable once engaged: without it an
											// enemy that wandered toward / was kited near the member but
											// sits outside loseDistance of the mirror drops it, the AI
											// never lands another hit, and the member takes NO enemy
											// damage until they walk back into range (the exact report).
											// ROUND 51 (the user's decisive clue — "if the enemy goes to
											// another player right after its attack, I NEVER take the
											// damage; if it stays on me, I ALWAYS do"): this latch must
											// be RETARGET-AWARE, not once-only. The old code only set
											// _mpEngaged when it was unset (`if (!rootM._mpEngaged)`), and
											// updateTarget's re-pin — which only holds the target while
											// the mirror is within loseDistance — drops a member who
											// stands a little away, letting the enemy walk back to the
											// host mid-swing so the connect never reaches the mirror
											// (the "never damaged" case). When the enemy STAYS on the
											// member it repeatedly connects and re-latches, so the member
											// is always hit — matching the report exactly. Re-stamp the
											// latch to THIS victim on EVERY connect, refresh its
											// timestamp, and re-pin the target onto the victim — so even
											// a momentary AI glance at the host is overridden at the very
											// moment the hit lands, and the host keeps judging the
											// member's hits while the mirror is genuinely in range.
											try {
												(rootM as any)._mpEngaged = { name: this.name, ts: Date.now() };
												if (rootM.setTarget && !rootM._killed && rootM.target !== this) rootM.setTarget(this);
												try { rootM.targetLoseTimer = 0; } catch (_) { /* ignore */ }
											} catch (_) { /* ignore */ }
											// ROUND 49/50/51: synthetic anim-edge trigger is DISABLED
											// (_mpSynthHitsEnabled=false), so drainSyntheticHits never stamps
											// _mpSynthSwing. Any stamp present is leftover from a synthetic verdict
											// and must NOT suppress this real physical connect — otherwise a stale
											// stamp would swallow the very hit the member is owed. Simply stamp OUR
											// judgement (harmless; nothing reads it while the trigger is off) and
											// fall through to the authoritative recompute. `return r` is never
											// taken here now, so the member's physical hit always recomputes.
											ns._sfxLog('pdm.recompute', 'dmg=' + (du && du.damage), 'mirror=' + (this && this.name));
											ns.recomputeHostMonsterHit(this, rootM, du, rest[1]);
									}
								} catch (_) { /* a failed recompute must never break the frame */ }
							}
						} else {
							// (C) host: our REAL enemy was damaged through applyEnemyDamage's
							// target.damage(mirror, ...) call — the engine recomputed its own
							// number from the mirror's stats; force the exact forwarded value
							// (the member already saw THIS number land locally).
							// ROUND 67 (stray physical ball connect, HOST only): a member's
							// MIRRORED ball is a live ig.ENTITY.Ball on this host and can hit
							// the REAL enemy natively — showing a husk-stat number (silver ~0
							// against the real shield) and chipping HP before the attacker's
							// forwarded enemyDamage arrives. That forwarded hit is the
							// authority: it re-enters this hook through applyEnemyDamage with
							// _mpForcedDamage set on the SAME mirror, so the forced chain is
							// untouched by this guard. Cancel the stray connect outright
							// (ignoreHit -> no number, no HP chip, no FX).
							try {
								if (ns.main.host) {
									const atkC: any = rest[0];
									const rootC: any = atkC && atkC.getCombatantRoot ? (atkC.getCombatantRoot() || atkC) : atkC;
									if (rootC && rootC._mpMirror && rootC._mpForcedDamage == null) {
										try { a.ignoreHit = true; } catch (_) { /* ignore */ }
										return r;
									}
								}
							} catch (_) { /* detection failure: fall through */ }
							try {
								const atk: any = rest[0];
								const root: any = atk && atk.getCombatantRoot ? (atk.getCombatantRoot() || atk) : atk;
								if (root && root._mpMirror && root._mpForcedDamage != null) {
									const du = rest[3];
									if (du) {
										du.damage = root._mpForcedDamage;
										// ROUND 72 (crit style sync): the host's chain rolled crit
										// off the mirror HUSK's params (near-zero focus), so a
										// member's golden crit showed as a plain white number on
										// the host. Force the attacker's rolled crit flag the
										// same way the damage value is forced.
										if (root._mpForcedCrit) du.critical = true;
										// ROUND 80 (number style sync): the host chain also
										// recomputes baseOffensiveFactor/defensiveFactor from the
										// fabricated MEDIUM attack + the mirror-husk params, so an
										// uncharged member ball (LIGHT, small thin number) rendered
										// as a normal-size melee number on the host. Force the
										// attacker's own rolled factors, exactly like damage/crit.
										if (typeof root._mpForcedOff === 'number') du.baseOffensiveFactor = root._mpForcedOff;
										if (typeof root._mpForcedDef === 'number') du.defensiveFactor = root._mpForcedDef;
										// ROUND 80: weakness rides the same style block (drives the
										// STRONG/WEAK appendix on the number).
										if (typeof root._mpForcedWeak === 'boolean') a.weakness = root._mpForcedWeak;
									}
									root._mpForcedDamage = null;
									root._mpForcedCrit = null;
									root._mpForcedOff = null;
									root._mpForcedDef = null;
									root._mpForcedWeak = null;
								}
							} catch (_) { /* ignore */ }
							// ROUND 72 (host-hit number sync): the host's OWN hit on a real
							// enemy spawned its damage number locally only — members saw
							// nothing (their mirrored-ball phantom numbers are cancelled per
							// ROUND 67, and the sound relay carries no number). Relay the
							// FINAL styled result (damage + rolled crit + shield result +
							// weakness + size factors — the exact five values the native
							// spawnHitNumber tail reads) over enemyHurt so every member pops
							// the identical number on its same-uid puppet. Member-forwarded
							// hits re-entering through applyEnemyDamage have a MIRROR root and
							// are excluded — spectators already get those via enemyDamage.
							try {
								if (ns.main.host) {
									const atkH: any = rest[0];
									const rootH: any = atkH && atkH.getCombatantRoot ? (atkH.getCombatantRoot() || atkH) : atkH;
									const duH: any = rest[3];
									const infoH: any = rest[1];
									if (rootH && !rootH._mpMirror
										&& rootH.party === (sc as any).COMBATANT_PARTY.PLAYER
										&& duH && typeof duH.damage === 'number' && duH.damage > 0
										&& typeof this.uid === 'number' && this.uid > 0
										&& typeof (ns.main.connection as any).emitEnemyHurt === 'function') {
										let tH = 2;
										if (infoH && typeof infoH.type === 'number' && infoH.type > 0) tH = infoH.type;
										else if (infoH && (infoH.isBall || infoH.ballDamage)) tH = 1;
										const elH: number = (infoH && typeof infoH.element === 'number' && infoH.element >= 0 && infoH.element <= 4) ? infoH.element : 0;
										(ns.main.connection as any).emitEnemyHurt({
											uid: this.uid,
											damage: Math.round(duH.damage),
											type: tH,
											attackElement: elH,
											critical: duH.critical === true,
											shield: (typeof rest[4] === 'number') ? rest[4] : 0,
											weak: !!(a && a.weakness),
											off: (typeof duH.baseOffensiveFactor === 'number') ? duH.baseOffensiveFactor : 1,
											def: (typeof duH.defensiveFactor === 'number') ? duH.defensiveFactor : 1,
										});
									}
								}
							} catch (_) { /* number sync is cosmetic — never break the hit */ }
						}
						return r;
					},
				});

				// MEMBER-side Player inject. Rounds 14-20 zeroed any damage whose attacker
				// was a puppet — the real damage arrived as the host's forwarded combatHit,
				// so a local puppet hit had to be suppressed (no double-hit). ROUND 21: that
				// zeroing is GONE — the host no longer forwards monster hits, and a member's
				// local puppet/projectile hits must apply natively (see onPreDamageModification
				// below). PVP-duel isolation and the dead-corpse guard remain.
				try {
					(ig.ENTITY as any).Player.inject({
						// Round 14 (fix 3): while partied (and since ROUND 98: while in a
						// shared town) the menus no longer pause the world (the setPaused
						// swallow above), so ig.game.isControlBlocked() stays FALSE with
						// SHIFT/ESC/TAB open and the local player keeps moving / attacking
						// behind the menu. gatherInput() is the single input choke point
						// (it returns the shared input object the engine reads), so zero the
						// movement/attack axes whenever a menu substate is up — for an online
						// party OR a connected shared-town session (solo players keep the
						// engine's own pause semantics).
						// NOT wrapping isPlayerControlBlocked / isControlBlocked — verified they
						// break quick-menu open and element swapping.
						gatherInput(this: any) {
							const r = this.parent();
							try {
								const m: any = (window as any).__mpMain;
								const connOk = !!(m && m.connection && m.connection.isOpen && m.connection.isOpen());
								const partied = !!(m && m.partyMembers && m.partyMembers.length > 1);
								// ROUND 98: shared towns use the same no-pause + input-block
								// combination as parties — menus stay open but movement/attack
								// axes are zeroed while any menu substate is up.
								const inTown = connOk && isSharedTownNow();
								if (connOk && (partied || inTown)) {
									const mdl: any = (sc as any).model;
									if (mdl && ((mdl.isMenu && mdl.isMenu())
										|| (mdl.isQuickMenu && mdl.isQuickMenu())
										|| (mdl.isPaused && mdl.isPaused()))) {
										r.moveDir.x = 0; r.moveDir.y = 0;
										r.relativeVel = 0;
										r.attack = false; r.melee = false; r.thrown = false; r.autoThrow = false;
										r.aimStart = false; r.aim = false; r.charge = false;
										r.dashX = 0; r.dashY = 0; r.guard = false;
									}
								}
							} catch (_) { /* never break player control */ }
							return r;
						},
						// While dead the corpse takes NO local hits at all (puppet swings,
						// enemy attacks, spikes). Real HP moves via the host's forwarded
						// combatHit (PvP and host-authoritative monster hits — round 27),
						// which gates on _mpDead.
						// Blocking at the damage entry point ALSO stops the engine's
						// onPerfectDash FX/witch-time that the invincibleTimer path would
						// otherwise spam on every blocked hit (and covers hitInvincible/
						// BREAK attacks, which bypass the timer).
						// ROUND 27 (host-authoritative monster damage): on a MEMBER, ANY
						// puppet-rooted damage call on the local player is a DIVERGENT local
						// hit and is swallowed UNCONDITIONALLY HERE at the damage() entry
						// point, before Combatant.damage can even reach onDamage. The host
						// is now the SOLE monster-damage authority (recomputeHostMonsterHit)
						// and its verdict arrives via combatHit -> applyCombatHit; a member
						// never applies a puppet hit locally. This catch-all stops puppet
						// hits that bypass the onPreDamageModification hook when (a) an
						// engine fn is replaced BY NAME on the prototype chain (the engine
						// calls this.onPreDamageModification directly, which a raw prototype
						// overwrite hijacks), (b) a hit arrives with hitProperties we didn't
						// originate, or (c) the attacker is a puppet-OWNED proxy whose
						// getCombatantRoot resolves outside the root check. Swallowing at
						// damage() also keeps the flinch/knockback/sound from playing for a
						// hit that should never have existed.
						damage(this: any, ...args: any[]) {
							try {
								const m = (window as any).__mpMain;
								if (m && m.netSync && m.netSync.isLocalDead()) return false;
								// Member-side puppet-hit swallow (round 27, UNCONDITIONAL):
								// attacker = args[0] (Combatant.damage(a,b,c): a = attacker,
								// b = hitProps, c = target). The host owns monster damage.
								if (m && !m.host) {
									const ns = cur();
									const attacker: any = args[0];
									const root: any = attacker && attacker.getCombatantRoot
										? (attacker.getCombatantRoot() || attacker) : attacker;
									if (ns && root && root._mpPuppet) return false;
								}
							} catch (_) { /* ignore */ }
							return this.parent(...args);
						},
						onPreDamageModification(this: any, a: any, ...rest: any[]) {
							// ROUND 27 damage gate: a member's puppet can still spawn REAL
							// attack actions (stale TACKLE/CIRCLE_ATTACK, pre-pin windows,
							// forces already spawned) whose DIRECT_HIT step damages the local
							// player with NO geometry/distance check. Block ANY puppet-rooted
							// hit UNCONDITIONALLY — the host is the sole monster-damage
							// authority (recomputeHostMonsterHit) and its verdict arrives via
							// combatHit -> applyCombatHit. The engine's onDamage honors
							// ignoreHit and skips applyDamage / flinch / knockback / sound /
							// i-frames entirely. On the host and in solo play there are no
							// _mpPuppet attackers, so this is naturally inert there.
							try {
								const ns = cur();
								if (ns) {
									const attacker = rest[0];
									const root: any = attacker && attacker.getCombatantRoot
										? (attacker.getCombatantRoot() || attacker) : attacker;
									if (root && root._mpPuppet) {
										a.ignoreHit = true;
										return false;
									}
								}
							} catch (_) { /* never break the native pipeline */ }
							const r = this.parent(a, ...rest);
							// ROUND 27: the puppet-damage zeroing is GONE. On a member, ANY
							// puppet-rooted hit is swallowed above (ignoreHit) — the host is
							// the sole monster-damage authority and the verdict arrives via
							// combatHit -> applyCombatHit. On the host / in solo play there
							// are no _mpPuppet attackers, so non-puppet hits (the host's own
							// real enemies, PvP projectiles) flow through the engine's native
							// damage -> onDamage -> isShielded -> applyDamage -> doDamageMovement
							// chain (game.compiled.js ~bytes 2492349/2494500/~2492700/2501339)
							// untouched — guard -> i-frames -> knockback -> perfect guard all
							// stay in the engine where they belong.
							// ROUND 79 (damage diagnostics): log the engine's OWN native result when the
							// HOST player is hit by a real enemy - same field names as rc.dmg/ch.dmg so
							// one captured guarded hit on each machine lines up for comparison.
							try {
								const nsN: any = cur();
								if (nsN && nsN.main && nsN.main.host) {
									const atkEnt: any = rest[0];
									const rootN: any = atkEnt && atkEnt.getCombatantRoot ? (atkEnt.getCombatantRoot() || atkEnt) : atkEnt;
									const u: any = rest[3];
									const ai: any = rest[1];
									if (rootN && rootN.party === (sc as any).COMBATANT_PARTY.ENEMY
										&& !rootN._mpMirror && !rootN._mpPuppet
										&& u && typeof u.damage === 'number' && u.damage > 0) {
										let atkN = 0, defN = 0, dfN = 1, gmN = 0, fcN = 0; let efN = ''; let chipN = -1;
										try {
											if (rootN.params && typeof rootN.params.getStat === 'function') {
												atkN = Number(rootN.params.getStat('attack')) || 0;
											}
											const pp = this.params;
											if (pp && typeof pp.getStat === 'function') {
												defN = Number(pp.getStat('defense')) || 0;
												fcN = Number(pp.getStat('focus')) || 0;
												const ea = pp.getStat('elemFactor');
												if (Array.isArray(ea)) {
													const eaR = ea.map((v: any) => Math.round(Number(v) * 100) / 100);
													efN = JSON.stringify(eaR);
												}
											}
											if (pp && typeof pp.damageFactor === 'number') dfN = pp.damageFactor;
											if (pp && typeof pp.getModifier === 'function') gmN = Number(pp.getModifier('GUARD_STRENGTH')) || 0;
											// Derive the engine's real chip: defensiveFactor = df x elem x chip.
											if (typeof u.defensiveFactor === 'number' && dfN > 0) {
												const elN = (ai && typeof ai.element === 'number' && ai.element >= 1 && ai.element <= 4) ? ai.element : 0;
												let efEl = 1;
												if (elN > 0 && pp && typeof pp.getStat === 'function') {
													const ea2 = pp.getStat('elemFactor');
													if (Array.isArray(ea2) && typeof ea2[elN - 1] === 'number') efEl = Number(ea2[elN - 1]) || 1;
												}
												const denom = dfN * efEl;
												if (denom > 0) chipN = Math.round((u.defensiveFactor / denom) * 1000) / 1000;
											}
										} catch (_) { /* keep zeros */ }
										nsN._sfxLogRaw('nathit',
											'atk=' + atkN, 'def=' + defN, 'df=' + dfN, 'gm=' + gmN, 'ef=' + efN, 'fc=' + fcN,
											'guard=' + (typeof this.currentAnim === 'string' && this.currentAnim === 'guard' ? 1 : 0),
											'aDf=' + ((ai && typeof ai.damageFactor === 'number') ? ai.damageFactor : 1),
											'aDefF=' + ((ai && typeof ai.defenseFactor === 'number') ? ai.defenseFactor : 1),
											'el=' + ((ai && typeof ai.element === 'number') ? ai.element : 0),
											'crit=' + ((u && u.critical) ? 1 : 0),
											'dmg=' + Math.round(u.damage),
											'chip=' + chipN,
											'off=' + ((u && typeof u.offensiveFactor === 'number') ? Math.round(u.offensiveFactor * 1000) / 1000 : -1),
											'defF=' + ((u && typeof u.defensiveFactor === 'number') ? Math.round(u.defensiveFactor * 1000) / 1000 : -1));
									}
								}
							} catch (_) { /* diagnostic only */ }
							return r;
						},
					});
				} catch (e) { console.warn('[netsync] player damage-guard inject failed', e); }
			} catch (e) { console.warn('[netsync] enemy puppet inject failed', e); }

			// Round 27 (item 4): capture the LOCAL player's guard shield params. Their
			// GUARD action calls addShield(shield, perfectWindowSec) when they press guard;
			// that perfect window (and its start time) is NOT serializable, so we grab it
			// here and stream it to the host — the host replays it on our mirror's dynamic
			// shield and can then judge regular vs PERFECT guard against our real timing.
			try {
				// sc.Combatant is UNDEFINED (the combatant base class lives on ig.ENTITY,
				// not sc) — injecting sc.Combatant always threw, so the whole guard-param
				// capture was dead and _mpGuardStartMs stayed 0 → perfect guard never judged.
				(ig.ENTITY as any).Combatant.inject({
					addShield(this: any, shield: any, perfectWindowSec?: number) {
						const conn = this.parent(shield, perfectWindowSec);
						try {
							if (this === (ig.game as any).playerEntity) {
								const m = (window as any).__mpMain;
								const ns = m && m.netSync;
								// ROUND 30 (item 1): the engine's GUARD action step
								// (ADD_PLAYER_SHIELD) builds its shield UNNAMED —
								// `new sc.COMBAT_SHIELDS[type](settings)` and CombatShield.init
								// sets name=b (undefined) — so the old `shield.name==='guard'`
								// test never fired and _mpGuardStartMs stayed 0 (perfect guard
								// dead). Key off the perfect-window arg instead: addShield is
								// called with c>0 ONLY by a perfectGuard action step
								// (`this.perfectGuard&&(c=0.1*(1+PERFECT_GUARD_WINDOW))`), so a
								// positive window identifies the player guard shield.
								if (ns) {
									// ROUND 31 (item 1d): capture the guard-press timestamp on EVERY
									// shield add, not just perfect-window (perfectWindowSec>0) presses.
									// The old gate only wrote _mpGuardStartMs on PERFECT_GUARD presses
									// and never refreshed it otherwise, so a STALE timestamp from an
									// earlier press was streamed on the next guard — corrupting the
									// host's perfect-guard judgment. perfectWindowSec>0 just upgrades
									// the window; the press time must always be fresh.
									ns._mpGuardStartMs = Date.now();
									if (typeof perfectWindowSec === 'number' && perfectWindowSec > 0) {
										ns._mpGuardWindowSec = perfectWindowSec;
									}
									// ROUND 33 (item 1): a guard press the engine routed to the
									// NON-perfect GUARD action (perfectGuardCooldown>0) calls addShield
									// with NO window, so _mpGuardWindowSec was never (re)set for that
									// press and gstSend computed 0 -> the host could never judge the
									// press PERFECT. Derive the window from the player's LIVE modifier
									// whenever the captured one is absent — the engine's own formula
									// (ADD_PLAYER_SHIELD.run: 0.1*(1+PERFECT_GUARD_WINDOW)).
									if (!(ns._mpGuardWindowSec > 0)) {
										try {
											if (this.params && typeof this.params.getModifier === 'function') {
												const gw = Number(this.params.getModifier('PERFECT_GUARD_WINDOW')) || 0;
												ns._mpGuardWindowSec = 0.1 * (1 + gw);
											} else { ns._mpGuardWindowSec = 0.1; }
										} catch (_) { ns._mpGuardWindowSec = 0.1; }
									}
								}
							}
						} catch (_) { /* never break a shield add */ }
						return conn;
					},
				});
			} catch (e) { console.warn('[netsync] addShield wrap failed', e); }

			// Member EnemySpawners must not produce a divergent local horde (the host's
			// spawner output is already mirrored via typed puppets). Do NOT override
			// spawnEnemy to return null — the engine's respawnEnemies/update pushes the
			// result into activeEnemies and then dereferences f.defeatNotified/f.target
			// with NO null guard, crashing the frame loop. Instead no-op the spawner's
			// whole update() on members: it never calls respawnEnemies and never touches
			// activeEnemies, so nothing spawns and nothing crashes.
			try {
				(ig.ENTITY as any).EnemySpawner.inject({
					update(this: any) {
						const m = (window as any).__mpMain;
						if (m && !m.host) return; // member: spawner stays inert
						return this.parent();
					},
				});
			} catch (e) { console.warn('[netsync] EnemySpawner inject failed', e); }

			// ROUND 74 (plant destruct sync): every client owns its own local destructible
			// (plant/bush/stone) copies of the SAME map data. When the local player breaks
			// one, broadcast its stable mapId so every other same-instance client destroys
			// its own copy too (drops + propsDestroyed count + respawn var). The receiver
			// sets _mpSyncedDestroy before calling destroy() — that flag suppresses the
			// re-broadcast here, so the sync can never loop.
			try {
				const IDProto: any = (ig.ENTITY as any).ItemDestruct && (ig.ENTITY as any).ItemDestruct.prototype;
				if (IDProto && typeof IDProto.destroy === 'function' && !IDProto._mpDestructWrapped) {
					IDProto._mpDestructWrapped = true;
					const origDestroy = IDProto.destroy;
					IDProto.destroy = function (this: any) {
						const synced = !!this._mpSyncedDestroy;
						this._mpSyncedDestroy = false;
						const r = origDestroy.call(this);
						try {
							const m = (window as any).__mpMain;
							if (!synced && m && m.netSync) m.netSync.broadcastPlantBreak(this);
						} catch (_) { /* never break the destroy chain */ }
						return r;
					};
				}
			} catch (e) { console.warn('[netsync] ItemDestruct destroy wrap failed', e); }

			// ROUND 19 (Part 3, step 1): flag cutscene-spawned monsters. Story sequences
			// spawn enemies via ig.Game.spawnEntity with mapId 0 and settings WITHOUT
			// skipHook (every mod spawn passes skipHook — mirrors, typed puppets, promote-
			// to-host respawns). Mark those so (a) the member reap pass preserves them
			// locally instead of silently killing them every host block, and (b) the
			// sender stream broadcasts them as temporary csPuppets.
			//
			// ROUND 73 (autumn path-3 ghost enemies): EnemySpawner.spawnEnemy ALSO spawns
			// with mapId 0 and NO skipHook (settings = {enemyInfo, boostable:true}), so the
			// old check mis-flagged every spawner product (buffalo-alt / hedgehog-alt on
			// autumn/lake-observatory) as a "story cutscene enemy". That made reapStalePuppets
			// EXEMPT them from the mapId-0 ghost reap (they accumulated into a big horde the
			// host never owned) AND let a member re-stream them as cutsceneEntity csPuppets
			// (IGNORE coll + isDefeated()->false = invincible on the receiver). `boostable`
			// is set ONLY by EnemySpawner.spawnEnemy (verified against game.compiled.js), so
			// exclude it: genuine story cutscene enemies never carry boostable:true.
			try {
				const gProto: any = (ig as any).Game && (ig as any).Game.prototype;
				if (gProto && typeof gProto.spawnEntity === 'function' && !gProto._mpSpawnWrapped) {
					gProto._mpSpawnWrapped = true;
					const origSpawn = gProto.spawnEntity;
					gProto.spawnEntity = function (this: any, type: string, x: number, y: number, z: number, settings?: any, ...rest: any[]) {
						const r = origSpawn.call(this, type, x, y, z, settings, ...rest);
						try {
							const Enemy = (ig.ENTITY as any).Enemy;
							if (r && r instanceof Enemy && !r._mpMirror
								&& !(settings && settings.skipHook)
								&& !(settings && settings.boostable)
								&& (r.mapId || 0) === 0) {
								r._mpCutsceneSpawned = true;
							}
						} catch (_) { /* never break a spawn */ }
						return r;
					};
				}
			} catch (e) { console.warn('[netsync] spawnEntity wrap failed', e); }

			// ROUND 73 diagnostics (manual): dump every live ghost-type enemy on THIS client
			// with its show/puppet state. Run on BOTH clients (`__mpGhostDump()` in the console)
			// — paired with the host.skip / host.send / member.spawn lines in the boot log it
			// shows exactly who owns/shows these enemies.
			try {
				(window as any).__mpGhostDump = () => {
					try {
						const m = (window as any).__mpMain;
						const list = ig.game && ig.game.entities;
						const Enemy = (ig.ENTITY as any).Enemy;
						const out: any[] = [];
						if (list) {
							for (let i = 0; i < list.length; i++) {
								const e: any = list[i];
								if (!e || !(e instanceof Enemy) || e._killed) continue;
								const n = e.enemyName || (e.enemyType && (e.enemyType as any).name) || '';
								if (n !== 'buffalo-alt' && n !== 'hedgehog-alt' && n !== 'meerkat-alt') continue;
								out.push({
									type: n,
									uid: e.uid,
									mapId: e.mapId || 0,
									shownId: e.id,
									hidden: String(e._hidden),
									hideReq: !!e._hideRequest,
									puppet: !!e._mpPuppet,
									mirror: !!e._mpMirror,
									mpUid: e._mpUid || 0,
									cond: (e.settings && e.settings.spawnCondition) || '(none)',
									hp: e.params ? Math.round(e.params.currentHp || 0) : -1,
									pos: Math.round(e.coll.pos.x) + ',' + Math.round(e.coll.pos.y),
								});
							}
						}
						console.log('[mp-ghost] DUMP host=' + (m && !!m.host) + ' map=' + (ig.game && ig.game.mapName)
							+ ' entities=' + (list ? list.length : -1) + ' found=' + out.length);
						if (out.length) console.table(out);
					} catch (e2) { console.warn('[mp-ghost] dump failed', e2); }
				};
			} catch (e) { console.warn('[netsync] __mpGhostDump install failed', e); }

			// HOST-side: let enemies actually target remote players' mirrors. The engine's
			// target selection is hardcoded to ig.game.playerEntity + sc.party.currentParty
			// (verified against game.compiled.js): proximity aggro (EnemyType.updateTarget)
			// only ever notices the LOCAL player, and reselectTarget (sc.combat.getEnemyTarget)
			// only picks from the player + single-player follower list. A remote player's
			// mirror (an Enemy-typed, party=PLAYER entity) is in neither, so enemies never
			// attack them. setTarget itself is party-agnostic and the whole downstream
			// attack/damage pipeline works on any assigned target, so we just inject mirrors
			// into the two selection points. Gated on main.host (via the live __mpMain).
			try {
				const mirrorTargets = (): any[] => {
					const m = (window as any).__mpMain;
					if (!m || !m.host) return [];
					const out: any[] = [];
					for (const name in m.players) {
						const pl = m.players[name];
						const ent = pl && pl.entity;
						// Round 19 (Part 4): host enemies must NOT aggro a cutscene-bound
						// member — their mirror is faded and they can't defend mid-story.
						if (pl && (pl as any)._mpCutscene) continue;
						// ROUND 103: never acquire a dying/fading/roster-detached mirror.
						if (!ent || ent._killed || ent._hidden || !ent.coll) continue;
						if (ent._mpFadeOutUntil && Date.now() < ent._mpFadeOutUntil) continue;
						if (m.players[name] && m.players[name].entity !== ent) continue;
						out.push(ent);
					}
					return out;
				};
				// Proximity aggro: also consider mirrors when picking up an idle target.
				(sc as any).EnemyType.inject({
					// Round 16 (issue 4): host-side monster HP scaling by party size.
					// EnemyType.initEntity is the construct hook that runs AFTER params are
					// populated (engine-verified — see applyHpScaleOnSpawn); on members the
					// main.host gate makes this a no-op, and the scale is one-shot via the
					// entity's _mpHpScaled marker.
					initEntity(this: any, enemy: any) {
						const r = this.parent(enemy);
						try {
							const m = (window as any).__mpMain;
							const ns = m && m.netSync;
							if (ns && ns.main && ns.main.host) ns.applyHpScaleOnSpawn(enemy);
						} catch (_) { /* never break enemy init */ }
						return r;
					},
					updateTarget(this: any, enemy: any) {
						// ROUND 103: validate an existing MIRROR target BEFORE any engine use.
						// Mirrors despawn/fade on leave; the engine raw ref would otherwise
						// stay latched forever. Drop it and let the acquire paths below (or
						// the vanilla reselect) pick a reachable live target.
						try {
							const t0 = enemy.target;
							if (t0 && t0._mpMirror) {
								const m0 = (window as any).__mpMain;
								const rec = m0 && m0.players && m0.players[t0.name];
								const invalid = !rec || rec.entity !== t0 || t0._killed || !t0.coll
									|| t0._hidden || (t0._mpFadeOutUntil && Date.now() < t0._mpFadeOutUntil);
								if (invalid) {
									if (enemy._mpEngaged && enemy._mpEngaged.name === t0.name) enemy._mpEngaged = null;
									try { enemy.setTarget(null); } catch (_) { /* ignore */ }
								}
							}
						} catch (_) { /* ignore */ }
						// ROUND 41 (item 3): an ENGAGED member (fighting alongside the host)
						// keeps the enemy AI from falling asleep on them. The vanilla
						// updateTarget lose-check below (distance > loseDistance for loseTime)
						// is what drops an enemy off a far mirror; the _mpEngaged re-pin here
						// is what holds it. That engagement is now ALSO latched defensively
						// the moment the enemy's attack actually CONNECTS on a mirror (see the
						// mirror branch of onPreDamageModification), so a member who is merely
						// IN RANGE of an enemy — not just one who attacked first — stays
						// hittable instead of taking no damage until they close on the host.
						this.parent(enemy);
						// ROUND 53 (the "enemy chases the member but never lands a hit" fix): the live dump
						// (uid=416 hedgehog) showed the enemy ENGAGED on test2 with that member's mirror 78px
						// away, yet enemy.target = the HOST player 468px away — beyond its loseDistance — so it
						// sat in the Adjust state forever, walking at an unreachable target and never attacking.
						// Every existing mirror-acquire branch below is gated on !enemy.target, so none of them
						// ever fired while the enemy held ANY target. Retarget here, BEFORE those branches: if
						// the enemy's current target is NOT a mirror and is out of lose range (genuinely
						// unreachable), and a same-block member mirror is within its keep/lose band, switch the
						// target to that reachable mirror. This ONLY changes WHO the enemy aims at — the
						// physical-connect damage chain below is untouched, so no one takes a hit who shouldn't.
						try {
							if (enemy.target && !enemy._killed && !enemy.target._mpMirror) {
								let loseD3 = 320;
								try { const td4 = this.targetDetect; if (td4 && td4.loseDistance > 0) loseD3 = td4.loseDistance; } catch (_) { /* ignore */ }
								let curFar = false;
								let dCur = 1e9;
								try { dCur = enemy.distanceTo(enemy.target); curFar = dCur > loseD3; } catch (_) { curFar = false; }
								// ROUND 105: also switch from the HOST player to a CLOSER party
								// mirror (the pre-water case only switched when the host target was
								// unreachable). After a mirror lost its aggro to a water fall the
								// enemy frequently re-acquired the near host and never returned to
								// the member. Choosing the closer same-block combatant fixes that.
								const mm2 = mirrorTargets();
								let best: any = null, bestD = 1e9;
								for (let mi = 0; mi < mm2.length; mi++) {
									const cand = mm2[mi];
									let sb3 = true;
									try { sb3 = (ig.game as any).getLevelIdx(enemy.coll.pos.z) === (ig.game as any).getLevelIdx(cand.coll.pos.z); } catch (_) { sb3 = true; }
									if (!sb3) continue;
									let dC = 1e9;
									try { dC = enemy.distanceTo(cand); } catch (_) { continue; }
									// only retarget to a mirror that is actually REACHABLE (within the enemy's
									// own keep/lose band), not merely the nearest one.
									if (dC < loseD3 && dC < bestD) { best = cand; bestD = dC; }
								}
								if (best && (curFar || bestD < dCur)) {
										try { const m4 = (window as any).__mpMain; if (m4 && m4.netSync) m4.netSync._sfxLog('tg.reachmirror', 'uid=' + enemy.uid + ' from=nonmirror far dMir=' + Math.round(bestD)); } catch (_) { /* ignore */ }
									// ROUND 59 (diagnostics): narrate the retarget — FROM what (host/mirror/none,
									// with its distance) TO the reachable mirror. Distinguishes the ROUND 53
									// "was aimed at a far host, now aims at the close member" fix from the
									// still-missing "aims at a NEAR host, ignores the member" case (tg.aim).
									try { const m5 = (window as any).__mpMain; if (m5 && m5.netSync) m5.netSync._sfxLog('tg.aim', 'uid=' + enemy.uid, 'from=' + (enemy.target === (ig.game as any).playerEntity ? 'host' : (enemy.target && enemy.target._mpMirror ? ('mirror:' + enemy.target.name) : 'none')), 'dFrom=' + Math.round((enemy.distanceTo && enemy.target) ? enemy.distanceTo(enemy.target) : -1), 'to=' + (best && best.name), 'dTo=' + Math.round(bestD)); } catch (_) { /* ignore */ }
										enemy.setTarget(best);
										try { if (best.name && !enemy._mpEngaged) enemy._mpEngaged = { name: best.name }; } catch (_) { /* ignore */ }
										try { enemy.targetLoseTimer = 0; } catch (_) { /* ignore */ }
									}
								}
						} catch (_) { /* never break target update */ }
						// ROUND 31 (item 2 / item 5): only re-pin a target on an enemy that a MEMBER
						// has ALREADY engaged (its group aggro'd it). The round-30 block re-pinned the
						// NEAREST mirror with NO distance gate on EVERY targetless enemy EVERY frame —
						// so every idle enemy on the whole map locked onto a member's mirror = the
						// full-map-aggro regression. The vanilla acquire branch below (detect range)
						// is the correct proximity path; this re-pin exists solely to keep an enemy
						// ENGAGED after a member's own attack pulls it in (the lose-check would drop a
						// far mirror after loseTime ~3s, killing both damage directions — item 5).
						// Gating on _mpEngaged restores group-scoped aggro while preserving item 5.
						try {
							if (!enemy.target && !enemy._killed && enemy._mpEngaged) {
								const eng = enemy._mpEngaged;
								const m = (window as any).__mpMain;
								const pl = m && m.players ? m.players[eng.name] : null;
								const mir = pl && pl.entity;
								// Re-pin only while the engager's mirror is live + on-map. Once it
								// dies / leaves / despawns, drop the engagement so the enemy goes
								// back to normal (and other mirrors are NOT auto-pulled in).
								// ROUND 37 (item 4): also only re-pin while the mirror is in the
								// enemy's OWN nav-block. CrossCode's A* is per-level-block
								// (redoPath resolves the target node via ig.game.getLevelIdx(z), and
								// the search only walks the enemy's block grid), so a mirror one
								// block over is nav-unreachable — re-pinning it loops forever
								// (path fails -> vanilla lose-drop -> re-pin -> fail), leaving the
								// enemy perpetually "engaged" yet never able to land a hit. Release
								// the engagement so the vanilla lose-check de-aggros it (per-block
								// combat scope); the member can still damage it packet-wise and it
								// re-acquires on proximity when they return.
								if (mir && !mir._killed && !(pl && (pl as any)._mpCutscene) && enemy.setTarget) {
									let sameBlock = true;
									try {
										sameBlock = (ig.game as any).getLevelIdx(enemy.coll.pos.z)
											=== (ig.game as any).getLevelIdx(mir.coll.pos.z);
									} catch (_) { sameBlock = true; }
									if (!sameBlock) {
										enemy._mpEngaged = null;
									} else {
										// ROUND 47 (the "host went idle but member stayed red" fix):
										// only RE-pin the engager's mirror while that mirror is still
										// within the vanilla LOSE range. The old code re-pinned
										// unconditionally and zeroed targetLoseTimer every frame, so an
										// _mpEngaged enemy could NEVER de-aggro off a far member — the
										// re-pin held it red on the member forever while the host AI
										// gave up chasing (out of range = never attacks) = the exact
										// "hostile-looking enemy stopped attacking me" report. Beyond
										// loseDistance the enemy genuinely disengages: release the
										// engagement and let it fall back to the host / a near mirror
										// / idle (which the tn='' block then mirrors to the member's
										// bar). In range it stays pinned and keeps fighting.
										let loseD = 320;
										try { const td2 = this.targetDetect; if (td2 && td2.loseDistance > 0) loseD = td2.loseDistance; } catch (_) { /* ignore */ }
										// ROUND 103: a player who fell into water/quick-fall is being
										// respawned by the engine. Hold the target through the short
										// grace instead of de-aggroing the enemy mid-fall.
										const m0x = (window as any).__mpMain;
										const waterGrace = !!(m0x && m0x.netSync && m0x.netSync.prolongMirrorFallGrace
											&& m0x.netSync.prolongMirrorFallGrace(mir, Date.now()));
										// ROUND 115 (vanilla-like aggro): beyond loseDistance we NO LONGER
										// force-clear the mirror target. The parent updateTarget already
										// advances targetLoseTimer every frame a target is out of lose
										// range and clears it after loseTime (~3s) — that original lock
										// behaviour is what the player expects mid-fight. While inside
										// lose range the re-pin below keeps the fight attached.
										if (!waterGrace && enemy.distanceTo(mir) > loseD) {
											// ROUND 115 (vanilla-like aggro): DO NOT clear the target
											// immediately. EnemyType.updateTarget's parent already ticks
											// targetLoseTimer while beyond loseDistance and drops the target
											// on its own after loseTime (~3s) — exactly the vanilla lock.
											// The earlier far-drop here was the mid-fight "monster suddenly
											// de-aggros" source: any dive/jump past the lose edge instantly
											// erased the target and reset the enemy AI.
											try { const m2 = (window as any).__mpMain; if (m2 && m2.netSync) m2.netSync._sfxLog('tg.hold', 'uid=' + (enemy && enemy.uid) + ' eng=' + (eng && eng.name) + ' d=' + Math.round(enemy.distanceTo(mir)) + '>lose=' + Math.round(loseD)); } catch (_) { /* ignore */ }
											// Deliberately NO setTarget/reset here: the timer running in the
											// parent call owns the genuine disengage, vanilla-style.
										} else {
											enemy.setTarget(mir);
											try { enemy.targetLoseTimer = 0; } catch (_) { /* ignore */ }
										}
									}
								} else {
									enemy._mpEngaged = null;
								}
							}
							// ROUND 115 (vanilla-like aggro): the ROUND 39/48 block that actively
							// cleared cross-block / out-of-lose mirror targets is REMOVED.
							// Vanilla EnemyType.updateTarget already owns de-aggro: it ticks
							// targetLoseTimer beyond loseDistance and clears after loseTime,
							// and EnemyType.onNavigationFailed clears after repeated path
							// failures. Immediate clears here made monsters drop their lock
							// mid-fight the moment a player crossed the lose edge or a z-level
							// boundary, which is the reported detarget/stop-chasing bug.
							// Keeping the vanilla timer restores "locks and chases until the
							// player is genuinely far away".
						} catch (_) { /* never break target update */ }
						// If the vanilla logic didn't acquire a target, try the nearest mirror
						// in detect range (same distance/z-delta rules the vanilla branch uses).
						if (!enemy.target) {
							const mirrors = mirrorTargets();
							if (mirrors.length) {
								const td = this.targetDetect;
								for (let i = 0; i < mirrors.length; i++) {
									const mir = mirrors[i];
									const dist = enemy.distanceTo(mir);
									const dz = Math.abs(enemy.coll.pos.z - mir.coll.pos.z);
									// ROUND 37 (item 4): don't proximity-acquire a mirror in a
									// DIFFERENT nav-block — a mirror with no detectZDelta one block
									// over can fall inside detectDistance in 2D yet is nav-unreachable,
									// re-creating the same engage/fail loop. Same-block only.
									let sameBlock = true;
									try {
										sameBlock = (ig.game as any).getLevelIdx(enemy.coll.pos.z)
											=== (ig.game as any).getLevelIdx(mir.coll.pos.z);
									} catch (_) { sameBlock = true; }
									// ROUND 48: a mirror can sit just OUTSIDE the enemy's tiny detectDistance
									// yet well inside its own MELEE reach (the hedgehog: detect 120, melee band
									// ~144). The vanilla acquire then refuses to pick that near mirror up, so a
									// member close to the host but ~130-150px from the enemy is never acquired =
									// the "sometimes close yet no damage" case. Widen ONLY the mirror-acquire to
									// the enemy's OWN loseDistance (its disengage band): if a target is close
									// enough to KEEP, it is close enough to ACQUIRE. The vanilla host-player
									// acquire (in updateTarget's parent) is untouched; this only affects how the
									// mod lets an enemy pick up a member's mirror.
									let mpAcquire = td.detectDistance;
									try { if (td.loseDistance > mpAcquire) mpAcquire = td.loseDistance; } catch (_) { /* ignore */ }
									if (sameBlock && dist < mpAcquire && (!td.detectZDelta || dz < td.detectZDelta)) {
										if (td.onDistance || td.onCloseBattle) {
											this.assignTarget(enemy, mir, true);
											// ROUND 42 (Symptom 3): a mirror acquired by PROXIMITY was
											// never marked engaged, so the lose-check dropped it after
											// loseTime (~3s) and the re-acquire cancelAction() killed every
											// wound-up attack — the enemy never landed a hit on the member
											// until it went durably targetless and locked the HOST. Latch the
											// engagement here (same flag a connect sets in the mirror branch
											// of onPreDamageModification) so the re-pin above holds the enemy
											// on this mirror instead of oscillating.
											try {
												if (mir.name && !enemy._mpEngaged) enemy._mpEngaged = { name: mir.name };
												enemy.targetLoseTimer = 0;
											} catch (_) { /* ignore */ }
											// ROUND 47: after acquiring a member's mirror, immediately look
											// for a CLOSER live candidate (host player or another mirror).
											// Proximity aggro walks mirrors in join order and latches the
											// FIRST in detect range — so when the host is standing nearer
											// than the member the enemy still locked the far mirror, which
											// then read as "it never comes for the close host, fixates on the
											// far member". Vanilla getEnemyTarget RNG-picks among ALL
											// candidates; approximate that by retargeting to the nearest.
											try {
												const pl0: any = (ig.game as any).playerEntity;
												if (pl0 && !pl0._killed && pl0.coll && enemy.setTarget) {
													const dPl = enemy.distanceTo(pl0);
													const dMir = enemy.distanceTo(mir);
													if (dPl < dMir) {
														let samePl = true;
														try {
															samePl = (ig.game as any).getLevelIdx(enemy.coll.pos.z)
																=== (ig.game as any).getLevelIdx(pl0.coll.pos.z);
														} catch (_) { samePl = true; }
														if (samePl) {
															enemy.setTarget(pl0);
															try { enemy._mpEngaged = null; } catch (_) { /* ignore */ }
														}
													}
												}
											} catch (_) { /* nearest-candidate retarget is best-effort */ }
											break;
										}
									}
								}
							}
						}
					},
				});
				// Reselection (on target death / spawn / neighbour aggro): fold mirrors into
				// the candidate pool so an enemy that loses its target may pick a mirror.
				// getEnemyTarget is a plain prototype method (not a candidate for inject, since
				// we want to REPLACE the candidate list, not wrap it), so capture + override.
				const CombatProto = (sc as any).Combat && (sc as any).Combat.prototype;
				if (CombatProto && !CombatProto._mpGetEnemyTargetPatched) {
					CombatProto._mpGetEnemyTargetPatched = true;
					const origGetEnemyTarget = CombatProto.getEnemyTarget;
					CombatProto.getEnemyTarget = function (this: any) {
						const mirrors = mirrorTargets();
						if (!mirrors.length) return origGetEnemyTarget.call(this);
						const pool = [ig.game.playerEntity, ...mirrors];
						return pool[Math.floor(Math.random() * pool.length)];
					};
					// ROUND 111 (PVP KO retarget crash): while sc.pvp.state === 3 the
					// party getter returns an inert stand-in for network members without
					// local follower entities (see multiplayer.ts). sc.Combat.getEnemyTarget
					// passes that stand-in to _addPartyMember, whose isInScreen probe
					// dereferenced the stand-in's missing coll. Never add the stand-in to
					// the candidate pool at all — the local player is already in it.
					if (typeof CombatProto._addPartyMember === 'function' && !CombatProto._mpAddPartyMemberPatched) {
						CombatProto._mpAddPartyMemberPatched = true;
						const origAddPartyMember = CombatProto._addPartyMember;
						CombatProto._addPartyMember = function (this: any, pool: any, member: any, c: any) {
							if (member && member._mpAbsentNetStandin) return;
							return origAddPartyMember.call(this, pool, member, c);
						};
					}
				}
			} catch (e) { console.warn('[netsync] enemy-target inject failed', e); }

			// Loader-hang safety net. Engine-verified: a resource requested during a map
			// load whose onload throws (e.g. an enemy JSON referencing a combat-condition /
			// proxy / reaction type that isn't registered yet) never reaches
			// loadingFinished(true), so the map Loader's `_unloaded` never drains and
			// `ig.loading` stays true FOREVER — which gates ig.Game.update and wedges the
			// teleport into a permanent black screen that not even a fresh teleport can fix.
			// Wrap onJsonLoaded so a throwing onload is LOGGED (with the resource path) and
			// the resource is still marked finished — the loader completes and the game
			// recovers instead of black-screening. This is a no-op for healthy resources.
			try {
				const JL: any = (ig as any).JsonLoadable;
				if (JL && JL.prototype && !JL.prototype._mpLoadGuard) {
					JL.prototype._mpLoadGuard = true;
					const origOnJsonLoaded = JL.prototype.onJsonLoaded;
					JL.prototype.onJsonLoaded = function (a: any) {
						try {
							return origOnJsonLoaded.call(this, a);
						} catch (e) {
							console.error('[netsync] resource onload threw for ' + this.cacheType + ':' + this.path
								+ ' — marking loaded to avoid a permanent black-screen loader hang.', e);
							try { this.loadingFinished(true); } catch (_) { /* ignore */ }
						}
					};
				}
			} catch (e) { console.warn('[netsync] JsonLoadable guard install failed', e); }
		}
	}

	/** True when `e` is a member-side, host-synced puppet. Anything enemy-typed on a
	 * member that isn't a remote-player mirror is a puppet: either an adopted map
	 * enemy (still has its real mapId) or a spawned fallback (mapId 0). Host
	 * entities and remote-player mirrors are never puppets. */
	private isPuppet(e: any): boolean {
		if (!e || this.main.host) return false;   // host runs full AI
		return !e._mpMirror;                       // every non-mirror enemy on a member
	}

	/**
	 * Round 17 (issue 1): the HOST's real enemy just started an attack (relayed via
	 * enemyAttack — {uid, anim, t} at a fresh attack-anim edge). Our member-side puppet no
	 * longer runs local AI (A1), so replay the attack toward the LOCAL player at the
	 * host's cadence: real aggro (setTarget — the pre-fix AI did the same) + the attack
	 * anim. ROUND 27 (item 4): the relay is now ONLY an ANIM + aggro cue. Damage is NO
	 * longer decided locally at all — the round-26 purely-local collision-gated model
	 * (processLocalEnemyHits / the geometry reach check) was the phantom-damage source
	 * and is REMOVED. The host is the single monster-damage authority
	 * (recomputeHostMonsterHit) and its verdict arrives via combatHit -> applyCombatHit.
	 * Guards: skip dead/dying puppets; a failed relay must never break block-apply. */
	public applyEnemyAttack(uid: number, anim: string, target: string | null): void {
		try {
			if (this.main.host) return;                       // host plays its real enemies
			if (!uid || typeof anim !== 'string' || !anim) return;
			const e: any = this.puppets[uid];
			if (!e || e._killed || e._mpDying || !e.coll) return;
			// Real aggro: the host enemy is attacking, so our puppet engages the local
			// player (faces it like the pre-fix AI did). Matches the host block's tg=1,
			// which re-asserts _mpTg anyway; setting it now avoids a 1-block gap where
			// the puppet's HP bar could read as un-aggroed.
			// Round 19 (Part 4): during OUR OWN cutscene, skip the aggro acquire — we
			// can't defend mid-story. The attack anim still plays (visual only).
			const pl: any = ig.game.playerEntity;
			if (!this.inCutscene && pl && !e._killed && e.setTarget && e.target !== pl) {
				try { e.setTarget(pl); } catch (_) { /* ignore */ }
			}
			e._mpTg = true;
			// Play the attack anim (lock-aware) at the host's cadence. The raw protected
			// write shows it through the lock; playAnim pins it against anim changes.
			try { e.currentAnim = { protected: anim }; } catch (_) { /* ignore */ }
			this.playAnim(e, anim);
			// ROUND 27 (item 4): no more local damage cue. The relay now only drives the
			// attack ANIM + aggro above — the member never decides monster damage locally
			// (that was the phantom-damage source). The host computes the authoritative
			// result (recomputeHostMonsterHit) and it arrives via combatHit -> applyCombatHit.
		} catch (_) { /* a failed attack relay must never break block-apply */ }
	}

	/** ROUND 27 (item 4): the member's local monster-hit geometry gate is GONE. This
	 * method is retained only as a no-op tombstone so no stale call site can reintroduce
	 * member-side damage authority; the host is now the single monster-damage authority
	 * (recomputeHostMonsterHit) and the member applies the verdict via applyCombatHit. */
	private processLocalEnemyHits(): void { /* removed in round 27 — host-authoritative */ }

	/**
	 * HOST side: an enemy just hit a remote player's mirror. The mirror's hp is
	 * owner-driven (the owner's playerState overwrites it every frame), so we don't
	 * damage the mirror — instead forward the hit to the owner, whose client applies
	 * it to their real player. Called from the Enemy.onPreDamageModification hook.
	 * `dmg` is the damageResult (u); we read damage/element/critical off it.
	 */
	public forwardMirrorHit(mirror: any, dmg: any, attacker?: any): void {
		if (!this.main.host) return;                 // only the host computes enemy hits
		if (!mirror || !mirror.name) return;
		// Round 19 (Part 4): never forward a hit to a cutscene-bound member — their
		// mirror is cosmetic during the story sequence, and applying real damage
		// mid-cutscene would fight the story flow.
		try {
			const entry = this.main.players[mirror.name];
			if (entry && (entry as any)._mpCutscene) return;
		} catch (_) { /* ignore */ }
		if (!dmg || typeof dmg.damage !== 'number' || dmg.damage <= 0) return;
		// Rate-limit per mirror so a fast multi-hit enemy can't flood the wire; the
		// owner's i-frames also gate, but this bounds traffic up front.
		const now = Date.now();
		if (mirror._mpLastHitFwd && now - mirror._mpLastHitFwd < 150) return;
		mirror._mpLastHitFwd = now;
		// Round 11: the attacking enemy's position rides along so the owner's client
		// can knock the player away from the hit (projectiles resolve via combatant root).
		let ax: number | undefined;
		let ay: number | undefined;
		try {
			const root: any = attacker && attacker.getCombatantRoot ? (attacker.getCombatantRoot() || attacker) : attacker;
			const c = root && root.coll;
			if (c && c.pos) {
				ax = c.pos.x + (c.size ? c.size.x / 2 : 0);
				ay = c.pos.y + (c.size ? c.size.y / 2 : 0);
			}
		} catch (_) { /* ignore */ }
		// Round 20 (fix 1): the attacker's attack stat rides along so the OWNER's guard
		// can reduce the forwarded damage with the engine's PLAYER-shield formula — the
		// host already reduced the number against the mirror's stats, but the member's
		// guard needs the attacker's real attack value.
		let atk = 0;
		try {
			if (attacker && attacker.params && typeof attacker.params.getStat === 'function') {
				const a = attacker.params.getStat('attack');
				if (typeof a === 'number' && a > 0) atk = a;
			}
		} catch (_) { /* ignore */ }
		this.main.connection.combatHit({
			player: mirror.name,
			damage: dmg.damage,
			element: typeof dmg.element === 'number' ? dmg.element : 0,
			critical: !!dmg.critical,
			ax, ay,
			attack: atk,
		});
	}

	/**
	 * ROUND 27 (item 4, HOST-authoritative monster→member damage): a host REAL enemy
	 * (ENEMY-party, not a puppet/mirror) hit a remote player's mirror. The member's
	 * round-26 local geometry hit-model is gone (it was the source of the phantom
	 * "damage without attacking / at any distance"), so the HOST is now the single
	 * authority. The engine already ran the mirror-husk pipeline and produced `du`,
	 * but that number is wrong for the member: it used the mirror's husk stats
	 * (multiplayer.json def 40) and never saw the member's real guard. Recompute the
	 * authoritative result here against the member's STREAMED state (stashed on the
	 * mirror by applyPlayerState): real defense (_mpDef) and the real guard timing
	 * (_mpGd/_mpGst/_mpGws) + guard modifiers (_mpGw/_mpGm/_mpGa).
	 *
	 *   - PERFECT guard (member pressed guard within their perfect window): 0 damage,
	 *     member plays the perfect-guard FX + counter window (perfect:true).
	 *   - REGULAR guard (holding guard past the window): the engine's PLAYER-shield
	 *     damageFactor (atk/def non-linear curve minus GUARD_STRENGTH), no knockback,
	 *     guard-bar accumulates on the member (regular:true).
	 *   - No guard: raw attack-vs-defense damage + the hit's knockback (hitStable).
	 *
	 * The result forwards over the extended combatHit payload (Step E); the member
	 * applies it verbatim (Step D). Every read is try/catch'd; on any failure we fall
	 * back to forwarding the engine's own number so the member still takes SOME hit
	 * (fail-open toward damage, never silently swallow a real enemy hit).
	 */
	private recomputeHostMonsterHit(mirror: any, attacker: any, du: any, hitProps: any): void {
		const D = (t: string, ...a: any[]) => { try { this._sfxLog('rc.' + t, ...a); } catch (_) { /* ignore */ } };
		D('enter', 'dmg=' + (du && du.damage), 'mirror=' + (mirror && mirror.name));
		if (!this.main.host) { D('nothost'); return; }
		if (!mirror || !mirror.name || !du || typeof du.damage !== 'number' || du.damage <= 0) { D('badargs', 'dmg=' + (du && du.damage)); return; }
		// Same gates as forwardMirrorHit: no hit on a cutscene-bound member, and a
		// per-mirror rate-limit so a fast multi-hit enemy can't flood the wire.
		try {
			const entry = this.main.players[mirror.name];
			if (entry && (entry as any)._mpCutscene) { D('cutscene'); return; }
		} catch (_) { /* ignore */ }
		const now = Date.now();
		// ROUND 27: per-mirror flood gate. The member's own i-frames (applyCombatHit
		// sets invincibleTimer 0.4-0.5s) already absorb any echo closer than ~150ms, so
		// this bounds wire traffic up front without ever dropping a real hit: distinct
		// enemy swings land far further than 150ms apart. (ROUND 50 briefly widened this
		// to the 650ms i-frame gap for the now-removed synthetic burst; ROUND 51 restores
		// 150ms so a genuine fast double-swing can't be merged into one and lost.)
		if (mirror._mpLastHitFwd && now - mirror._mpLastHitFwd < 150) { D('ratelimit'); return; }
		mirror._mpLastHitFwd = now;
		// Attacker position (knockback direction) + attack stat + attack TYPE, same as
		// forwardMirrorHit. ROUND 38: also capture the attack's real attack-type
		// (visualType falling back to type, both numeric sc.ATTACK_TYPE) so the member
		// replays the genuine melee-hit sound instead of the hardcoded LIGHT ball sound.
		let ax: number | undefined; let ay: number | undefined; let atk = 0; let attackType = 0;
		let atkVelX = 0; let atkVelY = 0; // ROUND 65: attacker velocity for the guard direction fallback
		try {
			const root: any = attacker && attacker.getCombatantRoot ? (attacker.getCombatantRoot() || attacker) : attacker;
			const c = root && root.coll;
			if (c && c.pos) { ax = c.pos.x + (c.size ? c.size.x / 2 : 0); ay = c.pos.y + (c.size ? c.size.y / 2 : 0); }
			// ROUND 65: capture the attacker's velocity too — the native direction gate
			// (DIRECTIONAL.isActive) falls back to it when the center-to-center check fails.
			if (c && c.vel) { atkVelX = Number(c.vel.x) || 0; atkVelY = Number(c.vel.y) || 0; }
			if (attacker && attacker.params && typeof attacker.params.getStat === 'function') {
				const a = attacker.params.getStat('attack');
				if (typeof a === 'number' && a > 0) atk = a;
			}
		} catch (_) { /* ignore */ }
		try {
			const vt = (hitProps && typeof hitProps.visualType === 'number' && hitProps.visualType > 0)
				? hitProps.visualType
				: (hitProps && typeof hitProps.type === 'number' ? hitProps.type : 0);
			if (typeof vt === 'number' && vt > 0) attackType = vt;
		} catch (_) { /* ignore */ }
		// Resolve the member's REAL defense: prefer the streamed value, fall back to
		// the engine's own number (which already folded in SOME defense) scaled by the
		// husk-to-real defense ratio. On any doubt, forward the engine number as-is.
		const engineDamage = Math.max(1, Math.round(du.damage));
		let finalDamage = engineDamage;
		let perfect = false; let regular = false;
		// ROUND 78: the guard-BAR damage (engine: e.damageFactor × (atk/def)^1.5, fed to
		// damageShield BEFORE the chip factor is applied) and the full unguarded damage
		// (used when the bar BREAKS — the native chain then skips the shield factor and
		// the victim takes the whole hit). Both ship on the combatHit payload.
		let shieldDmg = 0;
		let fullForBreak = 0;
		// ROUND 79 (element + crit fixes, damage diagnostics): hoisted so the rc.dmg
		// log AND the emit sites outside the try can use them. 'el' was previously
		// read from du.element - a field the engine's damageResult does NOT carry
		// (always undefined -> the member never got element factors). 'crit' is now
		// rolled HERE with the member's streamed real focus instead of reusing the
		// engine's husk-focus roll (du.critical). 'chipF' carries the guard chip for
		// the log (and proves the engine formula matches the host's native one).
		let el = 0;
		let crit = false;
		let chipF = -1;
		try {
			// Attack stat for the formula: prefer the live attacker stat, else the hit's
			// attackerParams (the engine stashes the ATTACKER's params on the DamageInfo).
			if (!(atk > 0) && hitProps && hitProps.attackerParams && typeof hitProps.attackerParams.getStat === 'function') {
				const a = hitProps.attackerParams.getStat('attack');
				if (typeof a === 'number' && a > 0) atk = a;
			}
			const memberDef = (typeof mirror._mpDef === 'number' && mirror._mpDef > 0) ? mirror._mpDef : 0;
			// The guarding flag + timing the member streamed.
			const guarding = !!mirror._mpGd;
			const gw = typeof mirror._mpGw === 'number' ? mirror._mpGw : 0;
			// ROUND 31 (item 1d): gst is now the member's REMAINING perfect-window (seconds,
			// counted on the member's own clock) — NOT a wall-clock timestamp. Comparing two
			// unsynchronised machines' Date.now() made perfect guard deterministically dead
			// (host clock ahead) or always-on (host behind). The member says "0.08s of window
			// left"; the host subtracts only its own recompute latency (it received the packet
			// ~0s ago) plus a small grace for the stream cadence. Monotonic, machine-independent.
			const gstRemain = typeof mirror._mpGst === 'number' ? mirror._mpGst : 0;
			const elapsedSinceSend = (typeof mirror._mpGstAtMs === 'number' && mirror._mpGstAtMs > 0)
				? (now - mirror._mpGstAtMs) / 1000 : 0;
			const GRACE = 0.05; // 50ms grace for the ~10Hz guard-stream cadence + jitter
			// ROUND 32 (item 2b): only extend the window by the grace when the member
			// actually had window left. The old `+GRACE` fired even when gstRemain==0
			// (the member had NOT pressed guard within the window at all), so ANY hit
			// that arrived within 50ms of a guard press — plus the up-to-100ms stream
			// cadence — judged PERFECT, making the window feel >1s. Now: no remaining
			// window -> not perfect, full stop; a real press gets the small transport grace.
			const winLeft = gstRemain > 0 ? gstRemain - elapsedSinceSend + GRACE : 0;
			const gm = typeof mirror._mpGm === 'number' ? mirror._mpGm : 0;
			// ROUND 65 (guard direction fix): `guarding` alone is not enough — the native
			// engine gates a successful guard behind TWO checks (game.compiled.js
			// isShielded ~line 5003 + COMBAT_SHIELDS.DIRECTIONAL.isActive ~line 4892)
			// that this recompute never ran, so a member holding guard blocked hits from
			// ANY direction — even with their back to the monster. Reproduce both:
			//
			//  1) guardable/strength gate (sc.GUARDABLE: AUTO=0 NEVER=1 FROM_ABOVE=2
			//     ALWAYS=3): unblockable attacks ignore guard; FROM_ABOVE attacks need
			//     the top-guard skill (GUARD_AREA >= 2 -> SHIELD_STRENGTH.BLOCK_ABOVE);
			//     BREAK-type attacks beat the player shield's hitResist (MASSIVE=4).
			//     GUARDABLE.ALWAYS skips all three, exactly like the engine.
			//  2) direction gate: the victim must FACE the attacker within a frontal arc
			//     of (range * 180°); range is 0.5 normally and 1 with the omnidirectional
			//     guard skill (GUARD_AREA >= 1 — the same GUARD_AREA modifier the guard
			//     action step reads, already streamed as _mpGa). The engine computes
			//     f = π - |angle(attacker→victim, victim.face)| and passes on f <= arc,
			//     with a fallback pass against the attacker's current velocity.
			const ga = typeof mirror._mpGa === 'number' ? mirror._mpGa : 0;
			const guardRange = ga >= 1 ? 1 : 0.5;   // GUARD_AREA >= 1: omnidirectional guard skill
			const guardAbove = ga >= 2;             // GUARD_AREA >= 2: top-guard (BLOCK_ABOVE) skill
			let guardHolds = guarding;
			if (guardHolds) {
				const guardable = hitProps && typeof hitProps.guardable === 'number' ? hitProps.guardable : 0;
				const hitType = hitProps && typeof hitProps.type === 'number' ? hitProps.type : 0;
				if (guardable !== 3 /* GUARDABLE.ALWAYS */) {
					if (guardable === 1 /* GUARDABLE.NEVER */) guardHolds = false;
					else if (guardable === 2 /* GUARDABLE.FROM_ABOVE */ && !guardAbove) guardHolds = false;
					else if (hitType > 4 /* player shield hitResist = ATTACK_TYPE.MASSIVE */) guardHolds = false;
				}
			}
			if (guardHolds && guardRange < 1) {
				const face = mirror.face;
				const fx = face ? (Number(face.x) || 0) : 0;
				const fy = face ? (Number(face.y) || 0) : 0;
				const arc = guardRange * Math.PI;
				// Vec2.angle semantics: acos(dot/(len*len) clamped) — a ZERO vector yields
				// NaN, which the engine's `|| 0` folds to a 0 angle (f = π -> never blocks).
				const angleToFace = (vx: number, vy: number): number => {
					const vl = Math.sqrt(vx * vx + vy * vy);
					const fl = Math.sqrt(fx * fx + fy * fy);
					if (!(vl > 0) || !(fl > 0)) return 0;
					const c = Math.max(-1, Math.min(1, (vx * fx + vy * fy) / (vl * fl)));
					return Math.acos(c) || 0;
				};
				let pass = false;
				const mc = mirror.coll && mirror.coll.pos && mirror.coll.size
					? { x: mirror.coll.pos.x + mirror.coll.size.x / 2, y: mirror.coll.pos.y + mirror.coll.size.y / 2 }
					: null;
				if (mc && typeof ax === 'number' && typeof ay === 'number') {
					pass = (Math.PI - Math.abs(angleToFace(mc.x - ax, mc.y - ay))) <= arc;
				}
				if (!pass && (atkVelX || atkVelY)) {
					pass = (Math.PI - Math.abs(angleToFace(atkVelX, atkVelY))) <= arc;
				}
				if (!pass) { D('guarddir', 'back turned -> guard broken'); guardHolds = false; }
			}
			// ROUND 78 (vanilla damage law): replicate sc.CombatParams.getDamage EXACTLY
			// (game.compiled.js ~line 2150) for an enemy->player hit instead of the old
			// PERCENTAGE×damageFactor-only base, which drifted from the host's native
			// number (higher OR lower) because it missed:
			//   - e.defenseFactor (the AttackInfo's own defense multiplier),
			//   - g: the victim's params.damageFactor × element factor (elemFactor),
			//   - o: sc.combat.getGlobalDmgFactor(party) (assist × pvp),
			//   - the engine's ±5% damage roll.
			// Every factor is read from the SAME sources the engine reads: the AttackInfo
			// (hitProps), the attacker's params, and the member's streamed def/elemFactor/
			// damageFactor. The crit is rolled HERE (below) against the member's streamed
			// real focus - du.critical used the mirror husk's focus and skewed members.
			const huskDef = 40; // multiplayer.json mirror husk defense (fallback only)
			const pct = (a: number, d: number): number =>
				a > d ? a * (1 + Math.pow(1 - d / a, 0.5) * 0.2) : a * Math.pow(a / d, 1.5);
			const atkPow = atk > 0 ? atk : engineDamage;
			const memberDefForBase = memberDef > 0 ? memberDef : huskDef;
			// l = e.defenseFactor * getStat('defense') — the engine multiplies the
			// victim's defense by the AttackInfo's defenseFactor before PERCENTAGE.
			const atkDefFactor = (hitProps && typeof hitProps.defenseFactor === 'number' && hitProps.defenseFactor > 0)
				? hitProps.defenseFactor : 1;
			const defEff = memberDefForBase * atkDefFactor;
			const base = Math.max(1, pct(atkPow, defEff));
			// g (defensive factor): victim params.damageFactor × element factor.
			let g = (typeof mirror._mpDf === 'number' && mirror._mpDf > 0) ? mirror._mpDf : 1;
			// ROUND 79 (element fix): the engine's damageResult carries NO 'element'
			// field (game.compiled.js getDamage returns damage/defReduced/offensiveFactor/
			// baseOffensiveFactor/elementalDef/defensiveFactor/critical/status - no
			// element), so du.element was ALWAYS undefined and the member's recompute
			// never applied the elemFactor the host's native hit does. Read the element
			// from the AttackInfo (hitProps) - the same object getDamage reads e.element
			// from; fall back to du.element in case some future path ever sets it.
			el = (hitProps && typeof hitProps.element === 'number' && hitProps.element >= 1 && hitProps.element <= 4)
				? hitProps.element
				: ((typeof du.element === 'number' && du.element >= 1 && du.element <= 4) ? du.element : 0);
			if (el > 0 && Array.isArray(mirror._mpEf) && mirror._mpEf.length >= el) {
				const ef = Number(mirror._mpEf[el - 1]);
				if (isFinite(ef) && ef > 0) g = g * ef;
			}
			// k (offensive factor): AttackInfo.damageFactor × (crit × criticalDmgFactor).
			// Enemy attackers carry no skillBonus/BERSERK/MOMENTUM, so the engine's other
			// k-terms are all 0 here.
			let k = (hitProps && typeof hitProps.damageFactor === 'number' && hitProps.damageFactor > 0)
				? hitProps.damageFactor : 1;
			// ROUND 79 (crit fix): the engine rolled the mirror's crit with the HUSK's
			// focus (multiplayer.json ~40). Its chance curve (atkFocus/vicFocus)^0.35 - 0.9
			// x critFactor flips completely across that gap - a member whose real focus
			// makes crits impossible still took the mirror's crits (1.5x damage) and vice
			// versa. Roll the crit HERE against the member's streamed real focus.
			try {
				// 0 is meaningful: an attack with critFactor:0 never crits (chance x 0 = 0).
				const critFactor = (hitProps && typeof hitProps.critFactor === 'number')
					? hitProps.critFactor : 1;
				const memFocus = (typeof mirror._mpFocus === 'number' && mirror._mpFocus > 0) ? mirror._mpFocus : 0;
				const atkP = (hitProps && hitProps.attackerParams) ? hitProps.attackerParams
					: ((attacker && attacker.params) ? attacker.params : null);
				if (memFocus > 0 && atkP && typeof atkP.getStat === 'function') {
					const atkFocus = Number(atkP.getStat('focus')) || 0;
					if (atkFocus > 0) {
						const p = atkFocus / memFocus;
						const chance = (Math.pow(p, 0.35) - 0.9) * critFactor;
						crit = Math.random() <= chance;
					}
				}
			} catch (_) { /* any read failure -> no crit (fail toward the low end) */ }
			if (crit) {
				const critK = (hitProps && hitProps.attackerParams
					&& typeof hitProps.attackerParams.criticalDmgFactor === 'number'
					&& hitProps.attackerParams.criticalDmgFactor > 0)
					? hitProps.attackerParams.criticalDmgFactor : 1.5;
				k = k * critK;
			}
			// o (global factor): the same call the engine makes for the attacker's party.
			let o = 1;
			try {
				const scC: any = (sc as any).combat;
				const atkRoot: any = attacker && attacker.getCombatantRoot ? (attacker.getCombatantRoot() || attacker) : attacker;
				if (scC && typeof scC.getGlobalDmgFactor === 'function' && atkRoot) {
					const og = Number(scC.getGlobalDmgFactor(atkRoot.party));
					if (isFinite(og) && og > 0) o = og;
				}
			} catch (_) { o = 1; }
			// Full unguarded damage vs the member's REAL stats + the engine's ±5% roll.
			const rollJitter = (v: number): number => v * (0.95 + Math.random() * 0.1);
			let baseAgainstMember = Math.max(1, Math.round(rollJitter(base * g * k * o)));
			if (guardHolds && winLeft > 0) {
				// PERFECT guard: no damage, no knockback; member plays the counter window.
				perfect = true;
				finalDamage = 0;
				// ROUND 32 (item 3a): a PERFECT guard on the MEMBER's side must trigger
				// the victim enemy's GUARD_COUNTER reaction exactly like a native perfect
				// guard. The mirror's guard shield is forced-inactive (updateShields), so
				// the engine never judged PERFECT on this host and Enemy.onTargetHit never
				// fired the reaction — the counter was dead end-to-end. Run the reaction
				// directly: the same gate the engine uses (enemyType.reactions[].type ==
				// 'GUARD_COUNTER' + onGuardCounterCheck), then onGuardCountered(enemy,
				// attacker). That switches the enemy to its preSwitchState, plays
				// hit-counter-echo, and calls doDramaticEffect(GUARD_COUNTER) — which the
				// existing wrap relays to every other client (they replay it on their
				// same-uid puppet). isBall=false (this is a melee/monster swing, never a
				// ball), satisfying the engine's !h.isBall gate.
				try { this.triggerGuardCounter(attacker, mirror); } catch (_) { /* counter is best-effort */ }
				// ROUND 35 (item 2, the REAL regression fix): the member never re-entered
				// perfect guard because the host rendered the verdict ONLY as a sound — the
				// Round-33 call below plays hit-counter-echo but spawns NO visual on the
				// mirror. With no mirror FX the member's own screen had nothing to react to
				// and the perfect never read as landed (the follow-up counter never armed).
				// Mirror the member's REAL perfect-guard FX + P-number onto the husk by
				// re-sending the SAME combatHit through applyCombatHit on this host: its
				// player-tag is the member's name (main.name), so the early "not for us"
				// return lets the host render it on the member's mirror verbatim — the exact
				// FX the member sees. Receivers already re-render their own combatHit.
				try {
					this.applyCombatHit({
						player: mirror.name, damage: 0,
						element: el,
						critical: crit, ax, ay, attack: atk, attackType,
						monster: true, perfect: true, regular: false, knockback: false,
					});
				} catch (_) { /* mirror FX is cosmetic */ }
			} else if (guardHolds) {
				// REGULAR guard: engine's PLAYER-shield damageFactor (atk/def curve minus
				// GUARD_STRENGTH). Use the member's real defense + attack stat.
				regular = true;
				const def = memberDef > 0 ? memberDef : huskDef;
				const a = atk > 0 ? atk : baseAgainstMember;
				let f = def > 0 ? a / def : 0;
				f = f <= 1 ? 0.2 - (1 - Math.pow(f, 0.3)) : 0.2 + (Math.pow(f, 1.1) - 1) * 0.35;
				f = Math.max(0, Math.min(1, f - gm));
				chipF = f;
				finalDamage = Math.max(0, Math.round(baseAgainstMember * f));
				// ROUND 78 (guard-bar fix): the bar does NOT take the chip. The engine's
				// PLAYER shield isActive runs damageShield(e.damageFactor × (atk/def)^1.5)
				// BEFORE applying the chip factor (game.compiled.js ~line 4898) — feeding it
				// the chip (the old member-side p.damageShield(chip)) over-drained the bar
				// ~10x, which is why the member's shield shattered after one or two guarded
				// hits. Ship the exact bar value; and ship the FULL hit for the break case
				// (a bar that breaks makes isActive return false -> the chip factor is
				// skipped entirely and the victim takes the whole unguarded hit).
				const atkDf = (hitProps && typeof hitProps.damageFactor === 'number' && hitProps.damageFactor > 0)
					? hitProps.damageFactor : 1;
				shieldDmg = Math.max(0, Math.round(atkDf * Math.pow(a / def, 1.5)));
				fullForBreak = baseAgainstMember;
			} else {
				// No guard: real-defense damage + knockback.
				finalDamage = baseAgainstMember;
			}
			// ROUND 79 (damage diagnostics): one-line dump of every input + verdict the
			// host recompute used. Compared against the host's own native hit (nathit,
			// same field names) and the member's applied result (ch.dmg) this shows
			// EXACTLY which input drifted (def/gm/df/ef/focus/crit/roll).
			try {
				this._sfxLogRaw('rc.dmg',
					'atk=' + atk, 'def=' + memberDef,
					'df=' + (typeof mirror._mpDf === 'number' ? mirror._mpDf : 'nil'),
					'gm=' + gm, 'ga=' + ga,
					'ef=' + (Array.isArray(mirror._mpEf) ? JSON.stringify(mirror._mpEf) : 'nil'),
					'fc=' + (typeof mirror._mpFocus === 'number' ? mirror._mpFocus : 'nil'),
					'guard=' + (guarding ? 1 : 0), 'holds=' + (guardHolds ? 1 : 0),
					'aDf=' + ((hitProps && typeof hitProps.damageFactor === 'number') ? hitProps.damageFactor : 1),
					'aDefF=' + ((hitProps && typeof hitProps.defenseFactor === 'number') ? hitProps.defenseFactor : 1),
					'el=' + el,
					'crit=' + (crit ? 1 : 0),
					'base=' + base,
					'g=' + (Math.round(g * 1000) / 1000),
					'k=' + (Math.round(k * 1000) / 1000),
					'o=' + (Math.round(o * 1000) / 1000),
					'chip=' + chipF,
					'final=' + finalDamage, 'bar=' + shieldDmg, 'full=' + fullForBreak,
					'eng=' + engineDamage,
					'perfect=' + (perfect ? 1 : 0), 'regular=' + (regular ? 1 : 0));
			} catch (_) { /* diagnostic only */ }
		} catch (_) {
			// Any failure: forward the engine's own number (fail-open toward damage).
			finalDamage = engineDamage; perfect = false; regular = false;
		}
		// ROUND 79 (hit-number style): the engine spawns the husk's damage number AFTER
		// this hook returns, with the HUSK's own shield judgment (always NONE - the dynamic
		// shield is forced inactive) and the husk's crit roll. Stash OUR authoritative
		// verdict style on the mirror; the spawnHitNumber wrap applies it (and consumes it)
		// so the host's screen shows the SAME styled number the member sees: silver-shield
		// GUARD / P for guards, the host-side crit roll's color, and the real chip value.
		try {
			(mirror as any)._mpHitNumStyle = {
				dmg: finalDamage,
				shield: perfect ? 2 : (regular ? 1 : 0),
				crit: crit,
			};
		} catch (_) { /* ignore */ }
		// A PERFECT block deals 0 — still forward it (perfect:true) so the member plays
		// the perfect-guard FX + counter window even though no HP is lost.
		// ROUND 33 (item 1c): a REGULAR guard that fully absorbs the hit (chip computed to
		// 0) must ALSO forward — the member's player genuinely blocked, so they must play
		// the regular-guard FX + guard-bar feedback. The old code silently dropped ANY 0
		// non-perfect hit, so a same-level fight (atk/def <= ~0.36 -> chip 0) sent the
		// member NOTHING: no damage, no FX, no guard-bar — which read exactly as "the
		// attack passed straight through me with no feedback". Only a no-guard 0 (which
		// the base-vs-member Math.max(1) never produces) should skip. Send regular: true.
		if (finalDamage <= 0 && !perfect && !regular) {
			// No guard and (somehow) no damage: no packet needed. Skip the wire.
			// ROUND 32 (item 4): still overwrite du.damage so the host's own screen
			// shows 0 (no phantom number/bar dip from the husk-vs-husk engine value).
			try { if (du && typeof du.damage === 'number') du.damage = finalDamage; } catch (_) { /* ignore */ }
			return;
		}
		// ROUND 32 (item 4): the host's own screen must ALSO show the authoritative
		// verdict. The engine's original husk-vs-husk number (du.damage) is what the
		// host renders on the member's mirror (it ran the full damage chain against
		// the 40-defense husk, ~2x the real value). Overwrite it with the verdict we
		// computed against the member's REAL defense so the host's damage number +
		// the teammate HP bar match what the member actually took. PERFECT -> 0 (no
		// number/bar dip on the host either), REGULAR -> the chip, no-guard -> the
		// real-defense value.
		try { if (du && typeof du.damage === 'number') du.damage = finalDamage; } catch (_) { /* ignore */ }
		// ROUND 35 (item 2): mirror the member's REAL regular-guard FX + silver GUARD number
		// onto the husk too (same mechanism as the PERFECT branch above): the host renders the
		// member's own verdict on the mirror instead of only the husk's 40-defense chip.
		if (regular) {
			try {
				this.applyCombatHit({
					player: mirror.name, damage: finalDamage,
					element: el,
					critical: crit, ax, ay, attack: atk, attackType,
					monster: true, perfect: false, regular: true, knockback: false,
				});
			} catch (_) { /* mirror FX is cosmetic */ }
		}
		// ROUND 33 (item 2a): the host heard a NORMAL-hit sound for the member's guard.
		// The mirror's dynamic shield is forced-inactive, so the engine's getShieldFactor
		// returned SHIELD_RESULT.NONE and the vanilla chain played the plain hit sound on
		// this host. Now that the recompute has judged the guard PERFECT / REGULAR, replay
		// the correct guard sound on the host's own screen via the engine's showHitEffect —
		// the same hit-counter-echo.ogg (PERFECT) / hit-block.ogg (REGULAR) a native guard
		// makes. It re-spawns a small hit spark too, which reads as the guard impact.
		if (perfect || regular) {
			try {
				const scAny: any = sc as any;
				if (scAny.combat && typeof scAny.combat.showHitEffect === 'function' && mirror && mirror.coll) {
					const ms = mirror.coll.size || { x: 0, y: 0, z: 0 };
					scAny.combat.showHitEffect(mirror,
						{ x: mirror.coll.pos.x + ms.x / 2, y: mirror.coll.pos.y + ms.y / 2, z: mirror.coll.pos.z + ms.z },
						1 /* LIGHT */, el,
						perfect ? 2 /* SHIELD_RESULT.PERFECT */ : 1 /* SHIELD_RESULT.REGULAR */, false);
				}
			} catch (_) { /* guard sfx is cosmetic */ }
		}
		// ROUND 38: the attack-type is captured up top (with ax/ay/atk) so the perfect/
		// regular mirror FX re-sends above can include it too. See the ax/ay/atk block.
		// ROUND 44 (Fix B): for a PLAIN (non-guard) hit the host is a SPECTATOR and must
		// hear the member-victim's hurt sound too. The combatHit below goes through the
		// server's broadcastToInstance, which EXCLUDES the sender — and the sender here is
		// the host — so the host never runs applyCombatHit for this packet and (in a
		// 2-player game) the only spectator heard nothing. Render the plain-hit FX locally
		// on the member's mirror right now. (Guard hits already render above via the
		// perfect/regular showHitEffect; those sounds DID reach the host, which is exactly
		// why only the plain hit was missing.) _mpReplayingFx guards the relay observers.
		if (!perfect && !regular) {
			try {
				const scAny: any = sc as any;
				if (scAny.combat && typeof scAny.combat.showHitEffect === 'function' && mirror && mirror.coll) {
					const ms = mirror.coll.size || { x: 0, y: 0, z: 0 };
					const at: number = (typeof attackType === 'number' && attackType > 0) ? attackType : 1;
					this._mpReplayingFx = true;
					try {
						scAny.combat.showHitEffect(mirror,
							{ x: mirror.coll.pos.x + ms.x / 2, y: mirror.coll.pos.y + ms.y / 2, z: mirror.coll.pos.z + ms.z },
							at, el,
							0 /* SHIELD_RESULT.NONE */, crit);
					} finally { this._mpReplayingFx = false; }
				}
			} catch (_) { /* spectator hit sfx is cosmetic */ }
		}
		D('emit', 'dmg=' + finalDamage, 'perfect=' + (perfect ? 1 : 0), 'regular=' + (regular ? 1 : 0), 'for=' + mirror.name,
			// ROUND 47 (diag): prove WHO the host enemy was actually aimed at when its
			// hit connected on this member's mirror. tgtA should be the victim's own
			// name; a DIFFERENT name means the host enemy hit the member while targeted
			// elsewhere — the desync the retarget fix addresses.
			'tgtA=' + (attacker && attacker.target && attacker.target.name ? attacker.target.name : (attacker && attacker.target ? '__host__' : 'none')));
		this.main.connection.combatHit({
			player: mirror.name,
			damage: finalDamage,
			element: el,
			critical: crit,
			ax, ay,
			attack: atk,
			attackType,
			monster: true,          // host-authoritative monster hit (Step D applies verbatim)
			perfect,                // member: perfect-guard FX + counter window, 0 damage
			regular,                // member: guard-block FX + guard-bar accumulation
			knockback: !perfect && !regular, // member: knock the player away from the hit
			// ROUND 78: guard-bar drain (engine's ratio^1.5 value, NOT the HP chip) and
			// the full unguarded hit for the bar-break case (see the regular branch).
			shieldDmg, full: fullForBreak,
		});
	}

	/** ROUND 32 (item 3a): run the victim enemy's GUARD_COUNTER reaction when the host
	 * judges a member's guard PERFECT. The mirror's inactive shield means the engine
	 * never ran Enemy.onTargetHit's reaction loop for this hit, so do it here with the
	 * exact engine gate: any enabled enemyType.reactions[i] with type 'GUARD_COUNTER'
	 * whose onGuardCounterCheck(attacker) passes -> onGuardCountered(enemy, attacker).
	 * That call switches state + plays hit-counter-echo + fires doDramaticEffect
	 * (GUARD_COUNTER), which the doDramaticEffect wrap relays to the instance. Every
	 * step is guarded; a non-counterable enemy simply has no matching reaction and is
	 * skipped, and a missing enemyType/reaction API is swallowed. */
	private triggerGuardCounter(attacker: any, mirror: any): void {
		try {
			const root: any = attacker && attacker.getCombatantRoot ? (attacker.getCombatantRoot() || attacker) : attacker;
			if (!root || root._killed || root._mpPuppet || root._mpMirror) return;
			const et: any = root.enemyType;
			if (!et || !et.reactions) return;
			// ROUND 34 (item 4): the enabled-reaction list lives on the ENEMY INSTANCE
			// (root.reactions.enabled — engine ~2572727), NOT on enemyType.reactions (a
			// name->reaction map, engine ~2551695). The old code read et.reactions.enabled
			// (always undefined) and guarded on root.onGuardCountered (a method that exists
			// only on the REACTION object, never on the Enemy), so it early-returned on
			// every counterable hit and NO counter ever fired. Mirror the native
			// Enemy.onTargetHit loop (engine ~2579056): for each enabled reaction of type
			// GUARD_COUNTER, run onGuardCounterCheck.call(reaction, enemy) then
			// onGuardCountered(enemy, attacker) with reactions.current set.
			const enabled: any = root.reactions && root.reactions.enabled;
			if (!enabled || !enabled.length) return;
			// The dramatic FX + arena score want the real local player as the counter
			// attacker (a.isPlayer gates doDramaticEffect's slow-mo/camera and the stats);
			// fall back to the mirror if the player entity isn't available.
			const realPlayer: any = (ig as any).game && (ig as any).game.playerEntity;
			const counterAttacker: any = realPlayer || mirror;
			for (let i = 0; i < enabled.length; i++) {
				const name: any = enabled[i];
				const r: any = et.reactions && et.reactions[name];
				if (!r || r.type !== 'GUARD_COUNTER') continue;
				const checker: any = r.onGuardCounterCheck;
				let ok = true;
				if (typeof checker === 'function') {
					// Native binds this=reaction, arg=the ENEMY (its conditions check the
					// enemy, not the attacker). The old code called checker.call(root, mirror)
					// — wrong this AND wrong arg.
					try { ok = checker.call(r, root); } catch (_) { ok = false; }
				}
				if (ok) {
					try { root.reactions.current = name; } catch (_) { /* ignore */ }
					if (typeof r.onGuardCountered === 'function') {
						try { r.onGuardCountered(root, counterAttacker); } catch (_) { /* ignore */ }
					}
					break;
				}
			}
		} catch (_) { /* a failed counter must never break the hit */ }
	}

	/** ROUND 35 (item 3): the showHitEffect wrapper's handler — see the wrap comment at the
	 * inject site for the full design. Decides, for every engine showHitEffect call, whether
	 * to (a) drop the NATIVE sound (member-mirror husk plain hit -> the double-audio fix),
	 * (b) relay the guard sound to the rest of the instance (host/member perfect+regular
	 * guard so teammates hear it), and/or (c) run the native call. Always returns the native
	 * result so the engine's FX/number pipeline is undisturbed. `self` is the sc.combat
	 * `this` from the wrapper. */
	/** ROUND 43 (enemy-hurt sound for teammates): re-run the engine's own showHitEffect
	 * on a shared enemy's PUPPET at the attack's real attackType/element/critical. This
	 * reproduces BOTH the element-connect sound and the material hit-receive natively on
	 * every client — incl. during 霸体 (superarmor: sound is NOT poise-gated, only
	 * knockback/stun is). Called (a) by the MEMBER who landed the hit on their own puppet
	 * (they suppressed the native call via _mpSilentHitFx so only the HP/damage-number
	 * showed) and (b) on the HOST inside recomputeHostMonsterHit when it applies a member's
	 * forwarded hit to the real enemy (applyEnemyDamage strips the FX to avoid doubles).
	 * Runs under _mpReplayingFx so the showHitEffect relay observers never re-emit. */
	/** ROUND 46 (Gap A/B root fix): the engine's showHitEffect plays its hit sounds via a
	 * NON-positional ig.Sound.play() and returns a handle whose asset path is UNREADABLE in
	 * 1.4.2 (webAudioBuffer/multiAudio/_buffer/_clip all come back empty), so the old
	 * read-path-off-the-handle relay always saw path=? and emitted nothing. Worse, replaying
	 * showHitEffect on a puppet/mirror is inaudible because those hit sounds live in SHARED
	 * groups (hitLight/hitMedium/hitMatLight/...) whose SoundManager policy is
	 * nearest-to-camera-wins + a 33ms retrigger throttle — the replayed request is silently
	 * discarded. The PROVEN-audible path (guard sounds, hedgehog sounds) is: relay a concrete
	 * .ogg path -> the receiver rebuilds `new ig.Sound(path)` (a UNIQUE per-path group) and
	 * plays it via ig.SoundHelper.playAtEntity. These two helpers replicate the engine's own
	 * e/g sound-table lookup (game.compiled.js:4808-4823) to DERIVE that concrete path from
	 * (attackType, element, victim material) — no protocol change (path is already whitelisted).
	 * Engine fallback semantics preserved: element table falls back NEUTRAL then MASSIVE;
	 * material table falls back METAL then MEDIUM; a random variant is picked from the group. */
	private _mpHitSoundPaths(kind: 'element' | 'material', attackType: number, element: number, material: any): string[] {
		const P = 'media/sound/battle/airon/';
		// seq(base, suffixes): suffix '' -> '<base><n>.ogg' (ball-hit-light1), '-i' -> '<base>-i<n>.ogg'
		// (hit-metal-light-2), '-deep-i' -> '<base>-deep-i<n>.ogg' (hit-organic-deep-1).
		const seq = (base: string, suffixes: string[]): string[] => suffixes.map((sf) => P + base + sf + '.ogg');
		const pick4 = (base: string, lv: string): string[] => seq(base, ['-' + lv + '1', '-' + lv + '2', '-' + lv + '3', '-' + lv + '4']);
		const range = (base: string, lv: string, a: number, b: number): string[] => {
			const sfx: string[] = [];
			for (let n = a; n <= b; n++) sfx.push('-' + lv + '-' + n);
			return seq(base, sfx);
		};
		if (kind === 'element') {
			const EL_TABLE: { [el: number]: { [at: number]: string[] } } = {
				0: { 1: pick4('ball-hit', 'light'), 2: pick4('ball-hit', 'medium'), 3: pick4('ball-hit', 'hard'), 4: [P + 'ball-hit-hard3.ogg', P + 'ball-hit-hard4.ogg'] },
				1: { 1: pick4('fire-hit', 'light'), 2: pick4('fire-hit', 'medium'), 3: pick4('fire-hit', 'hard'), 4: [P + 'fire-hit-hard3.ogg', P + 'fire-hit-hard4.ogg'] },
				2: { 1: pick4('cold/ball-hit-cold', 'light'), 2: pick4('cold/ball-hit-cold', 'medium'), 3: pick4('cold/ball-hit-cold', 'hard'), 4: [P + 'cold/ball-hit-cold-hard3.ogg', P + 'cold/ball-hit-cold-hard4.ogg'] },
				3: { 1: pick4('shock/hit-shock', 'light'), 2: pick4('shock/hit-shock', 'medium'), 3: pick4('shock/hit-shock', 'hard'), 4: [P + 'shock/hit-shock-hard3.ogg', P + 'shock/hit-shock-hard4.ogg'] },
				4: { 1: pick4('wave/hit-wave', 'light'), 2: pick4('wave/hit-wave', 'medium'), 3: pick4('wave/hit-wave', 'hard'), 4: [P + 'wave/hit-wave-hard3.ogg', P + 'wave/hit-wave-hard4.ogg'] },
			};
			const byEl = EL_TABLE[(typeof element === 'number' && EL_TABLE[element]) ? element : 0];
			return byEl[attackType] || byEl[4];
		}
		const MAT_TABLE: { [m: number]: { [at: number]: string[] } } = {
			1: { 1: range('hit-metal', 'light', 2, 3), 2: range('hit-metal', 'medium', 1, 4) },
			2: { 1: seq('hit-organic', ['-1', '-2', '-3']), 2: seq('hit-organic', ['-deep-1', '-deep-2', '-deep-3']) },
		};
		const mKey = (material === 2) ? 2 : 1;
		const byMat = MAT_TABLE[mKey];
		return byMat[attackType] || byMat[2];
	}

	private _mpPickHitSound(kind: 'element' | 'material', attackType: number, element: number, material: any): string {
		try {
			const list = this._mpHitSoundPaths(kind, attackType, element, material);
			if (!list || !list.length) return '';
			return list[Math.floor(Math.random() * list.length)] || '';
		} catch (_) { return ''; }
	}

	private playEnemyPuppetHitFx(entity: any, attackType: number, element: number, critical: boolean): void {
		try {
			if (!entity || entity._killed || !entity.coll) return;
			const scAny: any = sc as any;
			if (!scAny.combat || typeof scAny.combat.showHitEffect !== 'function') return;
			const at: number = (typeof attackType === 'number' && attackType > 0) ? attackType : 1;
			const el: number = (typeof element === 'number' && element >= 0) ? element : 0;
			const ms = entity.coll.size || { x: 0, y: 0, z: 0 };
			this._mpReplayingFx = true;
			try {
				// ROUND 46: run showHitEffect with its sound SUPPRESSED (7th arg k=true) — its sound
				// lives in shared groups that silently discard a replayed request (nearest-to-camera
				// wins + 33ms throttle), so the native sound was inaudible. We keep it ONLY for the
				// visual hit sprite / damage number, then play BOTH derived hit sounds positionally
				// via playAtEntity as fresh per-path Sounds (unique group, cannot be discarded) — the
				// proven-audible mechanism. showHitEffect runs under _mpReplayingFx so its silent
				// call + these plays never re-emit through the relay observers.
				scAny.combat.showHitEffect(entity,
					{ x: entity.coll.pos.x + ms.x / 2, y: entity.coll.pos.y + ms.y / 2, z: entity.coll.pos.z + ms.z },
					at, el, 0 /* SHIELD_RESULT.NONE */, critical === true, true /* noSound */);
				const igAny: any = ig as any;
				if (igAny.Sound && igAny.SoundHelper && typeof igAny.SoundHelper.playAtEntity === 'function') {
					const elPath = this._mpPickHitSound('element', at, el, undefined);
					const matPath = this._mpPickHitSound('material', at, 0, entity.material);
					if (elPath) igAny.SoundHelper.playAtEntity(new igAny.Sound(elPath, 1, 0.1), entity, false, {}, undefined, undefined);
					if (matPath) igAny.SoundHelper.playAtEntity(new igAny.Sound(matPath, 1, 0.1), entity, false, {}, undefined, undefined);
				}
			} finally { this._mpReplayingFx = false; }
		} catch (_) { /* the hurt FX is cosmetic — never break the frame */ }
	}

	/**
	 * ROUND 44 (Fix A) — SPECTATOR side (a non-host client that did NOT land the hit).
	 * A teammate's forwarded `enemyDamage` packet now carries attackElement+critical, so we
	 * replay the enemy's hurt sound/FX directly on OUR local puppet for that uid. This is
	 * the robust path that v1.43.0 lacked: it does NOT depend on the host's native
	 * showHitEffect emitting a readable sound handle, nor on any of the onShowHitEffect
	 * relay gates (host/_mpReplayingFx/uid/instanceof), nor on applyEnemySound finding a
	 * live puppet. The attacker itself never receives this packet (server self-drop), and
	 * the attacker already replayed its own FX via the onPreDamageModification hook — so
	 * exactly one replay per genuine spectator, no doubles. During 霸体 the sound still
	 * plays (showHitEffect's sound is NOT poise-gated).
	 */
	private replayEnemyHurtFxForSpectator(hit: { uid: number, damage: number, attacker: string, type?: number, attackElement?: number, critical?: boolean, shield?: number, weak?: boolean, off?: number, def?: number }): void {
		try {
			if (!hit) return;
			// We didn't land this hit (the server excludes the sender), but guard anyway so
			// we never double-play on the off chance a packet loops back to its attacker.
			if (hit.attacker && hit.attacker === this.main.name) return;
			const uid = hit.uid;
			if (!uid) return;
			const puppet = this.puppets && this.puppets[uid];
			if (!puppet || puppet._killed) { this._sfxLog('rhfx.nopuppet', 'uid=' + uid); return; }
			const aType: number = (typeof hit.type === 'number' && hit.type > 0) ? hit.type : 1;
			const aEl: number = (typeof hit.attackElement === 'number' && hit.attackElement >= 0) ? hit.attackElement : 0;
			this._sfxLog('rhfx.replay', 'uid=' + uid + ' t=' + aType + ' el=' + aEl + ' crit=' + (hit.critical === true));
			this.playEnemyPuppetHitFx(puppet, aType, aEl, hit.critical === true);
			// ROUND 72 (teammate number visibility): the FX replay alone left every
			// teammate hit NUMBERLESS for members — only the host (native chain) and the
			// attacker (local chain) ever saw a number. Pop the attacker's exact result
			// on our puppet: damage + crit + shield/weakness/size factors all ride the
			// packet (the ROUND 72 style block). The mirrored-ball phantom number is
			// cancelled by ROUND 67's ignoreHit, so this is the ONLY number — no double.
			if (typeof hit.damage === 'number' && hit.damage > 0) {
				this.spawnHitNumberOn(puppet, Math.round(hit.damage), hit.critical === true,
					(typeof hit.shield === 'number' && hit.shield > 0) ? hit.shield : undefined,
					{ off: hit.off, def: hit.def, weak: hit.weak === true });
			}
		} catch (_) { /* cosmetic — never break the frame */ }
	}

	/** ROUND 45 (Gap A) — enemyHurt relay receiver (host → members). A member lands a hit;
	 * the host applies it to the real enemy (native chain plays it for the host) and relays
	 * this packet. Each spectator replays the enemy's hurt sound/FX on its own puppet. Thin
	 * wrapper over playEnemyPuppetHitFx keyed by uid. ROUND 58: the host now stamps the
	 * `attacker` it received on the forwarded enemyDamage, and the server passes it through —
	 * the ATTACKING member also receives this broadcast (it is not the host, so it isn't
	 * self-dropped), so we must skip it or they would hear their own local playEnemyPuppetHitFx
	 * AND this relay at once (the double hurt sound). */
	private replayEnemyHurtFx(hit: { uid: number, type?: number, attackElement?: number, critical?: boolean, attacker?: string, damage?: number, shield?: number, weak?: boolean, off?: number, def?: number }): void {
		try {
			if (!hit || !hit.uid) return;
			if (hit.attacker && hit.attacker === this.main.name) return;
			const puppet = this.puppets && this.puppets[hit.uid];
			if (!puppet || puppet._killed) { this._sfxLog('reh.nopuppet', 'uid=' + hit.uid); return; }
			const aType: number = (typeof hit.type === 'number' && hit.type > 0) ? hit.type : 1;
			const aEl: number = (typeof hit.attackElement === 'number' && hit.attackElement >= 0) ? hit.attackElement : 0;
			this._sfxLog('reh.replay', 'uid=' + hit.uid + ' t=' + aType + ' el=' + aEl + ' crit=' + (hit.critical === true));
			this.playEnemyPuppetHitFx(puppet, aType, aEl, hit.critical === true);
			// ROUND 72 (host-hit number sync): host-originated hits now carry the FINAL
			// styled result (damage + style block, NO attacker stamp). Pop it on our
			// puppet. Member-originated relays keep their attacker stamp and carry no
			// damage — spectators already popped that number via the enemyDamage packet
			// (replayEnemyHurtFxForSpectator), so this stays FX-only for them.
			if (!hit.attacker && typeof hit.damage === 'number' && hit.damage > 0) {
				this.spawnHitNumberOn(puppet, Math.round(hit.damage), hit.critical === true,
					(typeof hit.shield === 'number' && hit.shield > 0) ? hit.shield : undefined,
					{ off: hit.off, def: hit.def, weak: hit.weak === true });
			}
		} catch (_) { /* cosmetic — never break the frame */ }
	}

	private onShowHitEffect(origShowHit: any, self: any, target: any, pos: any, type: any, element: any, shieldResult: any, critical: any, a7: any, a8: any): any {
		// ROUND 79: raw (never-collapsed) so a capture of ONE guarded hit shows every call.
		const D = (t: string, ...a: any[]) => { try { this._sfxLogRaw('she.' + t, ...a); } catch (_) { /* ignore */ } };
		const SHIELD_NONE = 0, SHIELD_REGULAR = 1, SHIELD_PERFECT = 2;
		const isGuardResult = (shieldResult === SHIELD_REGULAR || shieldResult === SHIELD_PERFECT);
		const isPlayer = (a: any): boolean => {
			try {
				return !!(a && a.party !== undefined && a.party === (sc as any).COMBATANT_PARTY.PLAYER);
			} catch (_) { return false; }
		};
		D('fire', this._paeDescribe(null, target), 'type=' + type, 'shield=' + shieldResult, 'crit=' + (critical === true), 'silent=' + (a7 === true));
		// (2)+(3): a member's mirror husk. `none` = the engine judged the husk's plain hit
		// (forced-inactive shield) — suppress the NATIVE sound so only recompute's single
		// correct guard sound plays on the host. `guard` = the host's mirrored verdict FX.
		// ROUND 79 (guard-sound dedupe): for a GUARD result the husk FX stays VISUAL-ONLY —
		// silent native call, NO relay. The guarding member's own client is the single sound
		// authority: applyCombatHit plays the hit-block/counter-echo natively and its
		// showHitEffect wrap relays ONE playerSound stamped with the member's name, which the
		// host + every spectator replay positionally at the member's mirror. The old behavior
		// stacked hit-block TWICE on the host (husk-native + the member's relay) and sent a
		// duplicate pair to any 3rd spectator (host's husk relay + member's relay) — the exact
		// "two guard sounds" report.
		if (target && target._mpMirror) {
			if (shieldResult === SHIELD_NONE) return undefined;
			if (isGuardResult) {
				// true = the engine's noSound flag: spawn the guard spark on the husk, skip the sound.
				return origShowHit.call(self, target, pos, type, element, shieldResult, critical, true, a8);
			}
			return origShowHit.call(self, target, pos, type, element, shieldResult, critical, a7, a8);
		}
		// (1): the LOCAL player's own guard (host or member). Native plays the sound for us;
		// relay it (stamped with our name) so the rest of the instance hears it positionally
		// at our mirror. The mirror-husk branch above is now silent + relay-free, so this
		// single relay is the ONLY guard-sound source for a guarding player's event.
		if (!this._mpReplayingFx && isGuardResult && isPlayer(target)) {
			try { this.emitPlayerGuardSound(null, shieldResult, element); } catch (_) { /* ignore */ }
		}
		const native = origShowHit.call(self, target, pos, type, element, shieldResult, critical, a7, a8);
		// ROUND 46 (Gap A/B): relay the hit sounds as CONCRETE derived paths. The engine's
		// showHitEffect plays these via a NON-positional ig.Sound.play() whose returned handle
		// exposes NO readable asset path in 1.4.2 (the old read-path-off-the-handle relay always
		// saw path=?), and replaying showHitEffect on a puppet/mirror is inaudible (shared sound
		// groups discard the replayed request). So we replicate the engine's e/g sound-table
		// lookup to derive the exact .ogg path(s) and relay THOSE on the enemySound / playerSound
		// channels; each receiver rebuilds `new ig.Sound(path)` (a unique per-path group that
		// cannot be discarded) and plays it positionally via playAtEntity — the same mechanism
		// that already makes guard sounds + hedgehog sounds audible. No protocol change: `path`
		// is already whitelisted on both channels.
		//   Gap A (host attacked a real synced Enemy): both the element-connect AND the
		//     material hit-receive sounds -> enemySound, replayed on each member's puppet.
		try {
			const silent = a7 === true;
			if (!silent && native && this.main.host && !this._mpReplayingFx && target
				&& !target._mpMirror && !target._mpPuppet && typeof target.uid === 'number' && target.uid > 0) {
				const Enemy = (ig.ENTITY as any).Enemy;
				if (Enemy && target instanceof Enemy) {
					const conn = this.main.connection;
					if (conn && conn.isOpen() && typeof conn.emitEnemySound === 'function') {
						const tN: number = (typeof type === 'number' && type > 0) ? type : 2;
						const eN: number = (typeof element === 'number' && element >= 0) ? element : 0;
						const elPath = this._mpPickHitSound('element', tN, eN, undefined);
						const matPath = this._mpPickHitSound('material', tN, 0, target.material);
						D('hitrelay', 'el=' + (elPath || '?'), 'mat=' + (matPath || '?'), this._paeDescribe(null, target));
						if (elPath) conn.emitEnemySound({ uid: target.uid, path: elPath, volume: 1, variance: 0.1, loop: false, global: false });
						if (matPath) conn.emitEnemySound({ uid: target.uid, path: matPath, volume: 1, variance: 0.1, loop: false, global: false });
					}
				}
			} else {
				// Diagnose exactly which gate rejected the enemy-connect relay (item 2/3).
				D('nosend',
					'silent=' + (silent ? 1 : 0), 'native=' + (native ? 1 : 0), 'host=' + (this.main.host ? 1 : 0),
					'replay=' + (this._mpReplayingFx ? 1 : 0),
					'target=' + (target ? 1 : 0), 'mirror=' + (target && target._mpMirror ? 1 : 0),
					'puppet=' + (target && target._mpPuppet ? 1 : 0), 'uid=' + (target && target.uid));
			}
		} catch (_) { /* the connect-sound relay is cosmetic — never break the FX */ }
		// ROUND 46 (Gap B): relay a PLAYER victim's PLAIN (unguarded) hit sounds the same way —
		// derived element-connect + material hit-receive paths on the playerSound channel, so the
		// rest of the instance hears them positionally on the victim's mirror. Replaces the old
		// read-path-off-the-handle relay that always saw path=?. Two sub-cases, one branch:
		//   - the LOCAL player got hit unguarded: server stamps our name; watchers replay on our
		//     mirror (applyPlayerSound self-drops it for the source, who heard it natively).
		//   - a REMOTE player's husk got hit (host only): the NONE that reaches here is a genuine
		//     unguarded hit (recomputeHostMonsterHit overwrites guard verdicts to isGuardResult,
		//     which the mirror branch above already relays), so send it tagged with the victim.
		// Guard results are untouched — emitPlayerGuardSound still carries those.
		try {
			const silentPlain = a7 === true;
			if (!silentPlain && native && !this._mpReplayingFx && !isGuardResult && target
				&& (isPlayer(target) || target._mpMirror)) {
				const conn = this.main.connection;
				if (conn && conn.isOpen() && typeof conn.emitPlayerSound === 'function') {
					const tN: number = (typeof type === 'number' && type > 0) ? type : 2;
					const eN: number = (typeof element === 'number' && element >= 0) ? element : 0;
					const elPath = this._mpPickHitSound('element', tN, eN, undefined);
					const matPath = this._mpPickHitSound('material', tN, 0, target.material);
					const who = (target._mpMirror && typeof target.name === 'string' && target.name) ? target.name : null;
					D('phrelay', 'el=' + (elPath || '?'), 'mat=' + (matPath || '?'), 'mirror=' + (target._mpMirror ? 1 : 0), 'who=' + (who || '<local>'));
					const tag: any = who ? { player: who } : {};
					if (elPath) conn.emitPlayerSound({ path: elPath, volume: 1, variance: 0.1, loop: false, ...tag });
					if (matPath) conn.emitPlayerSound({ path: matPath, volume: 1, variance: 0.1, loop: false, ...tag });
				}
			}
		} catch (_) { /* the plain-hit relay is cosmetic — never break the FX */ }
		return native;
	}

	/** ROUND 35 (item 3): emit the guard sound the engine is about to play locally, as a
	 * playerSound packet the rest of the instance replays on the source's mirror. `who`
	 * selects the packet's player tag: null = OUR own guard (server stamps our name; the
	 * guarding member replays nothing for themselves), a string = a remote player's mirror
	 * husk guard (spectator relay — the named member suppresses their own replay). PERFECT ->
	 * hit-counter-echo.ogg, REGULAR -> hit-block.ogg (the exact assets the engine's sound
	 * table uses). */
	private emitPlayerGuardSound(who: string | null, shieldResult: any, element: any): void {
		const conn = this.main.connection;
		if (!conn || !conn.isOpen() || typeof conn.emitPlayerSound !== 'function') return;
		const SHIELD_PERFECT = 2;
		const path = (shieldResult === SHIELD_PERFECT)
			? 'media/sound/battle/hit-counter-echo.ogg'
			: 'media/sound/battle/hit-block.ogg';
		conn.emitPlayerSound({ path, volume: 1, variance: 0, loop: false, ...(who ? { player: who } : {}) });
	}

	/**
	 * MEMBER side: our hit on a puppet already applied locally (HP drop + damage
	 * number, bot-like feedback). Forward the SAME amount to the host so the
	 * authoritative real enemy loses the HP too — shared HP bars. Forward every
	 * hit (no rate limit; tiny packets on a LAN) so locally-shown damage always
	 * matches what the host applies.
	 */
	public forwardEnemyDamage(entity: any, damage: number, attackInfo?: any,
		style?: { critical?: boolean, shield?: number, weak?: boolean, off?: number, def?: number }): void {
		if (this.main.host) return;                  // only members forward
		const uid = entity && entity._mpUid;
		if (!uid || typeof damage !== 'number' || damage <= 0) return;
		// ROUND 32 (item 3c): forward the REAL attack's interrupt/knockback strength.
		// The old packet carried only {uid,damage,attacker} and the host fabricated a
		// fixed MEDIUM AttackInfo — so every member hit (even an uncharged ball)
		// interrupted any windup and knocked back like a melee hit. Derive the real
		// attack-type number (sc.ATTACK_TYPE: NONE:0 LIGHT:1 MEDIUM:2 HEAVY:3 MASSIVE:4
		// BREAK:5), whether it's a charged ball (adds the KNOCKBACK modifier), and the
		// KNOCKBACK modifier value; the host rebuilds the genuine reaction from these.
		let type = 2; // default MEDIUM (a plain melee hit)
		let isBall = false; let charged = false; let knockback = 0;
		try {
			const c: any = attackInfo;
			if (c) {
				isBall = !!c.isBall || !!c.ballDamage;
				if (typeof c.type === 'number') type = c.type;
				else if (typeof c.type === 'string' && (sc as any).ATTACK_TYPE) {
					const n = (sc as any).ATTACK_TYPE[c.type];
					if (typeof n === 'number') type = n;
				}
				// A melee swing whose type reads NONE(0) must still interrupt like a melee
				// hit — treat falsy/0 non-ball attacks as MEDIUM (the native melee baseline).
				if (!isBall && !(type > 0)) type = 2;
				// An uncharged ball is the WEAK case (LIGHT) — never interrupt-level.
				if (isBall && !(type > 0)) type = 1;
				if (isBall && typeof c.hasHint === 'function' && c.hasHint('CHARGED')) charged = true;
				if (charged && c.attackerParams && typeof c.attackerParams.getModifier === 'function') {
					const kb = c.attackerParams.getModifier('KNOCKBACK');
					if (typeof kb === 'number' && isFinite(kb)) knockback = kb;
				}
			}
		} catch (_) { /* fall back to the MEDIUM default */ }
		if (!(type >= 0 && type <= 5)) type = 2;
		// ROUND 43 (enemy-hurt sound): also forward the attack's ELEMENT so the host's
		// spectator showHitEffect replay + the native forced-damage FX pick the right connect
		// sound. attackInfo.element is the engine field (0=neutral..4=wave); fall back to 0.
		let attackElement = 0;
		// ROUND 44 (Fix A): also forward whether the hit was CRITICAL so every spectator
		// replays the matching (louder/sharper) hurt FX on its own puppet, not a watered-down
		// neutral one. attackInfo.critical is the engine flag; fall back to false.
		// ROUND 72: prefer the style block — it carries the damageResult's ROLLED crit
		// (attackInfo.critical is only the rare forced-crit flag and misses natural rolls),
		// plus the shield result / weakness / size factors for the spectator number.
		let critical = false;
		let shield = 0; let weak = false; let off = 1; let def = 1;
		try {
			const c2: any = attackInfo;
			if (c2 && typeof c2.element === 'number' && isFinite(c2.element) && c2.element >= 0 && c2.element <= 4) attackElement = Math.round(c2.element);
			if (c2 && c2.critical === true) critical = true;
		} catch (_) { /* neutral default */ }
		try {
			if (style) {
				if (style.critical === true) critical = true;
				if (typeof style.shield === 'number' && style.shield >= 0 && style.shield <= 3) shield = Math.round(style.shield);
				if (style.weak === true) weak = true;
				if (typeof style.off === 'number' && isFinite(style.off) && style.off > 0 && style.off <= 10) off = style.off;
				if (typeof style.def === 'number' && isFinite(style.def) && style.def > 0 && style.def <= 10) def = style.def;
			}
		} catch (_) { /* defaults */ }
		this.main.connection.enemyDamage({
			uid, damage, attacker: this.main.name,
			type, ball: isBall, charged, knockback, attackElement, critical,
			shield, weak, off, def,
		});
		// Instant local aggro: don't wait the ~66ms for the host's tg=1 block — the hit
		// itself guarantees the host will aggro this enemy (applyEnemyDamage sets the
		// target there). Setting the target NOW makes the HP bar flip red at hit time,
		// and _mpTg=true arms the target lock so the local AI can't drop it again before
		// the block arrives. If the host disagrees (enemy already dead etc.), the very
		// next block or reap pass corrects us.
		try {
			const pl: any = ig.game.playerEntity;
			if (pl && entity.setTarget && !entity._killed) {
				entity._mpTg = true;
				// ROUND 30 (item 2): pin the puppet's OWN target-lose timer open too —
				// the local puppet AI runs the same loseDistance/loseTime drop (the
				// _mpTargetGuarded lock in ensurePuppet only refuses setTarget(null);
				// the vanilla updateTarget can still zero the timer), which read the
				// member's HP bar as un-engaged between member hits. Mirrors the
				// host-side pin in applyEnemyDamage.
				try { entity.targetLoseTimer = 0; } catch (_) { /* ignore */ }
				if (!entity.target) entity.setTarget(pl);
				// ROUND 31 (item 5): mark the puppet ENGAGED locally so a LATER hit re-pins
				// it even if the engine's lose-check dropped the target (de-aggro'd / offscreen
				// case). The block-apply re-pin keys off this flag (same role the host's
				// _mpEngaged plays in updateTarget). Without it, an enemy that dropped its
				// target between hits could never be re-engaged — the member hit it but it
				// never fought back and the HP bar read un-engaged.
				try { entity._mpEngaged = { name: this.main.name }; } catch (_) { /* ignore */ }
			}
		} catch (_) { /* ignore */ }
	}

	/** MEMBER side: remember a puppet kill so the host block doesn't instantly
	 * respawn it while the host catches up (kill -> pop-back flicker guard). */
	public noteMemberKill(uid: number): void {
		if (uid) this.memberKills[uid] = Date.now();
	}

	/** Fix 2: immediate flinch on a member-side puppet hit. The puppet is
	 * lockEntity-locked, so the engine's native damage-flinch setCurrentAnim (a raw
	 * string) is dropped by the lock — the hit showed only HP loss. Write the flinch
	 * through the lock and pin the lastAnim cache so the block-apply only re-issues
	 * the host's live anim on change. No knockback here: the host block's position
	 * conveys the knocked-back position, and a local knockback would fight
	 * interpolatePuppets. No-op for anything without a sync uid (local ghosts play
	 * their native flinch). */
	private syncPuppetHitFlinch(e: any): void {
		try {
			if (!e || e._killed || e._mpDying) return;
			const uid = e._mpUid || 0;
			const da = (e.walkAnims && e.walkAnims.damage) || '';
			if (!uid || !da) return;
			this.lastAnim[uid] = da; // stop the block-apply re-issuing its live anim over the flinch
			e.currentAnim = { protected: da };
			this.playAnim(e, da);
		} catch (_) { /* flinch is cosmetic — never break the hit */ }
	}

	/** ROUND 33 (item 3): decide whether a member's hit should play the enemy's damage
	 * flinch (硬直). Vanilla only staggers for an attack whose ATTACK_TYPE level beats the
	 * enemy's poise (hitStable) — a weak UNCHARGED ball (LIGHT) has no hitstun, so it must
	 * NOT flinch. Mirror the host's interrupt gate in applyEnemyDamage: recover the real
	 * attack-type number (sc.ATTACK_TYPE 0..5) from the AttackInfo exactly like
	 * forwardEnemyDamage does, then flinch only when typeNum > hitStable. Default-safe: any
	 * missing/undeterminable info falls back to the old behaviour (flinch) EXCEPT an
	 * identified weak uncharged ball (LIGHT), which never flinches. */
	private shouldFlinchForHit(e: any, attackInfo?: any): boolean {
		try {
			if (!e) return false;
			const stable = (typeof e.hitStable === 'number' && isFinite(e.hitStable)) ? e.hitStable : 0;
			let type = 2; // default MEDIUM (a plain melee hit)
			let isBall = false;
			const c: any = attackInfo;
			if (c) {
				isBall = !!c.isBall || !!c.ballDamage;
				if (typeof c.type === 'number') type = c.type;
				else if (typeof c.type === 'string' && (sc as any).ATTACK_TYPE) {
					const n = (sc as any).ATTACK_TYPE[c.type];
					if (typeof n === 'number') type = n;
				}
				if (!isBall && !(type > 0)) type = 2; // melee swing that reads NONE still hits like melee
				if (isBall && !(type > 0)) type = 1;  // uncharged ball is the WEAK case (LIGHT)
			}
			if (!(type >= 0 && type <= 5)) type = 2;
			// A charged ball bumps the interrupt level — a KNOCKBACK hint means it staggers.
			if (isBall && c && typeof c.hasHint === 'function' && c.hasHint('CHARGED')) return true;
			return type > stable;
		} catch (_) { return true; /* fail-open toward the old flinch behaviour */ }
	}

	/** Round 14 (fix 5): member-side kill with visible death FX. Members kill puppets
	 * with kill(true) (silent — verified it never triggers loot/orbs/EXP), so the
	 * host-only death visuals never played on the member's screen. Stage a delayed
	 * death instead: NOW the flinch anim (the anim literally named "damage", engine
	 * guards it too) + pre_die blink; then the death queue delivers the boom (220ms)
	 * and the silent kill 280ms after that (fix 1 two-stage; ≈500ms total, round 16).
	 * EffectSheet methods are null-safe no-ops when unloaded. The entity is flagged
	 * _mpDying so the injected Enemy.update freezes its AI and the reap/block-apply
	 * passes leave it to the queue. */
	private playPuppetDeath(e: any, doLootMirror: boolean): void {
		if (!e || e._killed || e._mpDying) return;
		e._mpDying = true; // freeze AI + shield from block-apply/reap
		// Round 16 (issue 7): the dying corpse must stop body-blocking the player —
		// the engine's own death flow (_onDeathHit) sets coll.type to IGNORE; do the
		// same here so the puppet's corpse is walk-through during its ~500ms FX window.
		// ROUND 80: setType keeps the spatial hash consistent on the corpse's
		// collision flip to IGNORE.
		try {
			if (typeof (e as any).coll.setType === 'function') (e as any).coll.setType((ig as any).COLLTYPE.IGNORE);
			else (e as any).coll.type = (ig as any).COLLTYPE.IGNORE;
		} catch (_) { /* ignore */ }
		const uid = e._mpUid || 0;
		const dieAnim = (e.walkAnims && e.walkAnims.damage) || '';
		if (dieAnim) {
			if (uid) this.lastAnim[uid] = dieAnim; // stop host block re-issuing its live anim
			// Fix 1: write the death flinch through the lock BEFORE playAnim — on a locked
			// mirror/puppet the raw-string setCurrentAnim from SHOW_ANIMATION is dropped by
			// the lock, so without this the death flinch never shows (mirrors the working
			// { protected: ... } write in the block-apply path).
			try { e.currentAnim = { protected: dieAnim }; } catch (_) { /* ignore */ }
			try { this.playAnim(e, dieAnim); } catch (_) { /* ignore */ }
		}
		// Fix 1: the pre_die blink goes through the load-guarded helper — the "combatant"
		// death sheet may not be resident yet for a just-adopted puppet (EffectSheet
		// methods no-op on an unloaded sheet).
		this.spawnDeathSheetFx(e, 'pre_die');
		this._mpDeathQueue.push({ e: e, at: Date.now(), doLootMirror: doLootMirror });
	}

	/** Round 14 (fix 5): advance the delayed-death queue. Two-stage (fix 1): after
	 * 220ms a staged puppet plays the death boom (attached to the corpse, which stays
	 * _mpDying-visible through the FX window); once 280ms have elapsed since the boom
	 * it is removed with kill(true) (silent — no loot/EXP/FX of its own; those are
	 * mirrored by the host's real kill already). Total ≈500ms ≈ vanilla DYING duration
	 * (round 16). The _mpTg lock-release runs at boom time so Combatant.onKill's
	 * setTarget(null) isn't swallowed (the puppet must leave activeCombatants for the
	 * member's combat mode to re-evaluate). */
	private processDeathQueue(): void {
		const now = Date.now();
		for (let i = this._mpDeathQueue.length; i--;) {
			const q = this._mpDeathQueue[i];
			const e = q.e;
			if (!e || e._killed) { this._mpDeathQueue.splice(i, 1); continue; }
			// Stage 1 (220ms after staging): play the death boom. Deliberately NOT killing
			// in the same tick — the boom is attached to the puppet (5th arg), and
			// kill(true) -> clearEntityAttached -> Effect.onEntityKillDetach -> stop() would
			// self-kill the effect before its first render (fix 1). Two-stage: boom now, then
			// a silent kill once 280ms have elapsed — vanilla keeps the enemy in DYING ~0.5s
			// after the boom starts, then kills.
			if (typeof e._mpBoomAt !== 'number') {
				if (now - q.at < 220) continue;
				try {
					e._mpTg = false; // let Combatant.onKill's setTarget(null) run (combat cleanup)
					if (e.coll) {
						const s = e.coll.size || { x: 0, y: 0, z: 0 };
						this.spawnDeathSheetFx(e, 'boom_medium', {
							x: e.coll.pos.x + s.x / 2,
							y: e.coll.pos.y + s.y + 1,
							z: e.coll.pos.z + s.z / 2 + s.y / 2 + 1,
						});
					}
					e._mpBoomAt = now;
				} catch (_) { /* never crash the frame */ }
				continue; // keep the entry across ticks; wait out the kill window
			}
			// Stage 2 (280ms after the boom): the corpse's FX window is over — silent kill
			// (no loot/EXP/FX of its own; those are mirrored by the host's real kill).
			if (now - e._mpBoomAt < 280) continue;
			this._mpDeathQueue.splice(i, 1);
			try {
				try { e.kill(true); } catch (_) { /* ignore */ }
				if (q.doLootMirror) {
					// MOVE of the member-side predicted-kill EXP/combat-rank mirror (was inline in
					// onPreDamageModification): a puppet kill goes straight through kill(true),
					// bypassing the whole death chain — no _onDeathHit/notifyCombatantDefeated ->
					// sc.EnemyType.resolveDefeat (no exp), no onCombatantDeathHit (no combat rank).
					// The HOST already granted both via the real damage path, so mirror them here,
					// reading the same values the old inline code read. No double-grant risk:
					// kill(true) removed the puppet, so its Combatant.update death check never
					// runs again.
					const et: any = e.enemyType;
					if (et && et.exp) {
						// Mirror EnemyType.resolveDefeat's exp-grant line (attacker irrelevant,
						// always local sc.model.player). Do NOT call resolveDefeat itself — it
						// would also grant credits/drops which the host already awarded.
						const lvl = (e.getLevel ? e.getLevel()
							: ((e.level && e.level.override) || et.level)) || 1;
						const gained = (sc as any).model.player.addExperience(
							et.exp, lvl, 0, false, (sc as any).LEVEL_CURVES.REGULAR);
						if (gained > 0) (sc as any).stats.addMap('player', 'expEnemies', gained);
					}
					if (et && et.enduranceScale != null) {
						// Mirror sc.combat.onCombatantDeathHit's rank line. increaseCombatRank is
						// gated on isCombatRankActive() which requires combat mode — nudge it.
						const gm: any = (sc as any).model;
						if (gm && gm.setCombatMode && !gm.isCombatMode()) gm.setCombatMode(true);
						gm.increaseCombatRank(1 * et.enduranceScale);
					}
				}
			} catch (_) { /* never crash the frame */ }
		}
	}

	/** Fix 1: spawn a key from a combatant's `death` EffectSheet on a locked
	 * mirror/puppet, guarding the sheet's async load (Loadable.load runs the callback
	 * immediately when already loaded; EffectSheet methods no-op on an unloaded sheet).
	 * `fixed` position spawns via spawnFixed (the death boom, target attached so it
	 * tracks/fades the corpse), otherwise spawnOnTarget (the pre_die blink). */
	private spawnDeathSheetFx(e: any, key: string, fixed?: { x: number, y: number, z: number }): void {
		try {
			const dfx = e && e.effects && e.effects.death;
			if (!dfx || (typeof dfx.spawnFixed !== 'function' && typeof dfx.spawnOnTarget !== 'function')) return;
			const doSpawn = () => {
				try {
					if (e._killed || !e.effects || !e.effects.death) return;
					if (fixed && typeof e.effects.death.spawnFixed === 'function') {
						e.effects.death.spawnFixed(key, fixed.x, fixed.y, fixed.z, e);
					} else if (typeof e.effects.death.spawnOnTarget === 'function') {
						e.effects.death.spawnOnTarget(key, e, { duration: -1 });
					}
				} catch (_) { /* FX must never break sync */ }
			};
			if (dfx.loaded) { doSpawn(); return; }
			if (typeof dfx.load === 'function') dfx.load(doSpawn);
			else doSpawn();
		} catch (_) { /* ignore */ }
	}

	/**
	 * HOST side: a member dealt damage to OUR real enemy (uid). Apply it, and make
	 * the whole fight shared: enter combat mode and set the enemy's target to the
	 * attacker's mirror so it turns and fights them (mirrors are valid targets —
	 * setTarget is party-agnostic and the attack/damage pipeline then forwards hits
	 * back to the member via combatHit). This is "member attacks -> host enters
	 * combat -> monsters attack member" in one packet.
	 */
	private applyEnemyDamage(hit: { uid: number, damage: number, attacker: string, type?: number, ball?: boolean, charged?: boolean, knockback?: number, attackElement?: number, critical?: boolean, shield?: number, weak?: boolean, off?: number, def?: number }): void {
		if (!this.main.host) return;                 // only the host owns real enemies
		try {
			const list = ig.game.entities;
			const Enemy = (ig.ENTITY as any).Enemy;
			let target: any = null;
			for (let i = 0; i < list.length; i++) {
				const e: any = list[i];
				if (e instanceof Enemy && !e._mpMirror && !e._killed && e.uid === hit.uid) { target = e; break; }
			}
			if (!target || !target.params) return;
			const dmg = Math.max(1, Math.round(hit.damage));
			// ROUND 60 (diagnostics): the incoming member→enemy packet （地鼠 report — a member's
			// ranged hit lands for 0~1 on the host). Log the raw forwarded damage + attack meta,
			// the resolved mirror, and the REAL enemy's shield / defense / hp at receipt. Pair with
			// the member's fed.out (local damage) to see what the wire carried, and with aed.res
			// (post-chain) to see what the host's engine chain actually applied.
			try {
				const pl0: any = this.main.players[hit.attacker];
				const mir0: any = pl0 && pl0.entity;
				const p0: any = target.params;
				const sh0: any = target.shield;
				this._sfxLog('aed.in', 'uid=' + hit.uid, 'raw=' + hit.damage, 'dmg=' + dmg, 'atk=' + hit.attacker,
					'mirror=' + ((mir0 && !mir0._killed) ? 1 : 0),
					't=' + ((typeof hit.type === 'number') ? hit.type : -1), 'ball=' + (hit.ball === true ? 1 : 0),
					'chg=' + (hit.charged === true ? 1 : 0), 'crit=' + (hit.critical === true ? 1 : 0),
					'sh=' + ((sh0 && typeof sh0.name === 'string') ? sh0.name : (sh0 ? 'obj' : 0)),
					'def=' + ((p0 && typeof p0.getStat === 'function') ? Math.round((p0.getStat('defense') || 0)) : -1),
					'hp=' + ((p0 && typeof p0.currentHp === 'number') ? Math.round(p0.currentHp) : -1));
			} catch (_) { /* never break the apply path */ }
			// ROUND 32 (item 3c): recover the REAL attack's interrupt/knockback strength.
			// The member forwards sc.ATTACK_TYPE (0..5) + isBall/charged/knockback. Map back
			// to the engine's type-key string + fly level. Native rule (game.compiled.js
			// ~3134456): an UNCHARGED ball is LIGHT (weak knockback), a melee OR charged ball
			// is MEDIUM+. Charged balls ALSO carry a KNOCKBACK attackerParams modifier that
			// bumps the fly level (game.compiled.js ~2497790).
			const TYPE_KEY = ['NONE', 'LIGHT', 'MEDIUM', 'HEAVY', 'MASSIVE', 'BREAK'];
			let typeNum = (typeof hit.type === 'number' && isFinite(hit.type)) ? Math.round(hit.type) : 2;
			if (typeNum < 0) typeNum = 0; else if (typeNum > 5) typeNum = 5;
			const isBall = hit.ball === true;
			// ROUND 43 (enemy-hurt sound): the attacker's element rides along so the native
			// onDamage FX + the spectator showHitEffect replay pick the right connect sound.
			const atkEl: number = (typeof hit.attackElement === 'number' && isFinite(hit.attackElement)
				&& hit.attackElement >= 0 && hit.attackElement <= 4) ? Math.round(hit.attackElement) : 0;
			let flyStr = TYPE_KEY[typeNum] || 'MEDIUM';
			if (flyStr === 'BREAK') flyStr = 'MASSIVE';            // BREAK flies at MASSIVE level
			if (flyStr === 'NONE') flyStr = 'LIGHT';               // never zero-knockback a real hit
			if (isBall && hit.charged === true && typeof hit.knockback === 'number' && hit.knockback > 0) {
				// bump the fly level by the charged-ball KNOCKBACK modifier
				const ORDER = ['NONE', 'LIGHT', 'MEDIUM', 'HEAVY', 'MASSIVE'];
				let idx = ORDER.indexOf(flyStr); if (idx < 1) idx = 2;
				idx += Math.round(hit.knockback); if (idx > 4) idx = 4;
				flyStr = ORDER[idx];
			}
			// Shared combat state: the host enters combat the moment a member does.
			try {
				if ((sc as any).model && (sc as any).model.setCombatMode) (sc as any).model.setCombatMode(true);
			} catch (_) { /* ignore */ }
			// The enemy turns on the member's mirror (aggroring it like a real party
			// member) BEFORE the damage lands, so the engine's aggro guards inside
			// damage() pass and the monster visibly reacts to its new attacker.
			// Round 19 (Part 4): a cutscene-bound member must NOT pull aggro — they're
			// mid-story and can't defend. The forwarded damage still lands, but the
			// enemy stays un-targeted (no hostile turn toward the faded mirror).
			const pl = this.main.players[hit.attacker];
			const mirror = pl && pl.entity;
			if (mirror && !mirror._killed && target.setTarget && !target.params.isDefeated()
				&& !(pl && (pl as any)._mpCutscene)) {
				// ROUND 39 (item 4): don't pin the enemy to a mirror in a DIFFERENT nav-block.
				// The pin below (targetLoseTimer=0 + setTarget + _mpEngaged) keeps the enemy
				// permanently engaged — but CrossCode's A* is per-level-block (redoPath only
				// walks the enemy's block grid), so a mirror one block over is nav-unreachable:
				// the enemy stays "engaged" yet can never path to the member = it never lands
				// a hit (the round-37 sameBlock gates only guarded the re-pin/acquire, never
				// this member-initiated pin). The forwarded DAMAGE still lands regardless;
				// only the aggro/attack pin is same-block-scoped.
				let sameBlock = true;
				try {
					sameBlock = (ig.game as any).getLevelIdx(target.coll.pos.z)
						=== (ig.game as any).getLevelIdx(mirror.coll.pos.z);
				} catch (_) { sameBlock = true; }
				if (sameBlock) {
					try { target.targetLoseTimer = 0; } catch (_) { /* ignore */ }
					try { target.setTarget(mirror); } catch (_) { /* ignore */ }
					try { target._mpEngaged = { name: hit.attacker }; } catch (_) { /* ignore */ }
				}
			}
			// Group aggro: a member hitting ONE enemy of a cluster must aggro the
			// whole cluster on the host too (same engine call the vanilla proximity
			// aggro uses). Neighbours acquire the attacker's mirror as their target,
			// which then streams to the member via the block's tg flag.
			this.notifyGroupAggro(target);
			// ROUND 31 (item 2/5): every group neighbour the aggro call just engaged gets
			// the same _mpEngaged mark, so the re-pin holds THEM on this member too (and
			// only them — no full-map aggro). Set AFTER notifyGroupAggro so the fresh
			// targets it assigned are all covered; notifyNearbyEnemiesOfTarget only touches
			// the cluster within notifyNeighbourRadius.
			try {
				if (!target._killed) {
					for (let i = 0; i < list.length; i++) {
						const e: any = list[i];
						if (e instanceof Enemy && !e._mpMirror && !e._killed && e.target && !e._mpEngaged) {
							try { e._mpEngaged = { name: hit.attacker }; } catch (_) { /* ignore */ }
						}
					}
				}
			} catch (_) { /* ignore */ }
			// Round 20 (fix 3): proper knockback direction for member-initiated hits.
			// The engine's getHitVel (game.compiled.js ~byte 2487444) derives the knockback
			// from the ATTACKER's velocity — the mirror is lockEntity-locked with zero
			// velocity, so it falls back to flip(victim.vel) and a stationary monster gets
			// knocked DOWN instead of away. Compute the away-from-mirror direction
			// center-to-center; applyEnemyKnockback applies it in both branches below.
			// Fallback {x:0,y:1} if the direction is degenerate.
			const awayDir: { x: number, y: number } = { x: 0, y: 1 };
			try {
				if (mirror && mirror.coll && target.coll) {
					const ms = mirror.coll.size || { x: 0, y: 0, z: 0 };
					const ts = target.coll.size || { x: 0, y: 0, z: 0 };
					let dx = (target.coll.pos.x + ts.x / 2) - (mirror.coll.pos.x + ms.x / 2);
					let dy = (target.coll.pos.y + ts.y / 2) - (mirror.coll.pos.y + ms.y / 2);
					const len = Math.sqrt(dx * dx + dy * dy);
					if (len > 0.0001) { awayDir.x = dx / len; awayDir.y = dy / len; }
				}
			} catch (_) { /* direction is cosmetic — never break the hit */ }
			// Round 11: see teammate damage. Instead of a bare reduceHp (which shows
			// NOTHING), run the enemy's REAL damage path with the member's mirror as
			// the attacker — the same chain an official party bot's hits use: white
			// flash, knockback, damage number, hit sound, proper death on kill. The
			// Enemy.onPreDamageModification hook (branch C) forces the exact forwarded
			// number so host HP always matches what the member saw.
			let applied = false;
			if (mirror && !mirror._killed && mirror.params && typeof target.damage === 'function'
				&& (sc as any).AttackInfo && !target.params.isDefeated()) {
				try {
					const mirrorAny: any = mirror;
					mirrorAny._mpForcedDamage = dmg;
					// ROUND 72 (crit style sync): the host chain rolls crit off the mirror
					// husk's params, so member crits showed plain on the host. Carry the
					// attacker's rolled crit; branch C forces it onto the damageResult the
					// same way _mpForcedDamage forces the value. Cleared alongside it.
					mirrorAny._mpForcedCrit = hit.critical === true;
					// ROUND 80 (number style sync): carry the attacker's rolled number
					// style too — baseOffensiveFactor/defensiveFactor set the number's
					// SIZE (uncharged ranged hits are the small thin ones), and weakness
					// drives the STRONG/WEAK appendix. Branch C forces them onto the
					// damageResult, so the host renders the exact number the member saw.
					mirrorAny._mpForcedOff = (typeof hit.off === 'number' && isFinite(hit.off) && hit.off > 0 && hit.off <= 10)
						? hit.off : null;
					mirrorAny._mpForcedDef = (typeof hit.def === 'number' && isFinite(hit.def) && hit.def > 0 && hit.def <= 10)
						? hit.def : null;
					mirrorAny._mpForcedWeak = hit.weak === true;
					// The fabricated AttackInfo must look like the REAL attack to the
					// enemy's reaction system. In particular the meerkat's CHARGE_WEAK
					// (red-flash break) reaction checks attacker.attackInfo.hasHint
					// ("CHARGED") via the mirror's tackle.attackInfo, so the mirror's
					// fake tackle points at this info (with the real CHARGED hint),
					// never at the old bare {element:0} object.
					// The fake tackle MUST be restored synchronously: left in place,
					// the mirror's own Combatant.update consumes it via checkTackle
					// next frame and onDamage crashes on the bare object (no
					// damageFactor/limiter — the round-12 host crash).
					const prevTackle = mirrorAny.tackle;
					const prevMirrorIsBall = mirrorAny.isBall;
					// ROUND 34 (item 1/2): steer the NATIVE knockback instead of a second
					// manual doDamageMovement. getHitVel (engine ~2487444) reads the
					// ATTACKER's coll.vel for the knockback direction; the mirror is
					// lockEntity-locked (zero vel), so without this it falls to
					// flip(victim.vel) -> a stationary enemy knocked DOWN. Set the mirror's
					// vel to the away direction for the duration of damage() (the engine's
					// doDamageMovement rescales it to the fly level's magnitude), then
					// restore — the native onDamage now yields the vanilla flinch/stun/
					// interrupt/knockback for EVERY attack type, poise-aware.
					const prevVelX = (mirrorAny.coll && mirrorAny.coll.vel) ? mirrorAny.coll.vel.x : 0;
					const prevVelY = (mirrorAny.coll && mirrorAny.coll.vel) ? mirrorAny.coll.vel.y : 0;
					try {
						if (mirrorAny.coll && mirrorAny.coll.vel) {
							mirrorAny.coll.vel.x = awayDir.x;
							mirrorAny.coll.vel.y = awayDir.y;
						}
						// ROUND 80 (charged-break fix): rebuild the real attack shape.
						// `hints: ['CHARGED']` is what BALL_CHARGE / CHARGE_WEAK checks;
						// the 3rd AttackInfo ctor arg (true for balls) sets ballDamage so
						// every ball-only damage branch sees the true attack kind.
						const infoOptions: any = {
							type: flyStr, element: atkEl, hitInvincible: true,
						};
						if (isBall && hit.charged === true) infoOptions.hints = ['CHARGED'];
						const info = new (sc as any).AttackInfo(mirrorAny.params, infoOptions, isBall);
						// ROUND 32 (item 3c): mark the fabricated AttackInfo as a ball when the
						// real attack was one, so the engine's ball-vs-melee branches (fly level,
						// KNOCKBACK modifier, doDamageMovement) see the true attack kind.
						try { (info as any).isBall = isBall; } catch (_) { /* cosmetic */ }
						// The attacker ENTITY also advertises the real shape for reaction
						// conditions that read damagingEntity.isBall (BALL_SMALL etc.).
						try { mirrorAny.isBall = isBall; } catch (_) { /* cosmetic */ }
						// getElement() reads tackle.attackInfo.element; reaction conditions
						// read tackle.attackInfo.hasHint — point the fake tackle at the real info.
						mirrorAny.tackle = { attackInfo: info };
						// Round 20 (fix 2): a member's forwarded hit must land even when the
						// monster has no target yet or sits far from the host's screen.
						// Combatant.damage (game.compiled.js ~byte 2492349) rejects ENEMY-party
						// hits when `!this.target && !b.limiter.noAggro` (and the mirror
						// attacker isn't a player, so the far-off-screen clause also rejects).
						// noAggro opts the hit out of that gate. The engine ALSO gates
						// Enemy.onDamage's auto-aggro (damageUpdate, ~byte 2583530) on
						// `!b.limiter.noAggro`, so this does NOT steal aggro — the explicit
						// setTarget + notifyGroupAggro above remain the aggro drivers.
						//
						// ROUND 21 (limiter-pollution fix): the AttackInfo ctor (game.compiled.js
						// ~byte 1078612) assigns `this.limiter = sc.ATTACK_LIMITER[b.limiter] || e`
						// where `e` is ONE module-scope object (byte ~1077116) shared by EVERY
						// AttackInfo that omits an explicit limiter. The old `info.limiter || {}`
						// was a no-op and writing noAggro through it mutated that shared default —
						// every later AttackInfo (the host's own melee/balls, enemy attacks)
						// inherited noAggro, killing hit-time aggro (Enemy.onDamage ->
						// damageUpdate, ~byte 2583542, is gated on `!b.limiter.noAggro`) and
						// bypassing the i-frame gate in Combatant.damage (~byte 2492571:
						// `invincibleTimer && !b.hitInvincible && !b.limiter.noAggro`). Build a
						// FRESH object so the shared default stays untouched.
						try { (info as any).attackElement = atkEl; (info as any).element = atkEl; } catch (_) { /* cosmetic */ }
						info.limiter = { noAggro: true };
						// Fix 2: the 3rd arg (Combatant.damage's `c`) must be the target, not
						// null. The engine gates `!c && this.coll.subColls.length > 0` ->
						// return false, so null there drops every multi-part enemy into the
						// bare-HP fallback below — member-forwarded hits showed only the
						// number, no flinch/knockback/sparks. Passing the target kills the
						// guard, and onDamage's `r = c || this` still resolves to the target.
						// ROUND 70 (member-hit number position): the native chain inside
						// target.damage computes the damage-number position from the ATTACKER
						// (the member's mirror husk) — for a ranged member hit the mirror is
						// nowhere near the enemy, and getOverlapCenterCoords clamps the point
						// into the MIRROR's coll box, so the number popped at the member's
						// head on the host's screen. Pin the spawnHitNumber override to the
						// target's body for exactly this call so the number lands on the
						// monster; everything else (knockback dir, shields) is untouched.
						let ovrSet = false;
						try {
							const tc: any = target.coll;
							if (tc && tc.pos && tc.size) {
								(this as any)._mpHitNumPosOverride = {
									x: tc.pos.x + tc.size.x / 2,
									y: tc.pos.y + tc.size.y / 2,
									z: tc.pos.z + tc.size.z / 2,
								};
								ovrSet = true;
							}
						} catch (_) { /* cosmetic */ }
						try {
							applied = target.damage(mirror, info, target) !== false;
						} finally {
							if (ovrSet) { try { (this as any)._mpHitNumPosOverride = null; } catch (_) { /* ignore */ } }
						}
						// ROUND 60 (diagnostics): did the engine chain ACCEPT the forwarded hit, and
						// did the forced-damage branch (C) actually fire? `forced` is true when the
						// mirror's _mpForcedDamage was still set at the moment damage() returned — i.e.
						// branch C did NOT consume it, so the engine computed its OWN (reduced) number
						// instead of the forwarded one. That is the 0~1-on-host signature. Gated on
						// _mpSfxDebug so there is no live behavior change.
						try { (this as any)._mpLastAedForced = ((mirror as any)._mpForcedDamage != null); } catch (_) { (this as any)._mpLastAedForced = true; }
					} finally {
						mirrorAny.tackle = prevTackle;
						mirrorAny.isBall = prevMirrorIsBall;
						if (mirrorAny.coll && mirrorAny.coll.vel) {
							mirrorAny.coll.vel.x = prevVelX;
							mirrorAny.coll.vel.y = prevVelY;
						}
						// ROUND 80: never leave force/style stashes on the mirror — a
						// stale stamp would let a future stray mirrored projectile through
						// the new damage-entry guard.
						mirrorAny._mpForcedDamage = null;
						mirrorAny._mpForcedCrit = null;
						mirrorAny._mpForcedOff = null;
						mirrorAny._mpForcedDef = null;
						mirrorAny._mpForcedWeak = null;
					}
				} catch (_) { applied = false; }
				if (!applied) {
					(mirror as any)._mpForcedDamage = null;
					(mirror as any)._mpForcedCrit = null;
					(mirror as any)._mpForcedOff = null;
					(mirror as any)._mpForcedDef = null;
					(mirror as any)._mpForcedWeak = null;
				}
				// ROUND 60 (diagnostics): the outcome of the engine chain for a forwarded member hit.
				// `applied` = did target.damage() run the full chain; `forced` = was the forwarded number
				// left unconsumed (branch C never fired → the engine's own reduced number showed, which
				// the host reads as 0~1). `hs` = the real enemy's hitStable (interrupt/poise gate).
				try {
					const st: any = this;
					const stF: any = st._mpLastAedForced;
					this._sfxLog('aed.res', 'uid=' + hit.uid, 'applied=' + (applied ? 1 : 0),
						'forced=' + (stF === false ? 0 : 1),
						'dmg=' + dmg, 'hs=' + (typeof target.hitStable === 'number' ? target.hitStable : -1));
					st._mpLastAedForced = undefined;
				} catch (_) { /* cosmetic */ }
				// ROUND 43 (enemy-hurt sound for teammates): the native onDamage chain above
				// (target.damage -> Enemy.onDamage -> showHitEffect) ALREADY plays the hurt sound
				// for the host and fires the onShowHitEffect relay that carries it to the
				// non-attacker spectators on their same-uid puppets; the attacking member replays
				// their own FX via playEnemyPuppetHitFx in the damage hook. Do NOT re-run
				// playEnemyPuppetHitFx here — that would double-play the host's native sound AND
				// (because it wraps _mpReplayingFx) suppress the very onShowHitEffect relay the
				// spectators depend on. Applied-failure leaves it to the fallback.
				// ROUND 34 (item 1/2): the success path now relies ENTIRELY on the native
				// onDamage chain for flinch / stun / interrupt / knockback. Round 32's manual
				// poise-gated cancelAction AND the unconditional applyEnemyKnockback here are
				// REMOVED: applyEnemyKnockback forced doDamageMovement(d=false) — flinch anim +
				// snap velocity + a returned stun — on EVERY hit regardless of poise, and its
				// damageTimer override fabricated a stun the native hit never had. That stun's
				// expiry ran cancelStun (engine ~2490590), which zeroes the entity's stepTimer —
				// the SAME timer the live windup WAIT step counts down — truncating the windup
				// to one frame (the "skips its attack windup" report), and the forced flinch
				// read as "every attack staggers the enemy". onDamage already cancels the
				// action and knocks back exactly when attackType > hitStable (and never while
				// the enemy is params-locked), so a weak uncharged ball (LIGHT) correctly does
				// neither. Only the FALLBACK below (engine chain refused) needs a manual, now
				// poise-aware, knockback.
			}
			if (!applied) {
				// ROUND 60 (diagnostics): the fallback HP write. If the host shows 0~1 AND we land here
				// (applied=0), the FULL forwarded number was written — so the small number came from the
				// MEMBER side (fed.out), not the host. If applied=1 with forced=1, the host's own engine
				// chain produced the small number. This tag separates those two cases.
				this._sfxLog('aed.fb', 'uid=' + hit.uid, 'dmg=' + dmg);
				// Fallback (mirror not up / multi-part enemy colliding / damage refused):
				// bare HP write + a manual damage number so the hit is still visible.
				// ROUND 67: the manual number must keep the GUARDED style when the enemy's
				// active shields would have blocked this hit (the hedgehog's roll-up
				// shield) — the old plain call rendered a normal-format number for a hit
				// the native chain would have shown as silver/guarded. Ask the engine's
				// own isShielded for the verdict (same call the native chain makes).
				let shieldFb = 0;
				try {
					const scratch: any = { hitStable: 0, damageFactor: 1 };
					if (mirror && mirror.params && typeof target.isShielded === 'function' && (sc as any).AttackInfo) {
						const infoFb: any = new (sc as any).AttackInfo(mirror.params, { type: flyStr, element: atkEl });
						try { infoFb.isBall = isBall; } catch (_) { /* cosmetic */ }
						shieldFb = target.isShielded(mirror, infoFb, target, scratch) || 0;
					}
				} catch (_) { shieldFb = 0; }
				target.params.reduceHp(dmg);
				// ROUND 72: pass the attacker's rolled crit through to the fallback number
				// too (was hardcoded false — a fallback crit rendered plain white).
				// ROUND 80: pass the attacker's style block too, so a fallback number keeps
				// the small-thin uncharged-ball formatting instead of the melee default.
				this.spawnHitNumberOn(target, dmg, hit.critical === true,
					shieldFb > 0 ? shieldFb : undefined,
					{ off: hit.off, def: hit.def, weak: hit.weak === true });
				// Round 20 (fix 3): the fallback skips the engine's whole damage chain, so
				// there was no knockback at all — apply the away-from-mirror knockback here.
				// ROUND 34 (item 1/2): pass the poise gate + real fly level so a weak hit
				// doesn't invent hitstun (doDamageMovement's 4th arg = native k =
				// hitStable >= attackType) and an uncharged ball uses LIGHT, not MEDIUM.
				const stableFb = (typeof target.hitStable === 'number' && isFinite(target.hitStable)) ? target.hitStable : 0;
				this.applyEnemyKnockback(target, mirror, awayDir, flyStr, stableFb >= typeNum);
			}
			// ROUND 45 (Gap A): this host ran the enemy's native damage chain -> showHitEffect,
			// which plays the hurt sound for the host and fires the enemySound relay. But the
			// server SELF-DROPS the attacking member's own enemyDamage packet back to that
			// member, so a SPECTATING member (watching a teammate hit the enemy) hears nothing.
			// Relay a cosmetic-only enemyHurt so every OTHER member replays the hurt FX on its
			// own same-uid puppet. No damage rides on it (HP already moved above).
			try {
				if (typeof (this.main.connection as any).emitEnemyHurt === 'function') {
					this._sfxLog('aed.relay', 'uid=' + hit.uid + ' t=' + typeNum + ' el=' + atkEl);
					(this.main.connection as any).emitEnemyHurt({ uid: hit.uid, type: typeNum, attackElement: atkEl, critical: hit.critical === true, attacker: hit.attacker });
				}
			} catch (_) { /* cosmetic relay */ }
		} catch (_) { /* never let a combat packet crash the frame */ }
	}

	/** ROUND 23 (loot sync, HOST side): a host real enemy's death chain granted
	 * credits + item drops to the LOCAL player (via Enemy.onDefeat ->
	 * enemyType.resolveDefeat). Round 24 (loot fairness): the host relays the RAW
	 * drop table + the enemy's booster state — each member rolls its OWN drops with
	 * ITS OWN stats (rolling host-side gave every member the HOST's odds, which are
	 * wrong for them). Credits are deterministic and still relayed as-is. The host's
	 * own resolveDefeat ALREADY granted the local player its loot; this never calls
	 * resolveDefeat again, so there is no double-grant. EXP is deliberately NOT
	 * relayed here (member death paths mirror it already — see the doLootMirror
	 * comment in processDeathQueue). */
	private onHostEnemyDefeated(enemy: any): void {
		try {
			const et: any = enemy && enemy.enemyType;
			if (!et) return;
			const scAny: any = sc as any;
			// Credits: adapt to the enemy's level override exactly like resolveDefeat.
			let credit = et.credit || 0;
			if (credit && enemy.level && enemy.level.override) {
				try {
					if (scAny.EnemyLevelScaling && typeof scAny.EnemyLevelScaling.adaptCredits === 'function') {
						credit = scAny.EnemyLevelScaling.adaptCredits(credit, et.level, enemy.level.override);
					}
				} catch (_) { /* keep the raw credit */ }
			}
			// Round 24: NO host-side ITEMS-core gate / rank / DROP_CHANCE math here — that
			// all moved to the members (applyLoot). Just ship the raw table + boosterState.
			const drops = this.resolveMemberItemDrops(et, enemy);
			const boosterState = (typeof enemy.boosterState === 'number' && isFinite(enemy.boosterState))
				? enemy.boosterState : 0;
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			if (credit > 0 || drops.length) {
				conn.emitLoot({ uid: enemy.uid, credit: Math.round(credit), boosterState, drops });
			}
		} catch (_) { /* never break the death chain */ }
	}

	/** Round 24 (loot fairness): return the enemy's RAW item drop table, sanitized for
	 * the wire (was Round 23's host-side resolver — removed, because rolling with the
	 * HOST's stats gave every member the host's odds). Each member rolls the table
	 * with ITS OWN stats instead (identical distribution to the engine's
	 * resolveItemDrops; see applyLoot). Fields are coerced to bounded primitives and
	 * the table is capped at 16 entries; condition fields are ignored (the engine
	 * ignores them too). Every access is guarded; any failure skips just that entry. */
	private resolveMemberItemDrops(enemyType: any, enemy: any): ILootDrop[] {
		const out: ILootDrop[] = [];
		try {
			const drops: any[] = (enemyType && enemyType.itemDrops) || [];
			for (const m of drops) {
				if (!m || typeof m !== 'object') continue;
				if (out.length >= 16) break;
				try {
					out.push({
						item: m.item != null ? String(m.item) : '',
						prob: (typeof m.prob === 'number' && isFinite(m.prob)) ? m.prob : 0,
						min: (typeof m.min === 'number' && isFinite(m.min)) ? m.min : 1,
						max: (typeof m.max === 'number' && isFinite(m.max)) ? m.max : 0,
						rank: (typeof m.rank === 'string') ? m.rank : '',
						boosted: !!m.boosted,
					});
				} catch (_) { /* skip this drop entry on any failure */ }
			}
		} catch (_) { /* a failure never breaks the death chain */ }
		return out;
	}

	/**
	 * Round 21: a member reported a monster hit it detected LOCALLY (native damage
	 * pipeline on their side). BOOKKEEPING ONLY — the member's real HP already streams
	 * to us via playerState (it overwrites the mirror's hp every frame), so NOTHING is
	 * re-applied here and the enemy is never damaged. This relay exists for future
	 * bookkeeping/telemetry, and as a sanity check that the referenced enemy is still a
	 * live combatant. Do NOT apply damage from this relay.
	 */
	private onCombatResult(hit: { uid: number, damage: number, guarded: boolean }): void {
		try {
			if (!this.main.host) return;                 // only the host owns real enemies
			if (!hit || typeof hit.uid !== 'number' || !isFinite(hit.uid) || hit.uid <= 0) return;
			// Verify the enemy still exists (a missing uid = the monster we synced was
			// already killed/despawned). No action either way.
			const list = ig.game.entities;
			const Enemy = (ig.ENTITY as any).Enemy;
			for (let i = 0; i < list.length; i++) {
				const e: any = list[i];
				if (e instanceof Enemy && !e._mpMirror && !e._killed && e.uid === hit.uid) return;
			}
		} catch (_) { /* ignore */ }
	}

	/** Round 26: HOST + MEMBER — a counter/guard-break dramatic effect just played
	 * LOCALLY on a shared enemy (called from the sc.combat.doDramaticEffect wrap).
	 * Member-side counters on puppets already play natively (puppets are real Enemies
	 * with enemyType.reactions), but only the acting member sees them — relay the event
	 * so the host + other members replay it on the same-uid entity (uid spaces match:
	 * member puppets mirror host enemy uids). Guards: only the two synced kinds; never
	 * while WE are the one replaying (_mpReplayingFx — the emit-loop guard); the target
	 * must be a SHARED enemy or puppet — a numeric uid and NOT a remote-player mirror
	 * (mirrors = players, so PVP is untouched); and the connection must be open. Any
	 * failure is swallowed so an FX relay can never break the frame. */
	private observeDramaticEffect(target: any, kind: any): void {
		try {
			if (this._mpReplayingFx) return;
			const scAny: any = sc as any;
			if (kind !== scAny.DRAMATIC_EFFECT.GUARD_COUNTER
				&& kind !== scAny.DRAMATIC_EFFECT.GUARD_BREAK) return;
			if (!target || typeof target.uid !== 'number' || !(target.uid > 0) || target._mpMirror) return;
			// the local player's own guard-break is native on every screen that matters
			// and its uid matches no shared enemy/puppet — skip the stray relay.
			if (target === (ig as any).game.playerEntity) return;
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			const fxKind = kind === scAny.DRAMATIC_EFFECT.GUARD_COUNTER ? 'counter' : 'break';
			conn.emitCombatFx(target.uid, fxKind);
		} catch (_) { /* a failed FX relay must never break the frame */ }
	}

	/** Round 24: a SHARED enemy (uid) had a counter/guard-break FX elsewhere (server-
	 * relayed, sender excluded). Replay it LOCALLY so the head popup + speedlines
	 * appear: on a MEMBER the entity is the puppet (this.puppets[uid]); on the HOST
	 * it's the real enemy with the same uid (member puppets mirror host enemy uids). If
	 * the entity isn't found (already dead / left the map / this side never had it) the
	 * event is ignored. The replay runs under the _mpReplayingFx loop-guard, so the
	 * doDramaticEffect wrap's observer skips it and it can never re-emit. Guards:
	 * connected + in-game + not mid-cutscene (follows the existing gates); every step
	 * is try/catch'd so a failed replay never breaks the frame. */
	private replayCombatFx(uid: number, kind: string): void {
		try {
			if (kind !== 'counter' && kind !== 'break') return;
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			if (this.inCutscene) return;
			const game: any = ig.game;
			if (!game || !game.playerEntity) return;
			const scAny: any = sc as any;
			if (!scAny.combat || typeof scAny.combat.doDramaticEffect !== 'function') return;
			let ent: any = null;
			if (this.main.host) {
				// Host: the live real enemy carrying this uid (same lookup as applyEnemyDamage).
				const list = game.entities;
				const Enemy = (ig.ENTITY as any).Enemy;
				for (let i = 0; i < list.length; i++) {
					const e: any = list[i];
					if (e instanceof Enemy && !e._mpMirror && !e._killed && e.uid === uid) { ent = e; break; }
				}
			} else {
				// Member: the puppet bound to this host uid (same lookup as applyEnemyAttack).
				ent = this.puppets[uid];
			}
			if (!ent || ent._killed || ent._mpDying || !ent.coll) return;
			this._mpReplayingFx = true;
			try {
				if (kind === 'counter') {
					scAny.combat.doDramaticEffect(ent, ent, scAny.DRAMATIC_EFFECT.GUARD_COUNTER, true);
				} else {
					// Guard-break extra visual: the broken-guard FX (normally spawned inside
					// the player's damageShield — sc.combat.effects.guard.spawnOnTarget). Its
					// own try/catch so a missing/partial guard FX sheet can't skip the
					// dramatic effect below.
					try {
						if (scAny.combat.effects && scAny.combat.effects.guard
							&& typeof scAny.combat.effects.guard.spawnOnTarget === 'function') {
							scAny.combat.effects.guard.spawnOnTarget('guardBroken', ent, { duration: -1 });
						}
					} catch (_) { /* the FX is cosmetic — the dramatic effect still plays */ }
					scAny.combat.doDramaticEffect(ent, ent, scAny.DRAMATIC_EFFECT.GUARD_BREAK, true);
				}
			} catch (_) { /* never break the frame */ }
			finally { this._mpReplayingFx = false; }
		} catch (_) { /* a failed FX replay must never crash the frame */ }
	}

	/** Round 20 (fix 3): knock a host enemy away from the member's mirror after a
	 * member-initiated hit. Used ONLY by the applyEnemyDamage FALLBACK now (the success
	 * path steers the native onDamage via the mirror's coll.vel — round 34). The engine's
	 * getHitVel derives knockback from the ATTACKER's velocity, which is zero on a
	 * lockEntity-locked mirror — it falls back to flip(victim.vel) and knocks a stationary
	 * monster DOWN instead of away. We call doDamageMovement directly with the
	 * center-to-center away direction. ROUND 34 (item 1/2): `poised` (native k =
	 * hitStable >= attackType) makes the knockback poise-aware — when the enemy's poise
	 * beats the hit, doDamageMovement's `d` branch applies only a gentle additive push and
	 * returns stun 0 (no flinch, no fabricated damageTimer), matching vanilla; the old
	 * unconditional d=false forced a flinch + stun on every hit and its damageTimer floor
	 * (0.25) is what truncated the windup WAIT step. Safe no-op when the mirror is gone or
	 * the engine routine is unavailable. */
	private applyEnemyKnockback(target: any, mirror: any, dir: { x: number, y: number }, fly?: string, poised?: boolean): void {
		try {
			if (!mirror || !target || typeof target.doDamageMovement !== 'function') return;
			// ROUND 32 (item 3c): knock the enemy with the REAL attack's fly level instead
			// of the old hardcoded 'MEDIUM'. An uncharged ball forwards 'LIGHT' (weak
			// knockback), a melee / charged ball / knockback skill forwards its real
			// MEDIUM/HEAVY/MASSIVE. COMBAT_FLY_LEVEL keys are the same strings.
			const flyLevel = (fly === 'LIGHT' || fly === 'MEDIUM' || fly === 'HEAVY' || fly === 'MASSIVE') ? fly : 'MEDIUM';
			const stun = target.doDamageMovement({ x: dir.x, y: dir.y }, flyLevel, false, poised === true, 0, false, false, 1);
			// ROUND 34: only an interrupting hit returns a stun; feed THAT to damageTimer
			// (no 0.25 floor — a poised hit must not fabricate hitstun / zero the windup).
			if (typeof stun === 'number' && stun > 0) target.damageTimer = Math.max(target.damageTimer || 0, stun);
		} catch (_) { /* knockback is cosmetic — never break the hit */ }
	}

	/** Spawn a damage number on a combatant at its REAL hit position (the old
	 * `spawnHitNumber(null, ...)` calls silently threw — the engine reads pos.x). */
	private spawnHitNumberOn(ent: any, dmg: number, critical: boolean, shieldResult?: number,
		style?: { off?: number, def?: number, weak?: boolean }): void {
		try {
			if (!ig.ENTITY.HitNumber || !(ig.ENTITY.HitNumber as any).spawnHitNumber || !ent) return;
			let pos: any = null;
			try { if (typeof ent.getHitCenter === 'function') pos = ent.getHitCenter(ent, (ig as any).Vec3.create()); } catch (_) { /* ignore */ }
			if (!pos && ent.coll) {
				const s = ent.coll.size || { x: 0, y: 0, z: 0 };
				pos = { x: ent.coll.pos.x + s.x / 2, y: ent.coll.pos.y + s.y / 2, z: ent.coll.pos.z + s.z / 2 };
			}
			if (!pos) return;
			// ROUND 31 (item 1a): the 6th `g` arg is the engine's shieldResult. The old
			// hardcoded 0 (SHIELD_RESULT.NONE) made EVERY number render plain/critical —
			// a blocked hit never showed the silver-shield GUARD style. The engine's own
			// call site (game.compiled.js ~byte 2496394) passes the live shield result and
			// its spawnHitNumber (~byte 2481423) styles the number exclusively off `g`
			// (PERFECT -> P icon, REGULAR -> shield icon). sc.SHIELD_RESULT = {NONE:0,
			// REGULAR:1, PERFECT:2, NEUTRALIZE:3}.
			const g = (typeof shieldResult === 'number') ? shieldResult : 0;
			// ROUND 72: carry the full native style triple — offFactor drives the number
			// SIZE (XXS..L), defFactor the STRONG/WEAK appendix (element effectiveness,
			// >=1.25 / <=0.75), weak the element-weakness appendix. Defaults reproduce the
			// old plain rendering for callers that don't know the style.
			const offF = (style && typeof style.off === 'number' && isFinite(style.off)) ? style.off : 1;
			const defF = (style && typeof style.def === 'number' && isFinite(style.def)) ? style.def : 1;
			const weakF = !!(style && style.weak === true);
			(ig.ENTITY.HitNumber as any).spawnHitNumber(pos, ent, dmg, offF, defF, g, !!critical, weakF);
		} catch (_) { /* ignore */ }
	}

	/**
	 * MEMBER side: the host told us an entity hit OUR mirror — apply the result to our
	 * real player.
	 *
	 * ROUND 27 (item 4, HOST-authoritative): MONSTER hits now arrive here with the host's
	 * authoritative verdict (the round-26 local geometry model is GONE). The host resolved
	 * guard/perfect/damage against our streamed guard state + real defense; we apply it
	 * verbatim: `monster:true` + `perfect` (0 dmg, perfect FX + counter window) / `regular`
	 * (chip dmg + guard-bar, no knockback) / neither (raw dmg + knockback). PVP hits are
	 * unchanged (no `monster` flag): the member still cannot detect another player's hits
	 * locally, so those keep the old verbatim-apply + knockback path.
	 */
	private applyCombatHit(hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number, monster?: boolean, perfect?: boolean, regular?: boolean, knockback?: boolean, attackType?: number, shieldDmg?: number, full?: number }): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('ch.' + t, ...a); } catch (_) { /* ignore */ } };
			// ROUND 38: the attacker's REAL attack-type (sc.ATTACK_TYPE) rides on the packet
			// from recomputeHostMonsterHit (hitProps.visualType/type). The old hardcoded LIGHT
			// made every enemy melee hit play the uncharged-ball connect sound instead of the
			// genuine melee hit sound. Use the relayed type (0 = unknown/legacy -> LIGHT).
			const atkType: number = (typeof hit.attackType === 'number' && hit.attackType > 0) ? hit.attackType : 1;
			D('recv', 'dmg=' + (hit && hit.damage), 'monster=' + (hit && !!hit.monster ? 1 : 0),
				'perfect=' + (hit && !!hit.perfect ? 1 : 0), 'regular=' + (hit && !!hit.regular ? 1 : 0),
				'at=' + atkType, 'for=' + (hit && hit.player));
			// ROUND 43 (enemy-attacks-teammate sound): EVERY combatHit now renders on EVERY
			// client that has the victim's mirror — not only the victim. The old code
			// hard-returned for anyone but the victim (`not me`), so a SPECTATOR (neither
			// attacker nor victim) heard NOTHING when an enemy hit a teammate: the host's
			// mirror-husk native showHitEffect is suppressed (the _mpMirror SHIELD_NONE drop
			// in onShowHitEffect) and the victim's own showHitEffect only plays for the
			// victim. Render the FX positioned on the victim's MIRROR instead: the victim's
			// own client drops it (they already play their verdict FX on their real player
			// below), everyone else replays the element-connect + material hit-receive at
			// the victim's spot. Guard results (perfect/regular) keep their own spectator
			// path (emitPlayerGuardSound) so only the PLAIN hit needs this.
			if (!hit || hit.player !== this.main.name) {
				try {
					const isMonsterHit = !!(hit && hit.monster);
					const isGuardHit = isMonsterHit && (!!hit.perfect || !!hit.regular);
					if (isMonsterHit && !isGuardHit && hit && typeof hit.player === 'string' && hit.player) {
						const mir: any = this.main.players[hit.player] && (this.main.players[hit.player] as any).entity;
						if (mir && !mir._killed && mir.coll) {
							const atkTypeS: number = (typeof hit.attackType === 'number' && hit.attackType > 0) ? hit.attackType : 1;
							const scAnyS: any = sc as any;
							if (scAnyS.combat && typeof scAnyS.combat.showHitEffect === 'function') {
								const ms = mir.coll.size || { x: 0, y: 0, z: 0 };
								this._mpReplayingFx = true;
								try {
									// ROUND 46: suppress showHitEffect's own sound (shared groups discard a
									// replayed request -> inaudible); keep it for the visual only, then play
									// BOTH derived hit sounds positionally as fresh per-path Sounds (the
									// proven-audible unique-group mechanism).
									scAnyS.combat.showHitEffect(mir,
										{ x: mir.coll.pos.x + ms.x / 2, y: mir.coll.pos.y + ms.y / 2, z: mir.coll.pos.z + ms.z },
										atkTypeS, hit.element || 0, 0 /* SHIELD_RESULT.NONE */, !!hit.critical, true /* noSound */);
									const igS: any = ig as any;
									if (igS.Sound && igS.SoundHelper && typeof igS.SoundHelper.playAtEntity === 'function') {
										const elP = this._mpPickHitSound('element', atkTypeS, hit.element || 0, undefined);
										const matP = this._mpPickHitSound('material', atkTypeS, 0, mir.material);
										if (elP) igS.SoundHelper.playAtEntity(new igS.Sound(elP, 1, 0.1), mir, false, {}, undefined, undefined);
										if (matP) igS.SoundHelper.playAtEntity(new igS.Sound(matP, 1, 0.1), mir, false, {}, undefined, undefined);
									}
								} finally { this._mpReplayingFx = false; }
							}
						} else { this._sfxLog('ch.nomirror', 'for=' + hit.player); }
					}
				} catch (_) { /* spectator FX is cosmetic */ }
				return; // the HP write + flinch only apply to the victim's own real player
			}
			if (this._mpDead) { D('dead'); return; }                            // corpse takes no hits
			const p: any = ig.game.playerEntity;
			if (!p || !p.params || p._killed) { D('noplayer'); return; }
			if (p.invincibleTimer && p.invincibleTimer > 0) { D('iframes', 't=' + p.invincibleTimer); return; } // i-frames
			// ROUND 27 (item 4): a MONSTER hit is now host-authoritative. The host already
			// resolved guard/perfect/damage against OUR streamed guard state + defense, so
			// we apply its result VERBATIM (no local guard re-derivation — the round-26
			// hand-rolled guard formula that caused phantom damage is gone). The perfect/
			// regular/knockback flags tell us which reaction to play.
			const isMonster = !!hit.monster;
			const perfect = isMonster && !!hit.perfect;
			const regular = isMonster && !!hit.regular;
			const doKnockback = isMonster ? !!hit.knockback : true; // PvP keeps old knockback behaviour
			const guarding = perfect || regular
				|| (typeof p.currentAnim === 'string' && p.currentAnim === 'guard');
			let dmg = Math.max(0, Math.round(hit.damage));
			if (!isMonster) dmg = Math.max(1, dmg); // PvP: unguarded hits keep the min-1 floor
			// ROUND 79 (damage diagnostics): the member's own LOCAL stats + the verdict it
			// received - vs the host's rc.dmg (which used the STREAMED copies of these) any
			// drifted value shows up as a different def/gm/df/ef/fc right here.
			if (isMonster) {
				try {
					let defC = 0, gmC = 0, dfC = 1, fcC = 0; let efC = '';
					try {
						if (p.params && typeof p.params.getStat === 'function') {
							defC = Number(p.params.getStat('defense')) || 0;
							fcC = Number(p.params.getStat('focus')) || 0;
							const ea = p.params.getStat('elemFactor');
							if (Array.isArray(ea)) efC = JSON.stringify(ea.map((v: any) => Math.round(Number(v) * 100) / 100));
						}
						if (p.params && typeof p.params.damageFactor === 'number') dfC = p.params.damageFactor;
						if (p.params && typeof p.params.getModifier === 'function') gmC = Number(p.params.getModifier('GUARD_STRENGTH')) || 0;
					} catch (_) { /* keep zeros */ }
					this._sfxLogRaw('ch.dmg',
						'dmg=' + dmg,
						'bar=' + (typeof hit.shieldDmg === 'number' ? hit.shieldDmg : -1),
						'full=' + (typeof hit.full === 'number' ? hit.full : -1),
						'crit=' + (hit.critical ? 1 : 0),
						'perfect=' + (perfect ? 1 : 0), 'regular=' + (regular ? 1 : 0),
						'def=' + defC, 'gm=' + gmC, 'df=' + dfC, 'ef=' + efC, 'fc=' + fcC,
						'guard=' + (typeof p.currentAnim === 'string' && p.currentAnim === 'guard' ? 1 : 0));
				} catch (_) { /* diagnostic only */ }
			}
			// PERFECT guard (monster): no HP lost, no knockback — play the perfect-guard FX
			// + open the counter window, then bail out early.
			if (perfect) {
				try {
					try { (ig as any).vars.add('playerVar.input.perfectShield', 1); } catch (_) { /* ignore */ }
					try { if (typeof p.perfectGuardCooldown === 'number') p.perfectGuardCooldown = 0; } catch (_) { /* ignore */ }
				} catch (_) { /* FX is cosmetic */ }
				p.invincibleTimer = Math.max(p.invincibleTimer || 0, 0.4);
				// ROUND 32 (items 2a + 3b): the perfect-guard FX + sound now come from the
				// engine's own showHitEffect with SHIELD_RESULT.PERFECT — the single
				// sound+FX player that the native host perfect guard uses. It plays
				// hit-counter-echo.ogg + spawns the transient perfect-guard flash. The old
				// spawnOnTarget('perfectGuard', ..., {duration:-1}) spawned an INFINITE
				// effect with no handle to stop, so it stuck to the member until death/map
				// change and stacked a new dome on every perfect (the screenshot bug). This
				// transient call self-cleans and matches the native timing.
				try {
					const scAny: any = sc as any;
					if (scAny.combat && typeof scAny.combat.showHitEffect === 'function' && p.coll) {
						const s = p.coll.size || { x: 0, y: 0, z: 0 };
						scAny.combat.showHitEffect(p,
							{ x: p.coll.pos.x + s.x / 2, y: p.coll.pos.y + s.y / 2, z: p.coll.pos.z + s.z },
							atkType, hit.element || 0, 2 /* SHIELD_RESULT.PERFECT */, false);
					}
				} catch (_) { /* ignore */ }
				try { this._sfxLogRaw('ch.snd', 'perfect'); } catch (_) { /* diagnostic only */ }
				// ROUND 31 (item 1a): a perfect guard must ALSO show the "P" number, exactly
				// like the host's native perfect guard. The old code returned after only the
				// FX, so no number ever appeared. The engine's spawnHitNumber renders
				// SHIELD_RESULT.PERFECT as the P + shield icons and voids the digits, so the
				// dmg value is irrelevant (pass 1).
				this.spawnHitNumberOn(p, 1, false, 2 /* SHIELD_RESULT.PERFECT */);
				return;
			}
			// REGULAR guard (monster): chip damage already computed host-side; run the
			// engine's OWN damageShield so the guard bar breaks/recovers identically to the
			// host's native guard, and play the guard-block FX (no knockback).
			if (regular) {
				// ROUND 31 (item 1b/1c): the old hand-rolled `p.guard.damage += dmg/7` + clamp
				// replicated ONLY the increment — never the engine's break branch (guard.timer=5,
				// guard.damage=1, onPlayerShieldBreak, GUARD_BREAK). With damage pinned >=1 the
				// shield dome never retracted (endGuardEffect refuses while damage>=1) and
				// handleGuard blocked every re-guard, so the shield stuck on-screen and worked
				// only once. Calling the real p.damageShield(dmg) restores the native break +
				// 5s recovery + dome-FX lifecycle the host has (game.compiled.js ~byte 3018447).
				// ROUND 78 (guard-bar fix): feed the bar the engine's shield-damage value
				// (e.damageFactor × (atk/def)^1.5, shipped as shieldDmg) — NOT the HP chip.
				// The old chip feed over-drained the bar ~10x ("shield breaks too easily").
				// When damageShield returns true the bar BROKE, and the native chain then
				// skips the chip factor entirely — the member takes the FULL unguarded hit
				// (shipped as `full`) with knockback, so fall through to the unguarded
				// branch below exactly like the engine.
				const barDmg = (typeof hit.shieldDmg === 'number' && hit.shieldDmg > 0) ? hit.shieldDmg : dmg;
				let broke = false;
				try { if (p.guard && typeof p.damageShield === 'function') broke = !!p.damageShield(barDmg); } catch (_) { /* ignore */ }
				try { this._sfxLogRaw('ch.bar', 'broke=' + (broke ? 1 : 0), 'barDmg=' + barDmg, 'chip=' + dmg); } catch (_) { /* diagnostic only */ }
				if (broke && typeof hit.full === 'number' && hit.full > 0) {
					dmg = Math.max(1, Math.round(hit.full));
					try { (hit as any).knockback = true; } catch (_) { /* ignore */ } // broken guard -> native unguarded reaction (knockback)
					// fall through: the unguarded branch applies the full hit + knockback
				} else {
					p.params.reduceHp(dmg);
					try { if ((sc as any).model && (sc as any).model.setCombatMode) (sc as any).model.setCombatMode(true); } catch (_) { /* ignore */ }
					p.invincibleTimer = Math.max(p.invincibleTimer || 0, 0.4);
					try {
						const scAny: any = sc as any;
						try { this._sfxLogRaw('ch.snd', 'regular', 'dmg=' + dmg, 'crit=' + (hit.critical ? 1 : 0)); } catch (_) { /* diagnostic only */ }
						if (scAny.combat && typeof scAny.combat.showHitEffect === 'function' && p.coll) {
							const s = p.coll.size || { x: 0, y: 0, z: 0 };
							scAny.combat.showHitEffect(p,
								{ x: p.coll.pos.x + s.x / 2, y: p.coll.pos.y + s.y / 2, z: p.coll.pos.z + s.z },
								atkType, hit.element || 0, 1 /* SHIELD_RESULT.REGULAR */, !!hit.critical);
						}
					} catch (_) { /* ignore */ }
					// ROUND 31 (item 1a): pass SHIELD_RESULT.REGULAR so a blocked hit shows the
					// silver-shield GUARD number (the old hardcoded NONE rendered it plain).
					if (dmg > 0) this.spawnHitNumberOn(p, dmg, !!hit.critical, 1 /* SHIELD_RESULT.REGULAR */);
					return;
				}
			}
			// UNGUARDED hit (monster no-guard, or PvP): apply damage + knockback + flinch.
			D('apply', 'dmg=' + dmg, 'knockback=' + (doKnockback ? 1 : 0));
			p.params.reduceHp(dmg);
			// Enter combat mode (battle BGM / combat UI) — the hit came from a host enemy,
			// which never targets the LOCAL playerEntity, so the engine's own
			// _addTargetedBy->updateCombatMode never fires on a member. Nudge it here.
			try {
				if ((sc as any).model && (sc as any).model.setCombatMode) (sc as any).model.setCombatMode(true);
			} catch (_) { /* ignore */ }
			// Brief i-frames so consecutive forwarded hits don't melt the player in one tick.
			p.invincibleTimer = Math.max(p.invincibleTimer || 0, 0.5);
			// Round 11 hit feedback (受击反馈 + 硬直): reproduce the engine's own hit
			// reaction tail (the vanilla path the local player runs when an enemy swing
			// lands). doDamageMovement plays the 'damage' flinch anim, knocks the player
			// AWAY from the attacker position (ax/ay ride on the combatHit payload) and
			// returns the stun duration -> damageTimer is the hitstun flag that blocks
			// input. showHitEffect adds the hit particles + sound.
			try {
				const dir: any = { x: 0, y: 0 };
				if (typeof hit.ax === 'number' && typeof hit.ay === 'number' && p.coll) {
					dir.x = p.coll.pos.x - hit.ax;
					dir.y = p.coll.pos.y - hit.ay;
				}
				if (!dir.x && !dir.y) {
					// No attacker position known: push backwards relative to facing.
					dir.x = -((p.face && p.face.x) || 0);
					dir.y = -((p.face && p.face.y) || 1);
				}
				// Round 27: knockback is host-decided for monster hits (doKnockback). Guarded
				// monster hits returned early above (no knockback); PvP keeps the old behaviour.
				if (doKnockback && typeof p.doDamageMovement === 'function') {
					// ROUND 64 (client hitstun fix): doDamageMovement's 2nd arg is a
					// COMBAT_FLY_LEVEL key STRING ('LIGHT'/'MEDIUM'/'HEAVY'/'MASSIVE') —
					// the engine does `sc.COMBAT_FLY_LEVEL[b]` and returns 0 (no flinch
					// anim, no knockback, no stun) when the lookup misses. Passing the
					// numeric sc.ATTACK_TYPE here silently voided the whole reaction,
					// which is why a damaged member never flinched or got interrupted.
					// Map ATTACK_TYPE -> fly level exactly like the engine's native
					// applyDamage (game.compiled.js ~line 5013: BREAK folds into
					// MASSIVE, NONE/unknown -> LIGHT).
					const AT: any = (sc as any).ATTACK_TYPE || { LIGHT: 1, MEDIUM: 2, HEAVY: 3, MASSIVE: 4, BREAK: 5 };
					const flyLevel: string =
						atkType === AT.MEDIUM ? 'MEDIUM' :
						atkType === AT.HEAVY ? 'HEAVY' :
						(atkType === AT.MASSIVE || atkType === AT.BREAK) ? 'MASSIVE' : 'LIGHT';
					const stun = p.doDamageMovement(dir, flyLevel, false, false, 0);
					p.damageTimer = Math.max(p.damageTimer || 0, stun || 0.2);
				}
				const scAny: any = sc as any;
				if (scAny.combat && typeof scAny.combat.showHitEffect === 'function' && p.coll) {
					const s = p.coll.size || { x: 0, y: 0, z: 0 };
					scAny.combat.showHitEffect(p,
						{ x: p.coll.pos.x + s.x / 2, y: p.coll.pos.y + s.y / 2, z: p.coll.pos.z + s.z },
						atkType, hit.element || 0, 0 /* SHIELD_RESULT.NONE */, !!hit.critical);
				}
			} catch (_) { /* feedback is cosmetic — never block the HP write */ }
			// Damage number at the player's real hit position (the old null-pos call
			// silently threw, so members never saw their own HP-loss numbers).
			this.spawnHitNumberOn(p, dmg, !!hit.critical);
		} catch (e) { /* never let a combat packet crash the frame */ }
	}

	/** Round 23 (loot sync, MEMBER side): the HOST killed a real enemy and relayed
	 * the credits its death chain granted + the enemy's RAW drop table (onDefeat ->
	 * resolveDefeat). Round 24 (loot fairness): the host no longer rolls items with
	 * its OWN stats — WE roll the raw table with OUR stats, gated on OUR OWN ITEMS
	 * core, mirroring the engine's resolveItemDrops loop (game.compiled.js): rank
	 * gate, boosted gate, DROP_CHANCE + combat-rank-drop-rate + drop-rate-multiplier
	 * probability, then min..max amount. addItem with hideEffect=false shows the
	 * native pickup toast (matching how a local drop would feel); addCredit is
	 * silent. No dedupe needed: the host's onDefeat latches once per death. Guards:
	 * member only (the host already granted itself via the real chain), sc.model
	 * availability, and a per-entry try/catch so one bad entry can't kill the grant. */
	private applyLoot(loot: { uid: number, credit: number, boosterState: number, drops: ILootDrop[] }): void {
		try {
			if (this.main.host) return;               // host already granted via its real death chain
			if (!loot || typeof loot.uid !== 'number' || !isFinite(loot.uid) || loot.uid <= 0) return;
			const scAny: any = sc as any;
			const pm: any = scAny.model && scAny.model.player;
			if (!pm) return;
			if (typeof loot.credit === 'number' && loot.credit > 0) {
				try { pm.addCredit(loot.credit, false, true); } catch (_) { /* ignore */ }
			}
			// Items gate on OUR OWN ITEMS core — the host's core is irrelevant to us.
			try {
				if (!pm.getCore || !pm.getCore(scAny.PLAYER_CORE.ITEMS)) return;
			} catch (_) { return; }
			const drops = loot.drops;
			if (!Array.isArray(drops)) return;
			for (const m of drops) {
				if (!m || typeof m !== 'object') continue;
				try {
					// Combat-rank gate: a rank-gated drop only rolls once WE reach the rank.
					if (m.rank && (pm.combatRank || 0) < scAny.model.getCombatRankByLabel(m.rank)) continue;
					// Boosted gate: only drops when the enemy was actually BOOSTED.
					if (m.boosted && loot.boosterState !== scAny.ENEMY_BOOSTER_STATE.BOOSTED) continue;
					// Probability: the engine's resolveItemDrops formula, with OUR
					// DROP_CHANCE modifier + the shared rank drop rate / drop multiplier.
					const dropChance = pm.params ? (pm.params.getModifier('DROP_CHANCE') || 0) : 0;
					if (!(Math.random() <= m.prob * (m.prob == 1 ? 1 : dropChance + 1)
						* (scAny.model.getCombatRankDropRate() * scAny.newgame.getDropRateMultiplier()))) continue;
					// Amount: min..max, same as the engine.
					let n = m.min || 1;
					if (m.max) n += Math.floor((m.max + 1 - n) * Math.random());
					pm.addItem(Number(m.item), n, false, false);
				} catch (_) { /* skip this drop entry on any failure */ }
			}
		} catch (_) { /* never let a loot packet crash the frame */ }
	}

	/** ROUND 33 (item 2b): HOST-side observer (ig.SoundHelper.playAtEntity wrap).
	 * When a real synced Enemy plays a positioned sound, relay its path + playback
	 * params to the members so their silent puppet replays it (applyEnemySound).
	 * Guards: never while WE are replaying (_mpReplayingFx — no loop); the entity
	 * must be a shared Enemy (numeric uid, NOT a puppet on a member — the hook is
	 * host-only anyway — and NOT a remote-player mirror, so PVP/player sounds are
	 * untouched); host-only; connection open. Every step is swallowed. */
	private observeEnemySound(sound: any, entity: any, loop: any, settings: any, radius: any): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('es.' + t, ...a); } catch (_) { /* ignore */ } };
			if (this._mpReplayingFx) { D('replay'); return; }
			if (!this.main.host) { D('nothost'); return; }
			if (!sound || !entity) { D('nolock'); return; }
			if (typeof entity.uid !== 'number' || !(entity.uid > 0)) { D('nouid', this._paeDescribe(sound, entity)); return; }
			if (entity._mpMirror || entity._mpPuppet || entity._killed) { D('husk', this._paeDescribe(sound, entity)); return; }
			const Enemy = (ig.ENTITY as any).Enemy;
			if (Enemy && !(entity instanceof Enemy)) { D('notenemy', this._paeDescribe(sound, entity)); return; }
			this.relayEntitySound((p) => (this.main.connection as any).emitEnemySound(p), entity.uid, sound, loop, settings, radius, true);
		} catch (_) { /* a failed sound relay must never break the frame */ }
	}

	/** ROUND 39: shared sound-relay core. Resolves the played ig.Sound's asset path +
	 * params, then emits `packet` on the open connection. `forceEnemyUid` routes a
	 * NON-enemy entity's sound onto the enemySound channel by giving it a real synced
	 * enemy's uid (used by observeEffectSound to position a targeted effect on a puppet). */
	private relayEntitySound(emit: (packet: any) => void, uid: number | null, sound: any, loop: any, settings: any, radius: any, hostOnly: boolean, forceEnemyUid?: number): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('rel.' + t, ...a); } catch (_) { /* ignore */ } };
			if (this._mpReplayingFx) { D('replay'); return; }
			if (hostOnly && !this.main.host) { D('nothost'); return; }
			if (!sound) { D('nosound'); return; }
			let path: string = '';
			try { path = (sound.webAudioBuffer && sound.webAudioBuffer.path) || (sound.multiAudio && sound.multiAudio.path) || ''; } catch (_) { path = ''; }
			if (!path || typeof path !== 'string') { D('nopath', this._paeDescribe(sound, null)); return; }
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) { D('noconn'); return; }
			D('emit', path, 'uid=' + (typeof forceEnemyUid === 'number' ? forceEnemyUid : uid));
			const volume = (typeof sound.volume === 'number' && isFinite(sound.volume)) ? sound.volume : 1;
			const variance = (typeof sound.variance === 'number' && isFinite(sound.variance)) ? sound.variance : 0;
			const speed = (settings && typeof settings.speed === 'number' && isFinite(settings.speed)) ? settings.speed : undefined;
			const rad = (typeof radius === 'number' && isFinite(radius)) ? radius : undefined;
			const base: any = {
				path, volume, variance,
				loop: loop === true,
				...(rad !== undefined ? { radius: rad } : {}),
				...(speed !== undefined ? { speed } : {}),
			};
			if (typeof forceEnemyUid === 'number') { base.uid = forceEnemyUid; base.global = false; }
			else if (typeof uid === 'number') { base.uid = uid; base.global = false; }
			emit(base);
		} catch (_) { /* ignore */ }
	}

	/** ROUND 39 (item 5): bridge the DATA-DEFINED effect sounds onto the existing sound
	 * channels. The enemy DEATH/boom (boom_medium in combatant.json) and the remote player's
	 * ball-BOUNCE (ballBounce in ball*.json) are PLAY_SOUND steps inside an Effect sheet —
	 * they fire ig.SoundHelper.playAtEntity positioned on the EFFECT entity, so the old
	 * Enemy-gated observer (real Enemy only) and the player observer (Effect targeted at the
	 * local PLAYER) both missed them. Route by the effect's .target:
	 *   target = a real synced Enemy  -> enemySound (host-only) so the death/boom + the
	 *     enemy-side ball kill replay positioned on the member's same-uid puppet;
	 *   target = the LOCAL player     -> playerSound so the ball-bounce / enemy-swing-hit
	 *     replay positioned on our mirror (the local player's own client relays it natively).
	 * One packet per PLAY_SOUND step; the receivers no-op when the puppet/mirror is gone. */
	private observeEffectSound(sound: any, entity: any, loop: any, settings: any, radius: any): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('ef.' + t, ...a); } catch (_) { /* ignore */ } };
			if (this._mpReplayingFx) { D('replay'); return; }
			if (!sound || !entity) { D('nolock'); return; }
			const igAny: any = ig as any;
			const Effect = igAny.ENTITY && igAny.ENTITY.Effect;
			if (!Effect || !(entity instanceof Effect)) { D('noteffect'); return; }
			const target: any = entity.target;
			if (!target) { D('notarget', this._paeDescribe(sound, entity)); return; }
			const Enemy = (ig.ENTITY as any).Enemy;
			// ROUND 40 (item 5, death boom): the dying enemy may already be `_killed`/uid-cleared
			// when its boom PLAY_SOUND step fires — the old `!target._killed && uid>0` gate rejected
			// exactly those. Accept a real synced enemy that is dying too (still has a uid, not a
			// husk); only a fully-cleared target (uid lost) still falls through.
			const isSyncedEnemy = Enemy && target instanceof Enemy && !target._mpMirror && !target._mpPuppet
				&& typeof target.uid === 'number' && target.uid > 0;
			if (isSyncedEnemy) {
				// An effect ON a real synced enemy (death/boom, enemy-side ball kill) — host-only.
				this.relayEntitySound((p) => (this.main.connection as any).emitEnemySound(p), target.uid, sound, loop, settings, radius, true);
			} else if (target === (igAny.game && igAny.game.playerEntity) && !target._mpMirror && !target._mpPuppet) {
				// An effect ON the LOCAL player (ball bounce, enemy-swing hit) — both host & member.
				this.relayEntitySound((p) => (this.main.connection as any).emitPlayerSound(p), null, sound, loop, settings, radius, false);
			} else {
				D('nomatch', this._paeDescribe(sound, entity));
			}
		} catch (_) { /* a failed sound relay must never break the frame */ }
	}

	/** ROUND 34 (item 3): observer (ig.SoundHelper.playAtEntity wrap) for the LOCAL
	 * player's OWN attack sounds. A remote player's melee-swing / ball-THROW sounds are
	 * played on an ig.ENTITY.Effect whose `.target` is the acting player (all global:false),
	 * so observeEnemySound (host-only + Enemy-gated) never carries them — watchers heard an
	 * incomplete set. When the Effect's target IS our local playerEntity, relay the sound
	 * to the rest of our instance (both host and member attack), who replay it positioned
	 * on our mirror (applyPlayerSound). Guards: never while WE are replaying
	 * (_mpReplayingFx — no loop); the effect must target the local player; the effect must
	 * NOT belong to a remote-player mirror (their sounds are already relayed to us by their
	 * own client — replaying + relaying again would double); connection open. */
	private observePlayerSound(sound: any, entity: any, loop: any, settings: any, radius: any): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('ps.' + t, ...a); } catch (_) { /* ignore */ } };
			if (this._mpReplayingFx) { D('replay'); return; }
			if (!sound || !entity) { D('nolock'); return; }
			const igAny: any = ig as any;
			const Effect = igAny.ENTITY && igAny.ENTITY.Effect;
			if (!Effect || !(entity instanceof Effect)) { D('noteffect'); return; }
			const target: any = entity.target;
			const me: any = igAny.game && igAny.game.playerEntity;
			if (!target || !me || target !== me) { D('notme', this._paeDescribe(sound, entity)); return; }          // only OUR OWN attack FX
			if (target._mpMirror || target._mpPuppet) { D('husk'); return; }      // a remote mirror's FX is relayed by its owner
			// Resolve the sound's asset path. WebAudio: webAudioBuffer.path; the
			// fallback default player: multiAudio.path. Guard each hop.
			let path: string = '';
			try { path = (sound.webAudioBuffer && sound.webAudioBuffer.path) || (sound.multiAudio && sound.multiAudio.path) || ''; } catch (_) { path = ''; }
			if (!path || typeof path !== 'string') { D('nopath', this._paeDescribe(sound, entity)); return; }
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) { D('noconn'); return; }
			D('emit', path, 'loop=' + (loop === true));
			const volume = (typeof sound.volume === 'number' && isFinite(sound.volume)) ? sound.volume : 1;
			const variance = (typeof sound.variance === 'number' && isFinite(sound.variance)) ? sound.variance : 0;
			const speed = (settings && typeof settings.speed === 'number' && isFinite(settings.speed)) ? settings.speed : undefined;
			const rad = (typeof radius === 'number' && isFinite(radius)) ? radius : undefined;
			conn.emitPlayerSound({
				path, volume, variance,
				loop: loop === true,
				...(rad !== undefined ? { radius: rad } : {}),
				...(speed !== undefined ? { speed } : {}),
			});
		} catch (_) { /* a failed sound relay must never break the frame */ }
	}

	/** ROUND 39 (item 3): catch the LOCAL player's HIT-RECEIVE sound. When an enemy swing
	 * lands on the local player, the engine funnels the material/element hit sound through
	 * ig.SoundHelper.playAtEntity positioned DIRECTLY on the playerEntity — so the old
	 * observers (observeEnemySound = real Enemy only; observePlayerSound = Effect targeted
	 * at the player) both missed it and a member took a normal hit in silence. Relay it on
	 * playerSound; each watcher replays it positioned on our mirror (applyPlayerSound). */
	private observePlayerHitSound(sound: any, entity: any, loop: any, settings: any, radius: any): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('ph.' + t, ...a); } catch (_) { /* ignore */ } };
			if (this._mpReplayingFx) { D('replay'); return; }
			if (!sound || !entity) { D('nolock'); return; }
			const igAny: any = ig as any;
			const me: any = igAny.game && igAny.game.playerEntity;
			if (!me || entity !== me) { D('notme'); return; }                        // positioned ON our player, not an Effect
			if (me._mpMirror || me._mpPuppet) { D('husk'); return; }                // a remote mirror is relayed by its owner
			let path: string = '';
			try { path = (sound.webAudioBuffer && sound.webAudioBuffer.path) || (sound.multiAudio && sound.multiAudio.path) || ''; } catch (_) { path = ''; }
			if (!path || typeof path !== 'string') { D('nopath', this._paeDescribe(sound, entity)); return; }
			const conn = this.main.connection;
			if (!conn || !conn.isOpen() || typeof conn.emitPlayerSound !== 'function') { D('noconn'); return; }
			D('emit', path);
			const volume = (typeof sound.volume === 'number' && isFinite(sound.volume)) ? sound.volume : 1;
			const variance = (typeof sound.variance === 'number' && isFinite(sound.variance)) ? sound.variance : 0;
			const speed = (settings && typeof settings.speed === 'number' && isFinite(settings.speed)) ? settings.speed : undefined;
			const rad = (typeof radius === 'number' && isFinite(radius)) ? radius : undefined;
			conn.emitPlayerSound({
				path, volume, variance,
				loop: loop === true,
				...(rad !== undefined ? { radius: rad } : {}),
				...(speed !== undefined ? { speed } : {}),
			});
		} catch (_) { /* a failed sound relay must never break the frame */ }
	}

	/** ROUND 34 (item 3): replay a remote player's attack sound on our mirror of them.
	 * Mirror of applyEnemySound but the sound positions on the ATTACKER's mirror entity
	 * (main.players[player].entity) instead of an enemy puppet. Rebuild the sound (new
	 * ig.Sound lazily loads its buffer) and play it via the wrapped playAtEntity under the
	 * _mpReplayingFx loop-guard so our own observer never re-emits it. No-op if the mirror
	 * is gone, the packet is for ourselves, or we're mid-cutscene. */
	private applyPlayerSound(s: { player: string, path: string, volume?: number, variance?: number, loop?: boolean, radius?: number, speed?: number }): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('ap.' + t, ...a); } catch (_) { /* ignore */ } };
			if (!s || typeof s.player !== 'string' || !s.player) { D('badpkt'); return; }
			// ROUND 79: raw so every guard-sound packet is visible in one capture.
			this._sfxLogRaw('ap.recv', s.path, 'from=' + s.player, 'loop=' + (s.loop === true));
			if (s.player === this.main.name) { D('self'); return; }              // never replay our own sound back
			if (typeof s.path !== 'string' || !s.path) { D('nopath'); return; }
			if (this.inCutscene) { D('cutscene'); return; }
			const pl: any = this.main.players[s.player];
			const mirror: any = pl && pl.entity;
			if (!mirror || mirror._killed || !mirror.coll) { D('nomirror', 'have=' + (this.main.players ? Object.keys(this.main.players).join(',') : '')); return; }
			const igAny: any = ig as any;
			if (!igAny.Sound || !igAny.SoundHelper || typeof igAny.SoundHelper.playAtEntity !== 'function') { D('noapi'); return; }
			D('play', s.path);
			const volume = (typeof s.volume === 'number' && isFinite(s.volume)) ? s.volume : 1;
			const variance = (typeof s.variance === 'number' && isFinite(s.variance)) ? s.variance : 0;
			const settings: any = {};
			if (typeof s.speed === 'number' && isFinite(s.speed)) settings.speed = s.speed;
			this._mpReplayingFx = true;
			try {
				const snd = new igAny.Sound(s.path, volume, variance);
				const me: any = igAny.game && igAny.game.playerEntity;
				const dme: any = (mirror.coll && me && me.coll)
					? Math.hypot(mirror.coll.pos.x - me.coll.pos.x, mirror.coll.pos.y - me.coll.pos.y) : -1;
				D('playat', s.path, 'dist=' + Math.round(dme), 'mirrorPos=' + (mirror.coll ? Math.round(mirror.coll.pos.x) + ',' + Math.round(mirror.coll.pos.y) : '?'));
				// Round 37 (item 1): _mpReplayingFx actually RESTORES positional play here.
				// showHitEffect plays the guard sound via a NON-positional b.play() (the
				// engine's own k-silent flag is consumed suppressing the double audio), so
				// with no positional override the member hears it at full volume no matter
				// how far the guarding player is. Emit it as a plain unpositioned Sound too
				// (never routed through the showHitEffect wrap, so no loop), then play it AT
				// the guarding player's mirror so it attenuates/pans by real distance.
				if (igAny.SoundHelper && typeof igAny.SoundHelper.playAtEntity === 'function') {
					// ROUND 39 (item 1): capture the returned handle for a SUSTAINED sound
					// (the skill charge-up relays loop:true). A new sustained sound cuts the
					// previous one first (one held charge per player); the soundStop packet
					// then stops this handle on release so the charge can't ring out.
					if (s.loop === true) {
						try { const prev = this._mpSustained[s.player]; if (prev && prev.stop) prev.stop(); } catch (_) { /* ignore */ }
						const h = igAny.SoundHelper.playAtEntity(snd, mirror, true, settings, undefined,
							typeof s.radius === 'number' && isFinite(s.radius) ? s.radius : undefined);
						this._mpSustained[s.player] = h;
					} else {
						igAny.SoundHelper.playAtEntity(snd, mirror, false, settings, undefined,
							typeof s.radius === 'number' && isFinite(s.radius) ? s.radius : undefined);
					}
				} else {
					snd.play();
				}
			} catch (_) { /* the sound is cosmetic — never break the frame */ }
			finally { this._mpReplayingFx = false; }
		} catch (_) { /* a failed sound replay must never crash the frame */ }
	}

	/** ROUND 43 (skill-release sound): a remote player fired a skill whose launch sound
	 * their client silenced (the playAtEntity enemy/ball observer kills skill-projectile
	 * sounds locally and relays nothing). Replay it positioned on the caster's MIRROR so
	 * 回旋斩 / charged shots are audible for the whole instance. Self-drops like
	 * applyPlayerSound (the caster already heard their own native sound before we relayed).
	 * No loop: these are one-shot launch sounds; the sustained charge uses playerSound. */
	private applySkillSound(s: { player: string, path: string, volume?: number, variance?: number, radius?: number, speed?: number }): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('sk.' + t, ...a); } catch (_) { /* ignore */ } };
			if (!s || typeof s.player !== 'string' || !s.player) { D('badpkt'); return; }
			if (s.player === this.main.name) { D('self'); return; }              // caster heard their own already
			if (typeof s.path !== 'string' || !s.path) { D('nopath'); return; }
			if (this.inCutscene) { D('cutscene'); return; }
			const pl: any = this.main.players[s.player];
			const mirror: any = pl && pl.entity;
			if (!mirror || mirror._killed || !mirror.coll) { D('nomirror'); return; }
			const igAny: any = ig as any;
			if (!igAny.Sound || !igAny.SoundHelper || typeof igAny.SoundHelper.playAtEntity !== 'function') { D('noapi'); return; }
			const volume = (typeof s.volume === 'number' && isFinite(s.volume)) ? s.volume : 1;
			const variance = (typeof s.variance === 'number' && isFinite(s.variance)) ? s.variance : 0;
			const settings: any = {};
			if (typeof s.speed === 'number' && isFinite(s.speed)) settings.speed = s.speed;
			this._mpReplayingFx = true;
			try {
				const snd = new igAny.Sound(s.path, volume, variance);
				igAny.SoundHelper.playAtEntity(snd, mirror, false, settings, undefined,
					typeof s.radius === 'number' && isFinite(s.radius) ? s.radius : undefined);
			} catch (_) { /* the sound is cosmetic — never break the frame */ }
			finally { this._mpReplayingFx = false; }
		} catch (_) { /* a failed sound replay must never crash the frame */ }
	}

	/** ROUND 39 (item 1): MEMBER side — a remote player RELEASED a sustained sound
	 * so the charge stops the instant of release (matches the native soundHandle.stop()
	 * in sc.CombatCharge.stop). No-op if we have no live handle for that player. */
	private applySoundStop(player: string): void {
		try {
			if (!player || player === this.main.name) return;
			const h: any = this._mpSustained[player];
			delete this._mpSustained[player];
			if (h && h.stop) h.stop();
		} catch (_) { /* a failed stop must never crash the frame */ }
	}

	/** ROUND 39 (item 1): cut EVERY live sustained-sound handle (map change / cleanup). */
	private clearAllSustained(): void {
		try {
			for (const k in this._mpSustained) {
				try { const h = this._mpSustained[k]; if (h && h.stop) h.stop(); } catch (_) { /* ignore */ }
			}
		} catch (_) { /* ignore */ }
		this._mpSustained = Object.create(null);
	}

	// ---- ROUND 74 (plant destruct sync) ----
	/** The local player just destroyed a map destructible (the ItemDestruct.destroy inject
	 * above calls this). Broadcast its stable mapId so every other same-instance client
	 * destroys its own intact copy. The connector's syncEmit skips the packet while we are
	 * the only member of our instance (pure upload waste). */
	public broadcastPlantBreak(plant: any): void {
		try {
			const mapId = plant && plant.mapId;
			if (!mapId) return;
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			if (typeof conn.plantBreak !== 'function') return;
			conn.plantBreak({ map: this.mapName, mapId });
		} catch (_) { /* never break the destroy chain */ }
	}

	/** A same-instance player destroyed a plant — destroy OUR copy at the same mapId if it
	 * is still intact, through the VANILLA chain so every side effect matches a local
	 * break: dropped anim + boom/debris FX, OUR own drop rolls (dropItem uses the local
	 * player's stats), the propsDestroyed count, the per-mapId respawn var and the trigger
	 * var. Idempotent: an already-dropped / absent plant is a no-op. The enemy-spawn roll
	 * (rare cold-dungeon destructibles) is suppressed on the receiver — the enemy already
	 * spawned on the sender, and a second local spawn would be an unsynced ghost. */
	public applyPlantBreak(data: { map: string, mapId: number }): void {
		try {
			if (!data || typeof data.mapId !== 'number' || !isFinite(data.mapId)) return;
			if (data.map && data.map !== this.mapName) return; // a plant on a map we already left
			const ID: any = (ig.ENTITY as any).ItemDestruct;
			const plant = ig.game && typeof (ig.game as any).getEntityByMapId === 'function'
				? (ig.game as any).getEntityByMapId(Math.round(data.mapId)) : null;
			if (!plant || !(plant instanceof ID)) return;
			if (plant.dropped || plant._killed) return; // already destroyed — nothing to do
			// The vanilla ballHit path counts the destruction before destroy(); destroy()
			// itself doesn't touch the stat, so mirror that count here.
			try { (sc as any).stats.addMap('player', 'propsDestroyed', 1); } catch (_) { /* ignore */ }
			const savedEnemyInfo = plant.enemyInfo;
			const savedEnemyChance = plant.enemyChance;
			plant.enemyInfo = null;
			plant.enemyChance = -1;
			plant._mpSyncedDestroy = true;   // the destroy inject sees this and skips re-broadcast
			try { plant.destroy(); } catch (_) { plant._mpSyncedDestroy = false; }
			plant.enemyInfo = savedEnemyInfo;
			plant.enemyChance = savedEnemyChance;
		} catch (_) { /* never break the frame */ }
	}

	/** MEMBER side — the host reported an enemy sound. Rebuild + play it on our same-uid
	 * puppet. The host relayed {uid,path,volume,variance,loop,global,radius,speed}
	 * (server-whitelisted). Rebuild the sound (new ig.Sound lazily loads its buffer
	 * via ig.Loadable, so it works cross-machine) and play it positioned on our
	 * same-uid puppet via the engine's own ig.SoundHelper.playAtEntity — which is
	 * wrapped, so we run under the _mpReplayingFx loop-guard to keep the observer
	 * from re-emitting our replay. No-op if the puppet is gone or we're the host. */
	private applyEnemySound(s: { uid: number, path: string, volume?: number, variance?: number, loop?: boolean, global?: boolean, radius?: number, speed?: number }): void {
		try {
			const D = (t: string, ...a: any[]) => { try { this._sfxLog('ae.' + t, ...a); } catch (_) { /* ignore */ } };
			if (this.main.host) { D('host'); return; }               // the host played it natively already
			if (!s || typeof s.uid !== 'number' || !(s.uid > 0)) { D('baduid'); return; }
			if (typeof s.path !== 'string' || !s.path) { D('nopath'); return; }
			if (this.inCutscene) { D('cutscene'); return; }
			D('recv', s.path, 'uid=' + s.uid);
			const puppet: any = this.puppets[s.uid];
			if (!puppet || puppet._killed || puppet._mpDying || !puppet.coll) { D('nopuppet', 'uids=' + (this.puppets ? Object.keys(this.puppets).join(',') : '')); return; }
			const igAny: any = ig as any;
			if (!igAny.Sound || !igAny.SoundHelper || typeof igAny.SoundHelper.playAtEntity !== 'function') { D('noapi'); return; }
			D('play', s.path);
			const volume = (typeof s.volume === 'number' && isFinite(s.volume)) ? s.volume : 1;
			const variance = (typeof s.variance === 'number' && isFinite(s.variance)) ? s.variance : 0;
			const settings: any = {};
			if (typeof s.speed === 'number' && isFinite(s.speed)) settings.speed = s.speed;
			this._mpReplayingFx = true;
			try {
				const snd = new igAny.Sound(s.path, volume, variance);
				const me: any = igAny.game && igAny.game.playerEntity;
				const dme: any = (puppet.coll && me && me.coll)
					? Math.hypot(puppet.coll.pos.x - me.coll.pos.x, puppet.coll.pos.y - me.coll.pos.y) : -1;
				D('playat', s.path, 'dist=' + Math.round(dme), 'pupPos=' + (puppet.coll ? Math.round(puppet.coll.pos.x) + ',' + Math.round(puppet.coll.pos.y) : '?'));
				igAny.SoundHelper.playAtEntity(snd, puppet, s.loop === true, settings, undefined,
					typeof s.radius === 'number' && isFinite(s.radius) ? s.radius : undefined);
			} catch (_) { /* the sound is cosmetic — never break the frame */ }
			finally { this._mpReplayingFx = false; }
		} catch (_) { /* a failed sound replay must never crash the frame */ }
	}

	// ------------------------------------------------------------------ outbound
	private tick(): void {
		try {
			// Connection check FIRST: death state must not survive a logout/disconnect
			// (it would pin HP at 0 and keep the spectator camera flag into the next
			// session). Runs even on the title screen (playerEntity may be gone).
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) {
				if (this._mpDead) this.clearDeathState();
				if (this._mpChargeFrozen) this.clearChargeFreeze();
				return;
			}

			const game: any = ig.game;
			if (!game || !game.playerEntity || game.isTeleporting()) return;
			const map = game.mapName || '';
			if (map !== this.mapName) {
				this.mapName = map;
				this.puppets = Object.create(null);
				this.lastAnim = Object.create(null);
				this.pendingTypes = Object.create(null);
				// Round 22 (opt 2) / Round 23 (split): a map change voids both enemy-block
				// deltas — the new map's enemies are unknown to them, so the first block in
				// each stream is FULL (self-heal for anyone who just joined).
				this._mpLastBaseEncoded.clear();
				this._mpLastHostileEncoded.clear();
				this._mpBaseFullAccum = 0;
				this._mpHostileFullAccum = 0;
				this._mpBaseTimer = 0;
				// ROUND 80: the first hostile/projectile blocks on the new map must fire
				// at the configured cadence immediately.
				this.sendTimer = 0;
				this._mpProjSendTimer = 0;
				this._mpBaseLastPlayerCount = -1;
				this._mpHostileLastPlayerCount = -1;
				this._mpUidSeen = Object.create(null);
				this._mpMapSeen = Object.create(null);
				// Round 24: the roster is unknown on the new map until both streams report a
				// full block (stamps below reset), and reaping must wait for the first block.
				this._mpFullBlockSeen = 0;
				this._mpReapTimer = 0;
				this._mpLastBlockAt = Date.now();
				this._mpLastBaseCb = -1;
				this._mpLastHostileCb = -1;
				// ROUND 39 (item 1): a map change strands every live sustained-sound handle
				// (the mirror it was positioned on is gone) — cut them all so a held charge
				// can't keep looping on the new map.
				this.clearAllSustained();
				// Round 19 (Part 3): a map change voids every cutscene puppet (they
				// belong to the map we just left) + cached mirror fade state.
				this.clearCsPuppets();
				// ROUND 85: any door-ignore grace belongs to the old map's doors.
				this._mpDoorIgnoreRestores = [];
				// Round 62: a map change voids every visual projectile copy (they belong
				// to the map we just left).
				this.clearProjectiles();
				this.resetCombatForNewBlock();
				// Round 14 (fix 5): a map change voids every queued dying puppet — kill them
				// silently (kill(true): no loot/FX) and drop the queue. They belong to the
				// map we just left; leaving them frozen would leak half-dead entities.
				try {
					for (const q of this._mpDeathQueue) {
						const de = q && q.e;
						if (de && !de._killed) {
							de._mpTg = false;
							try { de.kill(true); } catch (_) { /* ignore */ }
						}
					}
				} catch (_) { /* ignore */ }
				this._mpDeathQueue = [];
				// Round 10 safety net: if the local player arrives on a new map with
				// the entity still hidden (soft-death hide() slipped through the defer
				// window of a teleport — the "传送到队友身边后实体消失" bug), force it
				// visible again. Only when NOT dead: a legitimately hidden corpse must
				// stay hidden until revive.
				try {
					const pl: any = game.playerEntity;
					if (pl && pl._hidden && !this._mpDead && typeof pl.show === 'function') {
						console.warn('[netsync] player entity hidden after map change — force show');
						pl.show();
					}
				} catch (_) { /* ignore */ }
				// A map change also ends any remote charge freeze state we were holding.
				this.clearChargeFreeze();
				// ...and re-arms the HP-drop monitor (hp can differ across maps).
				this._mpLastLocalHp = -1;
			}

			// Move network-driven entities toward their latest synced position EVERY
			// rendered frame. The host enemy block only arrives ~15x/sec and the
			// playerState stream up to ~60x/sec; this per-frame lerp is what renders
			// synced monsters and player mirrors at full framerate instead of
			// stuttering/jittering. Puppets (member-side) and _mpMirror entities
			// (remote-player mirrors exist on the HOST and members alike) are both
			// handled inside interpolatePuppets.
			this.interpolatePuppets();
			// ROUND 88 (collision-map leak fix): periodically purge any stale
			// (already-removed) entries still sitting in the spatial hash so the
			// collision map can never grow unbounded over a long stay in one area.
			this._mpCollSweepTimer += ig.system.tick;
			if (this._mpCollSweepTimer >= 5) {
				this._mpCollSweepTimer = 0;
				this._mpSweepStaleCollEntries();
			}
			// Round 14 (fix 5): advance member-side delayed-death FX (boom + silent kill).
			this.processDeathQueue();
			// ROUND 27 (item 4): the round-26 PURELY LOCAL member-side monster-hit
			// detection (processLocalEnemyHits) is REMOVED. It was the source of the
			// phantom "enemy damages you without attacking / at any distance" damage —
			// the member's hand-rolled geometry + guard formula could never match the
			// host's real combat state. Monster→member damage is now computed ONLY on
			// the host (recomputeHostMonsterHit) and applied here via applyCombatHit.
			// Round 23: ~500ms member-side stale-puppet reap (replaces the old per-block
			// reap — a dead host enemy now clears on the member within ~600ms instead of
			// on the next block, but a single dropped block can no longer reap a live one).
			this._mpReapTimer += ig.system.tick;
			if (this._mpReapTimer >= 0.5) {
				this._mpReapTimer = 0;
				this.reapStalePuppets();
			}
			// Round 62: member-side stale projectile reap (~150ms). Projectiles are
			// short-lived and the host sends no empty blocks, so absence in the stream
			// is what tells us a projectile died on the host.
			if (!this.main.host) {
				this._mpProjReapTimer += ig.system.tick;
				if (this._mpProjReapTimer >= 0.15) {
					this._mpProjReapTimer = 0;
					this.reapStaleProjectiles();
				}
			}
			// ROUND 85: restore remote door ignoreCollision flags whose grace expired.
			this._mpUpdateDoorIgnores();
			// Round 19 (Part 2): the single per-frame fade + collision pass for remote
			// mirrors (cutscene fade, both directions + shared-town IGNORE).
			this.updateRemoteMirrorFade();

			// Own-player death/respawn monitor (host AND member — each client owns
			// its own player's death).
			this.checkOwnDeath();

			// Round 11: being hit while the bag is open must auto-close the bag.
			this.checkMenuCloseOnHit();

			this.sendPlayerState();
			if (this.main.host) {
				// Main-city refactor: towns have no enemies — skip the enemy/projectile
				// blocks entirely (the host streams only playerState there).
				if (!isSharedTownNow()) {
					this.sendEnemyBlock();
					// Round 62: host streams its live enemy projectiles so members see the
					// enemy's ranged attacks (Ball/Stone flying toward them).
					this.sendProjectileBlock();
				}
				// Round 14 (fix 1): combat re-evaluation for the host. sc.model.combatMode is
				// only re-computed via the LOCAL player's _addTargetedBy/_removeTargetedBy ->
				// updateCombatMode(), but enemies that de-aggro a REMOTE player's MIRROR never
				// touch the local player — when the last such enemy leaves activeCombatants the
				// mode latches true forever (host streams cb=1, every member held in combat).
				// Periodically re-check and clear-only (never force combat ON).
				this._mpCombatEvalTimer = (this._mpCombatEvalTimer || 0) + ig.system.tick;
				if (this._mpCombatEvalTimer >= 0.5) {
					this._mpCombatEvalTimer = 0;
					try {
						const mdl: any = (sc as any).model;
						const cmb: any = (sc as any).combat; // sc.combat (matches the onKill fix style)
						if (mdl && mdl.isCombatMode && mdl.isCombatMode()
							&& cmb && typeof cmb.isPlayerPartyInCombat === 'function'
							&& !cmb.isPlayerPartyInCombat()) {
							mdl.setCombatMode(false);
						}
					} catch (_) { /* ignore */ }
				}
			}
			// Round 19 (Part 3, step 3): members stream their own cutscene-spawned
			// monsters so other members render them as csPuppets (~15Hz, presence-
			// driven). Hosts no-op (their story enemies sync via the normal block).
			if (!this.main.host && !isSharedTownNow()) this.sendCutsceneEntityBlock();
			// Round 10: keep the party charge time-stop in lockstep with reality —
			// engages when ANY party member starts charging, releases when the LAST
			// one lets go (see updateChargeFreeze).
			this.updateChargeFreeze();
		} catch (e) { /* never let sync crash the frame */ }
	}

	/** Hard-reset all death/spectator state (used when the connection drops while
	 * dead — logout to title or mid-game disconnect). Everything is guarded because
	 * the player entity / camera may already be gone. */
	private clearDeathState(): void {
		this._mpDead = false;
		this._mpAllDeadAt = 0;
		this._mpCheckpointReloading = false;
		this._mpCorpseHidden = false;
		this.restoreMouseBindings();
		this.removeDeathGui();
		try {
			const igAny: any = ig;
			if (this._mpSpecHandle && igAny.camera && igAny.camera.removeTarget) {
				try { igAny.camera.removeTarget(this._mpSpecHandle, 'IMMEDIATELY'); } catch (_) { /* ignore */ }
			}
			this._mpSpecHandle = null;
			this._mpSpecEntity = null;
			const p: any = ig.game && ig.game.playerEntity;
			if (this._mpPlayerCamDetached && p && p.cameraHandle && igAny.camera && igAny.camera.pushTarget) {
				// Same duplication guard as respawn(): a map load may have pushed a
				// fresh player handle already.
				let already = false;
				try { already = !!(igAny.camera.targets && igAny.camera.targets.indexOf(p.cameraHandle) !== -1); } catch (_) { /* ignore */ }
				if (!already) {
					try { igAny.camera.pushTarget(p.cameraHandle, 'IMMEDIATELY'); } catch (_) { /* ignore */ }
				}
			}
			this._mpPlayerCamDetached = false;
			// Restore collision type (engine death flow flips it to IGNORE).
			try { if (p && p.coll) p.coll.type = (this._mpDeathCollType != null) ? this._mpDeathCollType : igAny.COLLTYPE.VIRTUAL; } catch (_) { /* ignore */ }
			// Bring the entity back (hidden in enterDeath) and clear lingering effects.
			try { if (p && typeof p.show === 'function') p.show(); } catch (_) { /* ignore */ }
			// Round 13: the death boom's CHANGE_ALPHA step can leave animState.alpha at 0
			// (see enterDeath); a disconnect-cleanup must not hand the player back
			// invisible, so restore alpha alongside the show().
			try { if (p && p.animState) p.animState.alpha = 1; } catch (_) { /* ignore */ }
			try {
				const et: any = (ig as any).EffectTools;
				if (p && et && typeof et.clearEffects === 'function') et.clearEffects(p);
			} catch (_) { /* ignore */ }
			// Don't leave the player dead for the next session. Same engine-level
			// revive as respawn(): clear the manualKill death-hold, reset dying, and
			// params.revive() — a plain currentHp write would leave params.defeated
			// latched and the game would still treat the player as dead at full HP.
			// Only when actually dead: revive(1) tops HP to max, and we don't want a
			// disconnect while alive to double as a free full heal.
			try {
				if (p && p.params && (p.params.currentHp <= 0 || p.params.defeated)) {
					p.manualKill = null;
					p.dying = 0; // sc.DYING_STATE.ALIVE
					if (typeof p.params.revive === 'function') p.params.revive(1);
					else {
						p.params.defeated = false;
						const maxHp = p.params.getStat ? p.params.getStat('hp') : 0;
						p.params.currentHp = maxHp > 0 ? maxHp : 1;
					}
				} else if (p) {
					p.manualKill = null; // death-hold armed but hp already restored elsewhere
				}
			} catch (_) { /* ignore */ }
			try { if (p) p.invincibleTimer = 0; } catch (_) { /* ignore */ }
		} catch (_) { /* ignore */ }
		this._mpDeathCollType = null;
		this._mpDeathPos = null;
		this._mpDeathMap = '';
		console.log('[multiplayer] connection closed — death state cleared');
	}

	private sendPlayerState(): void {
		const p: any = ig.game.playerEntity;
		if (!p || !p.coll) return;
		// While dead, stream the pinned death pose: the local corpse is reverted
		// to the death spot each frame, and teammates' mirrors must not wander.
		const pos = (this._mpDead && this._mpDeathPos) ? this._mpDeathPos
			: { x: p.coll.pos.x, y: p.coll.pos.y, z: p.coll.pos.z };
		// Solo-instance optimization: while we are the ONLY member of our instance the
		// full playerState stream is suppressed (see SocketIoConnector.syncEmit). Keep a
		// ~1Hz minimal {pos} beacon instead so the server's memberPos cache stays fresh
		// for late-joiner spawn placement + party regroup, without re-enabling the whole
		// stream. The bare {pos} playerState is harmless even if it ever reaches a member
		// (it only nudges position).
		if (this.main.isSoloInstance()) {
			const beaconNow = Date.now();
			if (beaconNow - this._mpSoloBeaconAt >= 1000) {
				this._mpSoloBeaconAt = beaconNow;
				this.main.connection.updatePlayerPosition(pos);
			}
			return;
		}
		// No anim updates while dead: the mirror keeps its last pose instead of
		// mirroring the corpse's local input-driven walk cycle.
		const anim = this._mpDead ? '' : (typeof p.currentAnim === 'string' ? p.currentAnim : '');
		const face = p.face || { x: 0, y: 1 };
		const params = p.params || {};
		// Round 22 (opt 3): quantize pos to integers — matches the enemy block's
		// Math.round style and shrinks the payload (a mirror lerps between targets
		// every rendered frame, so integer granularity is invisible).
		const snap: any = {
			pos: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
			face: { x: face.x, y: face.y },
			anim,
			// Death flag: teammates remove our mirror while we're dead (a corpse
			// standing frozen in place reads as a bug — the player should visibly
			// be GONE until respawn).
			dead: this._mpDead ? 1 : 0,
			hp: params.currentHp, maxHp: params.getStat ? params.getStat('hp') : 0,
			// Round 22 (opt 3): quantize sp/maxSp to integers. SP regen ticks move
			// currentSp smoothly every frame — integer quantization keeps the
			// change-gate from firing on every regen tick (a whole SP point = one
			// send) while the party HUD only ever displays whole SP anyway.
			sp: Math.round(params.currentSp || 0), maxSp: Math.round(params.maxSp || 0),
			// Round 10: skill/ball charge flag — drives the party-wide charge
			// time-stop on every client (charging.time >= 0 = charging; vanilla
			// accumulates it in REAL time even while the world is slowed).
			cg: this.localCharging() ? 1 : 0,
			// Round 11: element mode + class drive the element-tinted, class-correct
			// melee sweep visuals on every mirror (see spawnAttackFxForAnim).
			em: this.localElementMode(),
			cl: this.localPlayerClass(),
			// ROUND 104: fall/water flag — observers grant the mirror a short
			// aggro grace while the owner quick-falls/respawns.
			fl: this.localOverFallTerrain() ? 1 : 0,
			// Round 19 (Part 1): cutscene flag — teammates fade our mirror + dim our
			// name tag while we're in a story sequence, and skip aggro targeting us.
			cs: (sc as any).model && (sc as any).model.isCutscene ? ((sc as any).model.isCutscene() ? 1 : 0) : 0,
		};
		// ---- Round 27 (item 4): guard state for the HOST-authoritative damage model ----
		// The host judges damage/guard/perfect-guard against our mirror, so it needs our
		// live guard flag + defense + guard modifiers. `gd` = currently guarding (the
		// same currentAnim==='guard' signal syncGuardFx keys off); `gst` = guard-start ms
		// (the perfect-guard window anchor); `gw`/`gm`/`ga` = PERFECT_GUARD_WINDOW /
		// GUARD_STRENGTH / GUARD_AREA modifiers; `def` = our real defense (the mirror is
		// an Enemy-typed 'multiplayer' husk, NOT our player params, so the host cannot
		// read these off the entity). Packed on the FULL snap so the change-gate + floor
		// re-send them; the WIRE payload omits gst/gw/gm/ga when unchanged (opt 3 style).
		try {
			const guarding = (anim === 'guard') ? 1 : 0;
			snap.gd = guarding;
			// ROUND 31 (item 1d): stream the guard press time as a REMAINING-window duration,
			// not a wall-clock timestamp. The old `gst = Date.now()` (member clock) was compared
			// against the HOST's `now - gst` in recomputeHostMonsterHit — two unsynchronised
			// machines differ by arbitrary seconds, so any skew >= the ~0.1-0.25s window made
			// perfect guard deterministically impossible (host clock ahead) or always-on (host
			// behind). Instead send how much of the perfect window is still open RIGHT NOW
			// (member-local, self-consistent); the host counts it down from receipt. gst is a
			// small float (~win at press -> 0 at expiry), never a stale cross-machine clock.
			let gstSend = 0;
			if (guarding) {
				// ROUND 33 (item 1): fall back to the live PERFECT_GUARD_WINDOW modifier
				// when the captured window is absent. The addShield fallback above covers
				// cooldown-presses; this belt-and-suspenders covers a guard entered by a
				// path that never ran addShield on this client (e.g. re-entering guard
				// from a charge), so a guarding player NEVER streams a 0 window.
				let win = (typeof this._mpGuardWindowSec === 'number' && this._mpGuardWindowSec > 0) ? this._mpGuardWindowSec : 0;
				if (!(win > 0)) {
					try {
						if (p.params && typeof p.params.getModifier === 'function') {
							const gwMod = Number(p.params.getModifier('PERFECT_GUARD_WINDOW')) || 0;
							win = 0.1 * (1 + gwMod);
						} else { win = 0.1; }
					} catch (_) { win = 0.1; }
				}
				if (win > 0 && this._mpGuardStartMs > 0) {
					const remMs = (this._mpGuardStartMs + win * 1000) - Date.now();
					gstSend = Math.max(0, Math.round(remMs) / 1000);
				}
			}
			snap.gst = gstSend;
			snap.gws = guarding ? Math.round((this._mpGuardWindowSec || 0) * 1000) / 1000 : 0;
			let gw = 0, gm = 0, ga = 0, def = 0;
			try {
				if (p.params && typeof p.params.getModifier === 'function') {
					gw = Number(p.params.getModifier('PERFECT_GUARD_WINDOW')) || 0;
					gm = Number(p.params.getModifier('GUARD_STRENGTH')) || 0;
					ga = Number(p.params.getModifier('GUARD_AREA')) || 0;
				}
				if (p.params && typeof p.params.getStat === 'function') {
					def = Math.max(0, Math.round(Number(p.params.getStat('defense')) || 0));
				}
			} catch (_) { /* keep zeros on any read failure */ }
			snap.gw = Math.round(gw * 100) / 100;
			snap.gm = Math.round(gm * 100) / 100;
			snap.ga = Math.round(ga * 100) / 100;
			snap.def = def;
			// ROUND 79 (crit fix): stream our real focus so the host can roll the enemy's
			// crit against it - the mirror husk's focus (~40) skews the engine's roll.
			let fc = 0;
			try {
				if (p.params && typeof p.params.getStat === 'function') {
					fc = Math.max(0, Math.round(Number(p.params.getStat('focus')) || 0));
				}
			} catch (_) { /* keep 0 */ }
			snap.fc = fc;
			// ROUND 78 (vanilla damage law): stream the member's element factors + params
			// damageFactor so the host's recompute can apply the engine's exact g factor
			// (victim damageFactor × element factor) against the member's real gear.
			let ef: number[] = [];
			let df = 1;
			try {
				if (p.params) {
					if (typeof p.params.getStat === 'function') {
						const efRaw = p.params.getStat('elemFactor');
						if (Array.isArray(efRaw)) {
							ef = [];
							for (let i = 0; i < efRaw.length; i++) {
								const v = Number(efRaw[i]);
								ef.push(isFinite(v) ? Math.round(v * 100) / 100 : 1);
							}
						}
					}
					if (typeof p.params.damageFactor === 'number') df = Math.round(p.params.damageFactor * 100) / 100;
				}
			} catch (_) { /* keep defaults */ }
			snap.ef = ef;
			snap.df = df;
			// Change-gate the guard EDGE (press / release) so the host sees it at network
			// latency instead of waiting for the 10Hz floor. tok folds in the guard bit
			// (×1000) plus defense, so any guard-edge or defense change flips tok, bumps
			// the token, and shouldSendPlayerState fires immediately on the ggt diff.
			// _mpGuardLastSent always ends the frame equal to the current tok, so a static
			// guard state never re-bumps — only a genuine change does.
			const tok = guarding * 1000 + Math.min(999, def);
			if (tok !== this._mpGuardLastSent) { this._mpGuardLastSent = tok; this._mpGuardGateToken++; }
			snap.ggt = this._mpGuardGateToken;
		} catch (_) { /* never break the state packet */ }
		// Round 22 (opt 1) / Round 23 (hot-apply): cap + change-gate. A full packet every
		// `getPlayerStateMs()` (the option-driven 10/20/30/60Hz floor, hot-applied live),
		// plus IMMEDIATE packets between floors whenever an important field changed vs
		// what we last sent.
		const now = Date.now();
		// Main-city refactor: in a shared town, position streams at 10Hz while the heavy
		// player state (hp/sp/etc.) streams at 1Hz, so a 32-player room stays cheap. This
		// bypasses the normal change-gated floor below.
		if (isSharedTownNow()) {
			if (now - this._mpLastPlayerStateAt < 100) return; // 10Hz position floor
			const includeState = (now - (this._mpTownStateAt || 0)) >= 1000;
			const out: any = {
				pos: snap.pos, face: snap.face, anim: snap.anim, dead: snap.dead,
				cs: snap.cs, cg: snap.cg,
			};
			if (includeState) {
				out.hp = snap.hp; out.maxHp = snap.maxHp; out.sp = snap.sp; out.maxSp = snap.maxSp;
				out.em = snap.em; out.cl = snap.cl;
				out.gd = snap.gd; out.gst = snap.gst; out.gws = snap.gws;
				out.gw = snap.gw; out.gm = snap.gm; out.ga = snap.ga; out.def = snap.def; out.ggt = snap.ggt;
				out.ef = snap.ef; out.df = snap.df; out.fc = snap.fc;
				this._mpTownStateAt = now;
			}
			this._mpLastPlayerStateAt = now;
			this._mpLastPlayerStateSnap = snap;
			this.main.connection.updatePlayerState(out);
			return;
		}
		const prev = this._mpLastPlayerStateSnap;
		if (!this.shouldSendPlayerState(now, snap)) return;
		this._mpLastPlayerStateAt = now;
		this._mpLastPlayerStateSnap = snap;
		// Round 22 (opt 3): em/cl change rarely (element mode / combat class) — omit
		// them from the WIRE payload when unchanged since the last send. The receiver
		// only applies them when present (typeof guards) and falls back to its cached
		// mirror values for the sweep FX. Store the FULL snap above for the change-gate.
		const out: any = { ...snap };
		if (prev && prev.em === snap.em) delete out.em;
		if (prev && prev.cl === snap.cl) delete out.cl;
		// Round 27 (item 4): guard state + timing + the host's damage-recompute inputs
		// (gw/gm/ga/def/fc/ef/df). `gst` re-arms on every guard PRESS, so it is always
		// meaningful.
		// ROUND 79 (item, cache-coherence fix): gw/gm/ga/def/fc/ef/df are now sent on
		// EVERY playerState packet - the omission gate is GONE. It was the root cause of
		// the "member takes different damage" report: the packet that SPAWNED the host's
		// mirror never stashed the fields (the spawn branch skipped the entity-apply
		// block), and every later packet omitted them as "unchanged", so a fresh mirror
		// NEVER learned def/gm/ga/df/ef/fc - the host silently recomputed with the husk's
		// def 40 (member def 26 -> base 19.5 instead of 32.2) and no element/crit data.
		// ROUND 65 tried to patch this with a map-change force-send, but the common cases
		// (fresh spawn at join, mirror respawn after death) are NOT map changes. The
		// fields are ~40 bytes total - always sending them is cheap insurance that every
		// mirror, whenever it (re)spawns, is fully learned within one packet (~100ms).
		this.main.connection.updatePlayerState(out);
	}

	/** Round 22 (opt 1) / Round 23 (hot-apply): decide whether to EMIT a playerState
	 * packet now. Enforces a FLOOR at the option-driven send rate — every
	 * `getPlayerStateMs()` the full state always goes out, preserving the whole-state
	 * self-healing contract (never pure-delta). The option is read LIVE each tick, so
	 * changing it in the options tab hot-applies on the next packet. Between floors we
	 * send IMMEDIATELY when an important field changed vs the last-sent snapshot:
	 * dead/hp/maxHp/sp/maxSp/cg/cs/em/cl/anim, any face component, or the position
	 * moved > 4px euclidean (XY). `now` = Date.now(); `snap` = the freshly-packed
	 * (rounded) state. */
	private shouldSendPlayerState(now: number, snap: any): boolean {
		if (now - this._mpLastPlayerStateAt >= this.main.getPlayerStateMs()) return true;
		const prev = this._mpLastPlayerStateSnap;
		if (!prev) return true;
		if (snap.dead !== prev.dead) return true;
		if (snap.hp !== prev.hp) return true;
		if (snap.maxHp !== prev.maxHp) return true;
		if (snap.sp !== prev.sp) return true;
		if (snap.maxSp !== prev.maxSp) return true;
		if (snap.cg !== prev.cg) return true;
		if (snap.cs !== prev.cs) return true;
		if (snap.em !== prev.em) return true;
		if (snap.cl !== prev.cl) return true;
		if (snap.anim !== prev.anim) return true;
		if (snap.ggt !== prev.ggt) return true; // Round 27 (item 4): guard edge / defense change
		if (snap.face && prev.face && (snap.face.x !== prev.face.x || snap.face.y !== prev.face.y)) return true;
		if (snap.pos && prev.pos) {
			const dx = snap.pos.x - prev.pos.x;
			const dy = snap.pos.y - prev.pos.y;
			if (dx * dx + dy * dy > 16) return true; // euclidean XY > 4px
		}
		return false;
	}

	/** Round 11: the local player's current element mode (sc.ELEMENT 0-4). This is
	 * the exact value the engine's COMBAT_SWEEP step reads via getElementMode. */
	private localElementMode(): number {
		try {
			const pm: any = (sc as any).model && (sc as any).model.player;
			const em = pm && pm.currentElementMode;
			return (typeof em === 'number' && em >= 0 && em <= 4) ? em : 0;
		} catch (_) { return 0; }
	}

	/** Round 11: the local player's combat class string ("SPHEROMANCER"/"TRIBLADER"/
	 * "QUADROGUARD") — picks the COMBAT_SWEEPS sheet family on mirrors. */
	private localPlayerClass(): string {
		try {
			const pm: any = (sc as any).model && (sc as any).model.player;
			const cfg = pm && pm.config;
			const cl = cfg && (cfg.clazz || cfg['class']);
			return (typeof cl === 'string') ? cl : '';
		} catch (_) { return ''; }
	}

	// ---- skill effect sync (round 11) ----

	/** Cached EffectSheets on the receiving side (new ig.EffectSheet per path). */
	private _fxSheets: { [path: string]: any } = {};
	/** Fix 3: cached guard-dome sheet (same "guard" sheet the owner's GUARD action
	 * uses; loaded once and shared across mirrors). */
	private _guardSheet: any = null;
	/** Round 16 (issue 7, fix 1d): true while _guardSheet.load() is in flight. The
	 * guard sheet may not be resident yet, and every guard playerState packet calls
	 * sheet.load() — each = a fresh $.ajax until the first load completes. The latch
	 * skips those concurrent redundant loads; the load callback (JsonLoadable fires it
	 * on BOTH success and failure) clears it. */
	private _mpGuardSheetLoading = false;

	/** LOCAL player just cast a skill effect (from the EffectSheet wrap): send the
	 * sheet path + key to the instance so teammates replay it on our mirror. Params
	 * are whitelisted to serializable fields — callbacks and entity-valued target2
	 * references can't cross the wire (the receiver re-targets the effect at the
	 * mirror via spawnOnTarget anyway). */
	public broadcastSkillFx(sheetPath: string, key: string, fixed: { x: number, y: number, z: number } | null, params: any): void {
		try {
			if (!this.main.connection || !this.main.connection.isOpen()) return;
			if (this._mpDead) return;
			const p: any = {};
			if (params && typeof params === 'object') {
				const keep = ['target2Align', 'target2Offset', 'offset', 'rotOffset', 'align',
					'angle', 'flipX', 'rotateFace', 'flipLeftFace', 'duration', 'group', 'noMultiGroup'];
				for (const k of keep) if (params[k] !== undefined) p[k] = params[k];
			}
			this.main.connection.skillFx({ sheet: sheetPath, key, f: fixed, p });
		} catch (_) { /* ignore */ }
	}

	/** A remote player cast a skill: replay the effect on their mirror (or at the
	 * fixed world position for spawnFixed effects). Sheet loads are cached and
	 * async-safe — the first replay of a not-yet-resident sheet arrives one frame
	 * late, which is invisible at LAN latency. */
	private applySkillFx(player: string, fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }): void {
		try {
			if (!fx || !fx.sheet || !fx.key || player === this.main.name) return;
			const ES: any = (ig as any).EffectSheet;
			if (!ES) return;
			let sheet = this._fxSheets[fx.sheet];
			if (!sheet) { sheet = this._fxSheets[fx.sheet] = new ES(fx.sheet); }
			sheet.load(() => {
				try {
					if (!sheet.loaded) return;
					const pl = this.main.players[player];
					const mirror = pl && pl.entity;
					if (fx.f) {
						sheet.spawnFixed(fx.key, fx.f.x, fx.f.y, fx.f.z, (mirror && !mirror._killed) ? mirror : null, fx.p || {});
					} else if (mirror && !mirror._killed) {
						sheet.spawnOnTarget(fx.key, mirror, fx.p || {});
					}
				} catch (_) { /* visuals must never break sync */ }
			});
		} catch (_) { /* ignore */ }
	}

	/** Fix 3: replay the guard dome on a remote player's mirror. The mirror's
	 * animSheet already has the `guard` pose, so the pose shows — only the dome
	 * overlay is missing. Keyed off s.anim === 'guard' (the owner's currentAnim is
	 * literally 'guard' while the GUARD action runs). One persistent handle per mirror
	 * (`_mpGuardFx`); the attached effect dies with the entity on kill. Only the
	 * 'neutral' key (crack tiers need the unsynced guard.damage state). */
	private syncGuardFx(ent: any, anim: string): void {
		try {
			if (!ent) return;
			if (ent._killed) { ent._mpGuardFx = null; return; }
			if (anim === 'guard') {
				if (!ent._mpGuardFx) {
					if (!this._guardSheet) {
						const ES: any = (ig as any).EffectSheet;
						if (!ES) return;
						this._guardSheet = new ES('guard');
					}
					const sheet = this._guardSheet;
					// Round 16 (issue 7, fix 1d): if the sheet is still loading (async
					// $.ajax), a second guard playerState must not fire a redundant load —
					// each would be a fresh request until the first one completes. Skip while
					// the latch is set; the load callback clears it (fires on success/failure).
					if (this._mpGuardSheetLoading) return;
					this._mpGuardSheetLoading = true;
					sheet.load(() => {
						this._mpGuardSheetLoading = false;
						try {
							// Load is async: only spawn if the mirror is still guarding
							// and alive (a non-guard state after this clears it).
							if (!sheet.loaded || ent._killed || ent._mpLastAnim !== 'guard') return;
							if (!ent._mpGuardFx && typeof sheet.spawnOnTarget === 'function') {
								ent._mpGuardFx = sheet.spawnOnTarget('neutral', ent, { duration: -1 });
							}
						} catch (_) { /* ignore */ }
					});
				}
			} else if (ent._mpGuardFx) {
				try { ent._mpGuardFx.stop(); } catch (_) { /* ignore */ }
				ent._mpGuardFx = null;
			}
		} catch (_) { /* visuals must never break sync */ }
	}

	/** Fix 3: replay the owner's dash-dust burst on their mirror. Matches the owner's
	 * SHOW_EFFECT dust/line — a no-op if the dust sheet isn't resident (the engine
	 * no-ops the same way on the owner side). */
	private syncDashFx(ent: any, anim: string): void {
		try {
			if (!ent || ent._killed || anim !== 'dash') return;
			const g: any = ig.game;
			const dust = g && g.effects && g.effects.dust;
			if (dust && typeof dust.spawnOnTarget === 'function') {
				dust.spawnOnTarget('line', ent, { duration: 0.2, align: 'BOTTOM', offset: { x: 0, y: 3, z: 6 } });
			}
		} catch (_) { /* visuals must never break sync */ }
	}

	/** Fix 3: replay the owner's element-mode switch burst on their mirror. Mirrors
	 * the engine's sc.combat.showModeChange call (combat.effects.mode sheet, key per
	 * element, group 'modeChange'); the engine clears prior modeChange effects first,
	 * so we do the same via ig.EffectTools.clearEffects(entity, 'modeChange'). */
	private syncModeChangeFx(ent: any, em: number): void {
		try {
			if (!ent || ent._killed) return;
			const combat: any = (sc as any).combat;
			if (!combat || !combat.effects || !combat.effects.mode) return;
			if (typeof combat.effects.mode.spawnOnTarget !== 'function') return;
			const key = ['neutral', 'heat', 'cold', 'shock', 'wave'][em] || 'neutral';
			try {
				const et: any = (ig as any).EffectTools;
				if (et && typeof et.clearEffects === 'function') et.clearEffects(ent, 'modeChange');
			} catch (_) { /* clear is best-effort */ }
			combat.effects.mode.spawnOnTarget(key, ent, { duration: 0, align: 'BOTTOM', group: 'modeChange', offset: { x: 0, y: 0, z: 16 } });
		} catch (_) { /* visuals must never break sync */ }
	}

	// ---- round 16 (issue 4): party-size monster HP scaling (HOST side only) ----
	//
	// The server sends `hpScale` = the extra max-HP fraction per ADDITIONAL party
	// member (handshakeResponse, config monsterHpPerPlayer, default 0.5). The HOST
	// scales every enemy it spawns:  maxHp' = maxHp * (1 + hpScale * (partySize - 1)),
	// currentHp' = currentHp * the same factor (spawns full at the scaled value).
	// Members NEVER scale — their puppets are locked mirrors of host enemies, and the
	// host streams the authoritative (already-scaled) HP via the entityState block
	// (`m` = maxHp, `h` = currentHp).

	/** Store the server-provided per-extra-member HP fraction (clamped [0, 10]). */
	public setHpScale(f: number): void {
		let v = (typeof f === 'number' && isFinite(f)) ? f : 0.5;
		v = Math.max(0, Math.min(10, v));
		this._mpHpScale = v;
	}

	/** Round 21: set the host enemy-block send interval (seconds). Ignored unless
	 * finite and > 0; sendTimer is zeroed so the new cadence applies immediately on
	 * the next host-side tick. Latched by multiplayer.getHostTickInterval at
	 * host-acquire — never called live. */
	public setBlockInterval(sec: number): void {
		if (isFinite(sec) && sec > 0) {
			this.blockInterval = sec;
			this.sendTimer = 0;
			// ROUND 80 (projectile cadence): the enemy-projectile stream must follow
			// the same option-driven host frequency. Re-arm its accumulator too —
			// otherwise a host re-acquire / live option change keeps the OLD cadence
			// until the previous timer expires (or indefinitely, if the timer was
			// armed before the latch).
			this._mpProjSendTimer = 0;
			// ROUND 81 (item tick fix): the net-debug HUD no longer needs the
			// configured cadence — the connector now measures the real H/B tick from
			// the stream-tagged blocks (updateEntityStateBlock's 5th arg).
		}
	}

	/** The HOST's current party-size HP multiplier = 1 + hpScale * (partySize - 1).
	 * partySize counts every party member INCLUDING native bots (bots are party
	 * members on the server and fight too). No party / size <= 1 -> 1 (no scaling). */
	private currentHpMultiplier(): number {
		try {
			const pm = this.main.partyMembers;
			const bots = this.main.partyBots;
			const size = (pm && pm.length || 0) + (bots && bots.length || 0);
			if (size <= 1) return 1;
			return 1 + this._mpHpScale * (size - 1);
		} catch (_) { return 1; }
	}

	/** HOST side: scale a freshly-spawned enemy's max + current HP by the party-size
	 * multiplier so it spawns full at the scaled value. Called from the
	 * EnemyType.initEntity inject — engine-verified (game.compiled.js): initEntity is
	 * the ONE construct hook that runs AFTER params are populated
	 * (`a.params=new sc.CombatParams(this.params); ...this.updateParams(a)`; a
	 * non-WM Enemy's params stay null until this runs lazily on its first update).
	 * Max HP lives in params.baseParams.hp (read via params.getStat('hp')); current
	 * HP in params.currentHp. `_mpHpScaled` marks the entity so the scale is never
	 * applied twice (initEntity is also reachable via show/changeState). */
	private applyHpScaleOnSpawn(e: any): void {
		try {
			if (!e || e._mpHpScaled || !e.params || e._mpMirror || e._killed) return;
			const p: any = e.params;
			const maxHp = (typeof p.getStat === 'function') ? p.getStat('hp') : (p.baseParams && p.baseParams.hp);
			if (typeof maxHp !== 'number' || maxHp <= 0) { e._mpHpScaled = 1; return; }
			const mult = this.currentHpMultiplier();
			if (mult > 1) {
				const newMax = Math.round(maxHp * mult);
				if (p.baseParams) p.baseParams.hp = newMax;              // max HP (getStat('hp'))
				const cur = (typeof p.currentHp === 'number') ? p.currentHp : maxHp;
				p.currentHp = Math.round(cur * mult);                    // current HP (spawns full)
				// element-mode enemies carry per-element param copies that setElementMode
				// re-applies — scale those hp values too so a mode switch keeps the scaled max.
				if (e.elementModes && e.elementModes.modes) {
					for (const k in e.elementModes.modes) {
						const md = e.elementModes.modes[k];
						if (md && typeof md.hp === 'number') md.hp = Math.round(md.hp * mult);
					}
				}
				// Round 18 (issue 1): the round-16 scale writes above run AFTER
				// EnemyType.initEntity's parent() already snapped the in-world StatusBar to
				// the UNSCALED hp in initWithParams — the bar caches U while max became S, so
				// it rendered U/S (~66% in a 2-player party) until the first real hit's
				// HP_CHANGED re-synced it (the dive-then-climb). Re-snap the bar instantly to
				// the scaled value — the same engine call modelChanged uses on STATS_CHANGED.
				// NOT initWithParams: that re-registers observers and has side effects.
				try { if ((e as any).statusGui && typeof (e as any).statusGui.setHp === 'function') (e as any).statusGui.setHp(p.currentHp, true); } catch (_) { /* best-effort */ }
			}
			e._mpHpScaled = mult;
		} catch (_) { /* never break an enemy spawn */ }
	}

	/** HOST side: party-size changed mid-fight (join/leave while we're on a map).
	 * Walk the live host enemies on the current map and proportionally adjust current
	 * HP + max HP from the stored old factor (_mpHpScaled) to the new one
	 * (newHp = hp * newFactor / oldFactor). Keeps hp <= new max, never below 1 unless
	 * already dead. Members no-op (their puppets mirror host enemies). */
	public rescaleLiveEnemies(): void {
		try {
			if (!this.main.host) return;
			const mult = this.currentHpMultiplier();
			const g: any = ig.game;
			const list = g && g.entities;
			if (!list) return;
			const Enemy = (ig.ENTITY as any).Enemy;
			for (let i = 0; i < list.length; i++) {
				const e: any = list[i];
				if (!(e instanceof Enemy) || e._mpMirror || e._killed || !e.params) continue;
				const oldF = e._mpHpScaled;
				if (typeof oldF !== 'number' || oldF <= 0 || oldF === mult) continue;
				const p: any = e.params;
				if (typeof p.currentHp === 'number' && p.currentHp <= 0) continue; // already dead
				const maxHp = (typeof p.getStat === 'function') ? p.getStat('hp') : (p.baseParams && p.baseParams.hp);
				if (typeof maxHp !== 'number' || maxHp <= 0) continue;
				const newMax = Math.max(1, Math.round(maxHp * mult / oldF));
				if (p.baseParams) p.baseParams.hp = newMax;
				const cur = (typeof p.currentHp === 'number') ? p.currentHp : maxHp;
				p.currentHp = Math.min(newMax, Math.max(1, Math.round(cur * mult / oldF)));
				// Round 18 (issue 1): the direct currentHp write above leaves the in-world
				// StatusBar desynced (it only re-reads via model observer notifications) —
				// covers mid-fight join/leave AND party shrinking to solo. Re-snap it.
				try { if ((e as any).statusGui && typeof (e as any).statusGui.setHp === 'function') (e as any).statusGui.setHp(p.currentHp, true); } catch (_) { /* best-effort */ }
				e._mpHpScaled = mult;
			}
		} catch (_) { /* never break the frame */ }
	}

	/** Round 23 (split): HOST-side dispatcher — runs every frame from tick() and fires
	 * the TWO entityState streams on their own cadences:
	 *   - sendBaseBlock()    every 1/15s (idle / NON-hostile enemies, quiet cadence)
	 *   - sendHostileBlock() every blockInterval (engaged enemies, full 30/60Hz)
	 * Each enemy belongs to exactly ONE stream per tick (it either has a target or it
	 * doesn't), so a member never misses state — an enemy that gains/loses a target
	 * simply switches streams on the next tick. Each stream tracks its OWN late-joiner
	 * growth counter so a new member gets BOTH streams' first post-join blocks full. */
	private sendEnemyBlock(): void {
		// ROUND 49: drain the synthetic (connect-independent) monster->member verdicts
		// whose impact moment has arrived. Runs every host frame, before the encode loops.
		this.drainSyntheticHits();
		this._mpBaseTimer -= ig.system.tick;
		if (this._mpBaseTimer <= 0) {
			this._mpBaseTimer = 1 / 15; // base stream: fixed ~15Hz (idle enemies)
			this.sendBaseBlock();
		}
		this.sendTimer -= ig.system.tick;
		if (this.sendTimer <= 0) {
			this.sendTimer = this.blockInterval; // hostile stream: option-driven (30/60Hz)
			this.sendHostileBlock();
		}
	}

	/** Round 23: the quiet entityState stream — every live host enemy WITHOUT a current
	 * target, at a fixed 15Hz. Same delta/liveness/full-block/prune machinery as the
	 * hostile stream, against the base delta map. A growing remote-mirror count (late
	 * joiner) forces this stream's next block FULL so the joiner can spawn idle
	 * enemies immediately. */
	private sendBaseBlock(): void {
		const out: IEnemySnap[] = [];
		const list = ig.game.entities;
		const Enemy = (ig.ENTITY as any).Enemy;
		// Round 22 (opt 2): a FULL block roughly once per second keeps the delta
		// self-healing — a late joiner or a dropped block recovers within a second.
		this._mpBaseFullAccum += 1 / 15;
		let forceFull = this._mpBaseFullAccum >= 1;
		if (forceFull) this._mpBaseFullAccum = 0;
		// Round 22 (opt 2): a LATE JOINER (new remote mirror) gets a FULL block on its
		// first block so its puppets spawn immediately (an all-marker block would make
		// it wait up to 1s for enemies). Count growth, not shrink (a leaver needs no
		// re-sync — absent uids are already pruned/reaped).
		const playerCount = Object.keys(this.main.players || {}).length;
		if (playerCount > this._mpBaseLastPlayerCount) forceFull = true;
		this._mpBaseLastPlayerCount = playerCount;
		// uids seen this block — the delta map is pruned of anything not in here.
		const liveUids: { [uid: number]: boolean } = Object.create(null);
		for (let i = 0; i < list.length; i++) {
			const e: any = list[i];
			if (!(e instanceof Enemy)) continue;
			// NOTE: do NOT skip `_hidden` here — a host enemy that burrows/phases must stay
			// in the block or members would reap (kill) its puppet and lose the adopted map
			// enemy. We keep streaming it (frozen in place) so the puppet survives.
			if (e._mpMirror || e._killed || !e.coll) continue;
			// ROUND 73 (fix 2c — autumn path-3 ghost enemies): an enemy that was never
			// FULLY initialized on the host must not enter the block. The engine's
			// spawnEntity returns null BEFORE show() when an entity's spawnCondition is
			// false, leaving the quest-wave enemies (buffalo-alt/hedgehog-alt, mapId
			// 401-448) in ig.game.entities with _hidden undefined, NO `settings` AND —
			// per the live dumps — NO `params` either (initEntity never ran, so the
			// entity has no stats at all; they can also end up hidden, id=0/_hidden=true,
			// still without params). `!e.params` is the reliable zombie test: a real
			// enemy ALWAYS has params; a burrowed/phased one keeps them, so the burrow
			// sync (hd:1) is untouched. A skipped zombie re-enters the block by itself
			// if the quest later shows + initializes it.
			if (e._hidden === undefined || !e.params) {
				if (this.isGhostType(this.ghostName(e))) {
					this.ghostLog('host.skip', e.uid, this.ghostName(e), 'mapId=' + (e.mapId || 0), 'id=' + e.id, 'params=' + (e.params ? 1 : 0));
				}
				continue;
			}
			if (this.isGhostType(this.ghostName(e))) {
				this.ghostLog('host.send', e.uid, this.ghostName(e), 'id=' + e.id, 'hidden=' + e._hidden);
			}
			if (e.target) continue; // hostile enemies live in the hostile stream
			this.emitAttackEdgesFor(e); // no-op while unengaged (gated on e.target)
			this.encodeEnemy(e, out, liveUids, this._mpLastBaseEncoded, forceFull);
		}
		this.pruneEnemyDelta(this._mpLastBaseEncoded, liveUids);
		// Round 24: skip EMPTY blocks — an idle room otherwise emits two entityState
		// packets every frame (45-75Hz of useless churn). EXCEPTIONS: (a) a force-full
		// fired this tick — the ~1s heartbeat block ships with f:1 even when empty so
		// members learn the host's (empty) roster and reap dead-on-host map enemies;
		// (b) the combat flag changed since this stream last emitted — members must
		// flip their combat mode even with no enemies to show.
		const cb = this.hostInCombat();
		if (out.length === 0 && !forceFull && cb === this._mpLastBaseCb) return;
		this._mpLastBaseCb = cb;
		this.main.connection.updateEntityStateBlock(this.mapName, out, cb, forceFull, 'base');
	}

	/** Round 23: the fast entityState stream — every live host enemy WITH a current
	 * target, at the option-driven blockInterval (30/60Hz). Same delta/liveness/full-
	 * block/prune machinery as the base stream, against the hostile delta map and its
	 * own late-joiner growth counter (so a joiner also spawns ENGAGED enemies on the
	 * first hostile block). */
	private sendHostileBlock(): void {
		const out: IEnemySnap[] = [];
		const list = ig.game.entities;
		const Enemy = (ig.ENTITY as any).Enemy;
		this._mpHostileFullAccum += this.blockInterval;
		let forceFull = this._mpHostileFullAccum >= 1;
		if (forceFull) this._mpHostileFullAccum = 0;
		const playerCount = Object.keys(this.main.players || {}).length;
		if (playerCount > this._mpHostileLastPlayerCount) forceFull = true;
		this._mpHostileLastPlayerCount = playerCount;
		const liveUids: { [uid: number]: boolean } = Object.create(null);
		for (let i = 0; i < list.length; i++) {
			const e: any = list[i];
			if (!(e instanceof Enemy)) continue;
			if (e._mpMirror || e._killed || !e.coll) continue;
			// ROUND 73 (fix 2c): never-initialized zombies stay out of this stream too
			// (see the base stream's comment — same _hidden-undefined / !params test).
			if (e._hidden === undefined || !e.params) {
				if (this.isGhostType(this.ghostName(e))) {
					this.ghostLog('host.skip', e.uid, this.ghostName(e), 'mapId=' + (e.mapId || 0), 'id=' + e.id, 'params=' + (e.params ? 1 : 0));
				}
				continue;
			}
			if (this.isGhostType(this.ghostName(e))) {
				this.ghostLog('host.send', e.uid, this.ghostName(e), 'id=' + e.id, 'hidden=' + e._hidden);
			}
			if (!e.target) continue; // idle enemies live in the base stream
			this.emitAttackEdgesFor(e);
			this.encodeEnemy(e, out, liveUids, this._mpLastHostileEncoded, forceFull);
		}
		this.pruneEnemyDelta(this._mpLastHostileEncoded, liveUids);
		// Round 24: skip EMPTY blocks (see sendBaseBlock) except on a force-full tick
		// (the ~1s f:1 heartbeat) or a combat-flag change — the hostile stream has its
		// OWN last-cb tracker so both streams keep members' combat mode in sync.
		const cb = this.hostInCombat();
		if (out.length === 0 && !forceFull && cb === this._mpLastHostileCb) return;
		this._mpLastHostileCb = cb;
		this.main.connection.updateEntityStateBlock(this.mapName, out, cb, forceFull, 'hostile');
	}

	/** Round 22 (opt 2) / Round 23: encode one live host enemy into `out` and its
	 * stream's delta map. A NEW or CHANGED enemy ships its FULL state; an UNCHANGED
	 * enemy ships ONLY {"i": uid} — a liveness marker that keeps its puppet alive on
	 * members at ~9 bytes instead of ~65. `forceFull` (the ~1s self-heal or a late
	 * joiner) re-ships everything full. Presence is recorded in `liveUids` for the
	 * delta-map prune. */
	private encodeEnemy(e: any, out: IEnemySnap[], liveUids: { [uid: number]: boolean }, deltaMap: Map<number, IEnemySnap>, forceFull: boolean): void {
		const face = e.face || { x: 0, y: 1 };
		liveUids[e.uid] = true;
		const snap: IEnemySnap = {
			i: e.uid,
			mi: e.mapId || 0,
			t: e.enemyName || (e.enemyType && (e.enemyType as any).name) || '',
			x: Math.round(e.coll.pos.x), y: Math.round(e.coll.pos.y), z: Math.round(e.coll.pos.z),
			fx: face.x, fy: face.y,
			a: typeof e.currentAnim === 'string' ? e.currentAnim : '',
			h: e.params ? e.params.currentHp : 0,
			m: e.params && e.params.getStat ? e.params.getStat('hp') : 0,
			tg: e.target ? 1 : 0,
			// ROUND 47: name the current target so a member can tell "engaged on ME"
			// from "engaged on someone else". A mirror target carries the member's name;
			// the host's own player has no multiplayer name -> '__host__'; idle -> ''.
			tn: (function (t: any): string {
				if (!t) return '';
				if (t._mpMirror && typeof t.name === 'string' && t.name) return t.name;
				return '__host__';
			})(e.target),
			// ROUND 61 (fix C): guard/break state — the member's puppet never showed the
			// host enemy's break ("红光") because sp/brk were never in the snapshot. Ship
			// currentSp / maxSp / the broken flag so applyEntityState can mirror them.
			sp: e.params ? Math.round(e.params.currentSp || 0) : 0,
			msp: e.params && e.params.baseParams ? Math.round(e.params.baseParams.sp || 0) : 0,
			brk: this.readEnemyBroken(e) ? 1 : 0,
			hd: e._hidden ? 1 : 0,
			psv: this._mpEnemyPassive(e) ? 1 : 0,
			vul: this.readEnemyVulnerable(e) ? 1 : 0,
			// ROUND 66: active shields (poise/state guards) — the puppet's native
			// isShielded needs them to reduce the member's damage exactly like the host.
			sh: this.encodeEnemyShields(e),
		};
		const prev = deltaMap.get(e.uid);
		// ROUND 61 (fix A): a burrowed/phased/hidden enemy (hillkat earthIn/earthOut) can
		// sit PERFECTLY still underground for a while — pos/anim/tg all unchanged — so the
		// strict delta check below emits only a bare liveness marker and the member's puppet
		// FREEZES at its last position. The host enemy then re-targets the member's MIRROR
		// and the two positions diverge for good: the member shoots at a frozen puppet (miss)
		// while the host sees its real enemy take 0~1 mirror-husk hits. Force a FULL snapshot
		// every block while the enemy is hidden/burrowed so the puppet keeps tracking the
		// real position through the burrow->emerge cycle (the >250px snap branch in
		// interpolatePuppets teleports it instantly on emerge).
		const burrowed = this._mpEnemyUntargetable(e);
		if (forceFull || burrowed || !prev || this.enemySnapChanged(prev, snap)) {
			deltaMap.set(e.uid, snap);
			out.push(snap);
		} else {
			out.push({ i: e.uid } as IEnemySnap);
		}
	}

	/** Round 23: prune a stream's delta map of uids that left the block (killed /
	 * despawned on the host) so it can't grow unbounded over a long session. */
	private pruneEnemyDelta(deltaMap: Map<number, IEnemySnap>, liveUids: { [uid: number]: boolean }): void {
		if (deltaMap.size) {
			for (const uid of deltaMap.keys()) {
				if (!liveUids[uid]) deltaMap.delete(uid);
			}
		}
	}

	/** Round 17 (issue 1) / Round 23: detect a FRESH edge into an attack-relevant anim
	 * for a live host enemy at block cadence and relay it to the members (their puppets
	 * replay the attack toward the local player; puppets no longer run local AI). The
	 * anim edge IS the de-dupe, so an attack whose anim persists over several blocks
	 * relays exactly once. Gated on e.target: enemies only attack while engaged. Called
	 * from BOTH encode loops — an enemy belongs to exactly one stream per tick, so the
	 * per-enemy edge check never double-fires. */
	private emitAttackEdgesFor(e: any): void {
		try {
			const atkAnim = typeof e.currentAnim === 'string' ? e.currentAnim : '';
			if (atkAnim && e._mpLastAtkAnim !== atkAnim) {
				e._mpLastAtkAnim = atkAnim;
				if (e.target && this.isAttackRelevantAnim(atkAnim)) {
					// Round 22 (RC1): resolve WHICH member the enemy is actually attacking
					// before relaying. Mirrors carry their owner's username in `name` and are
					// registered in this.main.players — that member is the one who should take
					// the local hit. A host-targeted (local playerEntity) or bot/unknown
					// target carries no member hit (null).
					const tgt: any = e.target;
					let targetName: string | null = null;
					if (tgt && tgt._mpMirror && tgt.name && this.main.players[tgt.name]) {
						targetName = tgt.name;
					} else if (tgt === (ig.game as any).playerEntity) {
						// Host is targeted — the host plays its own enemies locally.
						targetName = null;
					} else {
						// Bot / unknown target — no member takes the hit.
						targetName = null;
					}
					this.emitEnemyAttack(e.uid, atkAnim, targetName);
					// ROUND 59 (diagnostics): log the ATTACK-EDGE snapshot — every engaged swing
					// at a member emits one line: enemy uid, anim, aimed target (t=member name /
					// __host__ / '?') and enemy->mirror distance (d). Live signal for the residual
					// "swings but never hits the member" bug: tgt=member with NO pdm.recompute after
					// = physical-connect miss; tgt=__host__ = aimed at the host while standing on
					// the member (targeting problem, fixable WITHOUT touching damage gates). Host
					// console, `window.__mpSfxDebug = 1`; _sfxLog throttles ~500ms per enemy uid.
					this._sfxLog('tg.edge.' + e.uid, 'anim=' + atkAnim, 'tgt=' + (targetName || (tgt === (ig.game as any).playerEntity ? '__host__' : '?')), 'd=' + Math.round((tgt && e.distanceTo) ? e.distanceTo(tgt) : -1));
					// ROUND 49: connect-independent damage trigger. This anim edge fires
					// for EVERY engaged-enemy swing (the member log relays every swing even
					// when no hit lands), so it is the reliable trigger the physical connect
					// can no longer be. `tgt` is the mirror the enemy is genuinely attacking;
					// range + same-block are judged inside (and re-judged at impact time).
					if (targetName) {
						try { this.scheduleSyntheticMonsterHit(e, tgt, targetName, atkAnim); } catch (_) { /* ignore */ }
					}
				}
			}
		} catch (_) { /* an attack relay must never break the block */ }
	}

	/** ROUND 49: anim-edge trigger — the enemy WOUND UP a swing at a member's mirror
	 * (targetName resolved in emitAttackEdgesFor). We do NOT wait for the physical
	 * connect (the fragile aggro->A*->swing->hitbox chain that five patch rounds could
	 * not make reliable): if the mirror is same-block + within reach NOW, queue the
	 * verdict for the swing's impact moment. Every gate re-runs in drainSyntheticHits
	 * with the impact-time state. Cheap pre-filter only; never throws. */
	private scheduleSyntheticMonsterHit(e: any, mir: any, targetName: string, anim: string): void {
		try {
			if (!this._mpSynthHitsEnabled || !this.main.host) return;
			if (!e || !e.coll || e._killed) return;
			if (!mir || !mir.coll || mir._killed) return;
			if (!targetName || targetName === this.main.name) return;   // never self-hit
			const entry: any = this.main.players[targetName];
			if (entry && entry._mpCutscene) return;                     // no hits in cutscene
			if (this._mpPendingSynthHits.length > 64) return;           // bound the queue
			// Same nav block (A*-reachable), the same gate updateTarget uses.
			let sameBlock = true;
			try {
				sameBlock = (ig.game as any).getLevelIdx(e.coll.pos.z)
					=== (ig.game as any).getLevelIdx(mir.coll.pos.z);
			} catch (_) { sameBlock = true; }
			if (!sameBlock) return;
			// Cheap early reach check (re-run authoritatively at impact time).
			if (!this._mpSynthInReach(e, mir, anim)) return;
			// ROUND 52 (anti-phantom, pre-queue): only queue while the enemy is ACTUALLY
			// aiming at THIS member's mirror. tgt === mir here by construction (the edge
			// resolved targetName from e.target), so this is the same "still aiming" gate
			// the drain re-runs at impact time — an enemy that never holds the member as
			// its target never queues a verdict at all.
			if (e.target !== mir) { this._sfxLog('shs.retgt', 'uid=' + e.uid, 'for=' + targetName); return; }
			// ROUND 50: one pending verdict per (enemy, mirror). A single physical swing
			// emits MULTIPLE attack-relevant anim edges (hedgehog spin-in AND spin-out-long),
			// and without this each edge queues its own entry -> the drain fires a verdict
			// per edge (the "3 hits per swing" burst). Keep the EARLIEST-due entry so the
			// verdict still lands near the real impact moment of the first windup edge.
			for (let i = 0; i < this._mpPendingSynthHits.length; i++) {
				const q = this._mpPendingSynthHits[i];
				if (q && q.e === e && q.targetName === targetName) {
					this._sfxLog('shs.dup', 'uid=' + e.uid, 'anim=' + anim, 'for=' + targetName);
					return;
				}
			}
			this._mpPendingSynthHits.push({ dueAt: Date.now() + this._mpSynthSwingDelay, e, mir, targetName, anim });
			this._sfxLog('shs.sched', 'uid=' + e.uid, 'anim=' + anim, 'for=' + targetName);
		} catch (_) { /* a failed schedule must never break the block */ }
	}

	/** ROUND 49: host frame-rate drain of scheduled verdicts. Re-verifies every gate
	 * (liveness / nav-block / cutscene / reach) with the IMPACT-time state — the member's
	 * guard stash (_mpGd/_mpGst/_mpGw/_mpGm/_mpDef) is freshest then, so the PERFECT/
	 * REGULAR/no-guard verdict keeps its fidelity — dedupes against the kept Branch B
	 * physical-connect path, then runs recomputeHostMonsterHit verbatim. Never throws. */
	private drainSyntheticHits(): void {
		try {
			if (!this._mpSynthHitsEnabled || !this.main.host) return;
			if (!this._mpPendingSynthHits.length) return;
			const now = Date.now();
			const keep: typeof this._mpPendingSynthHits = [];
			for (let i = 0; i < this._mpPendingSynthHits.length; i++) {
				const p = this._mpPendingSynthHits[i];
				try {
					if (now < p.dueAt) { keep.push(p); continue; }          // not impact time yet
					const e: any = p.e; const mir: any = p.mir;
					const entry: any = this.main.players[p.targetName];
					if (!e || e._killed || !e.coll || !mir || mir._killed || !mir.coll || !mir.name) continue;
					if (entry && entry._mpCutscene) continue;
					let sameBlock = true;
					try {
						sameBlock = (ig.game as any).getLevelIdx(e.coll.pos.z)
							=== (ig.game as any).getLevelIdx(mir.coll.pos.z);
					} catch (_) { sameBlock = true; }
					if (!sameBlock) continue;
					// ROUND 52 (anti-phantom, impact-time): the enemy must STILL be aiming
					// at THIS member's mirror. This is the user's own decisive signal — the
					// member takes damage exactly when the enemy stays on them; if the enemy
					// has already swung and turned to the host, or never targeted the member,
					// this is NOT a genuine attack on the member and no verdict is judged.
					// Because tgt===mir here, the far "member near the host" / cross-map /
					// stale cases (where the enemy targets the HOST or nothing) can never
					// produce a verdict — only a member the enemy is actively attacking is hit.
					if (e.target !== mir) { this._sfxLog('shs.retgt', 'uid=' + e.uid, 'for=' + mir.name); continue; }
					// ROUND 50: owner-staleness gate. The reach check below runs against the
					// mirror's NETWORK-INTERPOLATED position — if the owner's stream stalled,
					// or the owner was knocked back / dodged out of range mid-swing, the mirror
					// is frozen at its last-rendered spot and we'd judge "in reach" against a
					// member who is no longer there (the "enemy windup hits from far away" bug).
					// _mpLastToAtMs is stamped in applyPlayerState ONLY when the owner's real
					// XY advanced; a stamp that stopped advancing means the reported position
					// is stale. Reject a stale verdict UNLESS the owner is still right next to
					// the enemy (a stationary member holding ground is a legitimate hit — their
					// stamp doesn't advance, but they're in close range). Fresh == always fine.
					// ROUND 52: tighten the close-range exception to the melee band (60 -> 46)
					// so a frozen mirror reads as "in reach" only when the member is genuinely
					// in the enemy's face — never the ROUND 50 far stream-stall gap.
					try {
						const lastAdv: any = (mir as any)._mpLastToAtMs;
						const advAge: number = (typeof lastAdv === 'number') ? (now - lastAdv) : 0;
						if (advAge > 400) {
							const es0 = (e.coll && e.coll.size) || { x: 0, y: 0 };
							const ms0 = (mir.coll && mir.coll.size) || { x: 0, y: 0 };
							const ecx0 = e.coll.pos.x + (es0.x || 0) / 2;  const ecy0 = e.coll.pos.y + (es0.y || 0) / 2;
							const mcx0 = mir.coll.pos.x + (ms0.x || 0) / 2; const mcy0 = mir.coll.pos.y + (ms0.y || 0) / 2;
							if (Math.hypot(ecx0 - mcx0, ecy0 - mcy0) > 46) {
								this._sfxLog('shs.stale', 'uid=' + e.uid, 'for=' + mir.name, 'age=' + Math.round(advAge));
								continue;
							}
						}
					} catch (_) { /* a failed staleness check must not drop the verdict */ }
					if (!this._mpSynthInReach(e, mir, p.anim)) continue;
					// DEDUP: Branch B wins if it already judged THIS swing (symmetric stamp).
					// ROUND 50: only the post-impact grace counts as "the same swing". A Branch B
					// connect that lands within the grace of a verdict stamp is the SAME physical
					// hit (suppress the echo); a connect later than that is a NEW attack the
					// synthetic path missed, and Branch B must be free to judge it as the fallback
					// that re-adds a dropped hit (the "member sometimes takes no damage" miss).
					const ss: any = e._mpSynthSwing;
					const graceMs: number = this._mpSynthGraceMs;
					if (ss && ss.m === mir.name && now - ss.ts < this._mpSynthWindowMs) {
						const bAge: number = now - ss.ts;
						if (bAge <= graceMs) {
							this._sfxLog('shs.skip.connect', 'uid=' + e.uid, 'for=' + mir.name);
							continue;
						}
						// Past the grace — this is a NEW swing, not the stamped one. Fall through
						// and judge it; also log so a re-add of a synthetic miss is visible.
						this._sfxLog('rc.lateB', 'uid=' + e.uid, 'for=' + mir.name, 'dt=' + Math.round(bAge));
					}
					e._mpSynthSwing = { m: mir.name, ts: now };             // WE judge this swing
					// Synthesize the du/hitProps the physical connect normally supplies.
					const atk = this._mpReadAttackStat(e);
					const du: any = { damage: atk > 0 ? atk : 1, element: this._mpReadAttackElement(e), critical: false };
					const atkType = this._mpSynthAttackType(e, p.anim);
					const hitProps: any = { damageFactor: 1, visualType: atkType, type: atkType, attackerParams: e.params };
					this._sfxLog('shs.drain', 'uid=' + e.uid, 'anim=' + p.anim, 'for=' + mir.name, 'atk=' + atk);
					this.recomputeHostMonsterHit(mir, e, du, hitProps);     // verdict + emit, verbatim
				} catch (_) { /* a failed drain entry must never break the frame */ }
			}
			this._mpPendingSynthHits = keep;
		} catch (_) { /* never break the frame */ }
	}

	/** ROUND 52: is the enemy's swing inside its own MELEE band of the mirror?
	 * Centre-to-centre distance <= enemy coll radius + mirror coll radius + a TIGHT
	 * margin (small bonus for dash/lunge anims). Deliberately TIGHT now — this is the
	 * anti-phantom gate. The enemy's coll is the hitbox and only connects while the
	 * mirror is genuinely in its face, so the compensation may only fire inside that
	 * same band (~2x coll + 28px ≈ 45-52px): close enough to absorb the network-
	 * interpolation lag of a member standing in the enemy's face, far too tight for a
	 * member who dodged out or a far stale/frozen mirror to ever pass. The schedule
	 * path uses this as a cheap pre-filter; the drain re-runs it authoritatively with
	 * the IMPACT-time positions (post-roll, post-move) so a member who escaped the
	 * band mid-swing is NOT judged. */
	private _mpSynthInReach(e: any, mir: any, anim: string): boolean {
		try {
			const es = (e.coll && e.coll.size) || { x: 0, y: 0, z: 0 };
			const ms = (mir.coll && mir.coll.size) || { x: 0, y: 0, z: 0 };
			const er = Math.max(es.x || 0, es.y || 0) / 2 || 20;
			const mr = Math.max(ms.x || 0, ms.y || 0) / 2 || 12;
			let reach = er + mr + this._mpSynthReachMargin;
			// Dash/lunge/roll swings travel through the target — a slightly wider band
			// absorbs the roll's fixed-travel overshoot against the lagging mirror.
			try { if (anim && /roll|dash|charge|lunge|ram|slam|dive|swoop|jump|spin/i.test(anim)) reach += 8; } catch (_) { /* ignore */ }
			const ecx = e.coll.pos.x + (es.x || 0) / 2;  const ecy = e.coll.pos.y + (es.y || 0) / 2;
			const mcx = mir.coll.pos.x + (ms.x || 0) / 2; const mcy = mir.coll.pos.y + (ms.y || 0) / 2;
			if (Math.hypot(ecx - mcx, ecy - mcy) > reach) return false;
			// z-band: melee connects within one body height. getLevelIdx already split
			// nav-blocks, so this only rejects a mirror clearly above/below the enemy.
			if (Math.abs(e.coll.pos.z - mir.coll.pos.z) > 48) return false;
			return true;
		} catch (_) { return false; }
	}

	/** ROUND 49: attack stat of a host enemy, with the same fallbacks the recompute uses. */
	private _mpReadAttackStat(e: any): number {
		let atk = 0;
		try {
			if (e && e.params && typeof e.params.getStat === 'function') {
				const a = e.params.getStat('attack');
				if (typeof a === 'number' && a > 0) atk = a;
			}
		} catch (_) { /* ignore */ }
		return atk;
	}

	/** ROUND 49: the enemy's attack element (0 = NEUTRAL default, mirrors the connect path's du.element). */
	private _mpReadAttackElement(e: any): number {
		try {
			const el = e && e.element;
			if (typeof el === 'number' && isFinite(el) && el >= 0 && el <= 4) return Math.round(el);
		} catch (_) { /* ignore */ }
		return 0;
	}

	/** ROUND 49: guess the swing's sc.ATTACK_TYPE from the anim. No AttackInfo exists
	 * without a connect, so default to MEDIUM(2) — the codebase's own melee default —
	 * with a small obvious-heavy override list. Flavour only (hit sound / number). */
	private _mpSynthAttackType(e: any, anim: string): number {
		try { if (anim && /heavy|slam|smash|massive|quake|rock/i.test(anim)) return 3; /* HEAVY */ } catch (_) { /* ignore */ }
		return 2; /* MEDIUM */
	}

	/** Round 22 (opt 2): true when any encoded field of an enemy changed since its
	 * last full encode — such an enemy must ship its full state again (a liveness
	 * marker alone would hide the change). Compares every block-carrying field. */
	private enemySnapChanged(a: IEnemySnap, b: IEnemySnap): boolean {
		if (a.x !== b.x || a.y !== b.y || a.z !== b.z) return true;
		if (a.fx !== b.fx || a.fy !== b.fy) return true;
		if (a.a !== b.a) return true;
		if (a.h !== b.h) return true;
		if (a.m !== b.m) return true;
		if (a.tg !== b.tg) return true;
		if (a.tn !== b.tn) return true;
		if (a.mi !== b.mi) return true;
		if (a.t !== b.t) return true;
		// ROUND 61 (fix C): break state changes must ship even at a frozen position.
		if ((a.sp || 0) !== (b.sp || 0)) return true;
		if ((a.msp || 0) !== (b.msp || 0)) return true;
		if ((a.brk || 0) !== (b.brk || 0)) return true;
		// ROUND 62: the burrow/phased flag flips mid-burrow (hillkat earthIn holds a still
		// frame for a while) — ship it so the member's puppet toggles its invulnerability.
		if ((a.hd || 0) !== (b.hd || 0)) return true;
		// ROUND 63: PASSIVE-coll (meerkat burrow) + VULNERABLE (red-flash) both flip while
		// the enemy holds a still frame — ship them so the member sees the change.
		if ((a.psv || 0) !== (b.psv || 0)) return true;
		if ((a.vul || 0) !== (b.vul || 0)) return true;
		// ROUND 66: a shield attach/detach mid-windup (hedgehog roll-up) changes the
		// damage the member's hit should deal — ship it immediately.
		const ash = a.sh, bsh = b.sh;
		if ((ash ? ash.length : 0) !== (bsh ? bsh.length : 0)) return true;
		if (ash && bsh) {
			for (let i = 0; i < ash.length; i++) {
				const x = ash[i], y = bsh[i];
				if (!x || !y || x.k !== y.k || x.n !== y.n || x.bf !== y.bf || x.hr !== y.hr
					|| x.st !== y.st || x.so !== y.so || x.nt !== y.nt
					|| (x.rg || 0) !== (y.rg || 0) || (x.bk || 0) !== (y.bk || 0)
					|| (x.iv || 0) !== (y.iv || 0)
					|| JSON.stringify(x.pt || null) !== JSON.stringify(y.pt || null)
					|| JSON.stringify(x.ef || null) !== JSON.stringify(y.ef || null)) return true;
			}
		}
		return false;
	}

	/** ROUND 66: serialize the host enemy's ACTIVE shield connections for the member's
	 * puppet. Enemy state guards (ADD_SHIELD action step — the hedgehog's roll-up
	 * "full" shield, baseFactor 0.25) only exist on the host: the puppet runs no AI,
	 * so without this sync a poised enemy takes FULL damage from the member. The class
	 * key is resolved against the COMBAT_SHIELDS registry (DIRECTIONAL/PARTS cover every
	 * enemy shield in the game data; anything else ships as BASE). Numeric enum fields
	 * (hitResist/stableOverride/strength) are sent as-is — the member assigns them
	 * directly onto the reconstructed instance. Returns undefined when no shield is
	 * active (keeps the wire payload lean). */
	private encodeEnemyShields(e: any): IShieldSnap[] | undefined {
		try {
			const conns: any[] = e && e.shieldsConnections;
			if (!conns || !conns.length) return undefined;
			const out: IShieldSnap[] = [];
			const reg: any = (sc as any).COMBAT_SHIELDS || {};
			for (let i = 0; i < conns.length; i++) {
				const c: any = conns[i];
				const sh: any = c && c.shield;
				if (!sh || typeof sh !== 'object') continue;
				let k = 'BASE';
				try {
					if (reg.PARTS && sh instanceof reg.PARTS) k = 'PARTS';
					else if (reg.DIRECTIONAL && sh instanceof reg.DIRECTIONAL) k = 'DIRECTIONAL';
				} catch (_) { /* keep BASE */ }
				const snap: IShieldSnap = {
					k,
					n: typeof sh.name === 'string' ? sh.name : '',
					bf: typeof sh.baseFactor === 'number' ? sh.baseFactor : 1,
					ef: Array.isArray(sh.elementFactors) ? sh.elementFactors.slice(0, 4) : [1, 1, 1, 1],
					hr: typeof sh.hitResist === 'number' ? sh.hitResist : 4,
					so: typeof sh.stableOverride === 'number' ? sh.stableOverride : 3,
					st: typeof sh.strength === 'number' ? sh.strength : 3,
					nt: sh.neutralize === true ? 1 : 0,
				};
				if (k === 'DIRECTIONAL') {
					snap.rg = typeof sh.range === 'number' ? sh.range : 0.5;
					snap.bk = sh.back === true ? 1 : 0;
				}
				if (k === 'PARTS') {
					snap.pt = Array.isArray(sh.parts) ? sh.parts.slice() : null;
					snap.iv = sh.inverse === true ? 1 : 0;
				}
				out.push(snap);
			}
			return out.length ? out : undefined;
		} catch (_) { return undefined; }
	}

	/** ROUND 61: read whether the host enemy is currently guard-BROKEN (the red "broken"
	 * flash a member's puppet never showed). The engine flips this through the SP bar +
	 * enemy state; we probe the small set of status/state signals defensively so a
	 * different build naming still resolves, and default to false (never show a phantom
	 * break). Best-effort — a missing field just means "not broken". */
	private readEnemyBroken(e: any): boolean {
		try {
			const gui: any = e.statusGui;
			if (gui && (gui.breakActive === true || gui.broken === true || gui.spBreak === true)) return true;
			if (gui && gui.spBar && (gui.spBar.broken === true || gui.spBar.breakActive === true)) return true;
			const st: any = e.state;
			if (st === 'break' || st === 'broken' || st === 'vulnerable') return true;
			if (e.breakTimer && e.breakTimer > 0) return true;
			// ROUND 63: reaction break (the meerkat's CHARGE_WEAK -> STUN). Guard-bar-less
			// enemies like the meerkat (maxSp 0) never touch statusGui/breakTimer — their
			// "broken" is the STUN state's annotate.passive === WEAK. Detect it so `brk`
			// correctly reports the break and the member can replay the break FX/label.
			if (e.annotate && e.annotate.passive === this._mpAnnoPassive('WEAK', 2)) return true;
		} catch (_) { /* best-effort */ }
		return false;
	}

	/** ROUND 63: resolve an ENEMY_ANNO_PASSIVE enum value by name (e.g. 'VULNERABLE'/'WEAK'),
	 * falling back to a hard-coded default if the enum key is missing on this build. */
	private _mpAnnoPassive(key: string, fallback: number): number {
		try {
			const E = (sc as any).ENEMY_ANNO_PASSIVE;
			return (E && E[key] != null) ? E[key] : fallback;
		} catch (_) { return fallback; }
	}

	/** ROUND 63: read whether the host enemy is in the VULNERABLE annotation (the meerkat's
	 * 2s "charge light" red-flash window — a charged ball breaks it here). This is NOT the
	 * "broken" state readEnemyBroken probes: the meerkat (maxSp 0) has no guard bar, and the
	 * engine flips `annotate.passive` to VULNERABLE via CHANGE_ENEMY_ANNOTATION during
	 * SpecialAttack, then to IMMUNE when it burrows. Best-effort; default false. */
	private readEnemyVulnerable(e: any): boolean {
		try {
			if (!e || !e.annotate) return false;
			const VUL: number = (sc as any).ENEMY_ANNO_PASSIVE && (sc as any).ENEMY_ANNO_PASSIVE.VULNERABLE
				? (sc as any).ENEMY_ANNO_PASSIVE.VULNERABLE : 1;
			return e.annotate.passive === VUL;
		} catch (_) { return false; }
	}

	/** ROUND 63: read whether the host enemy is untargetable via SET_COLL_TYPE PASSIVE
	 * (the meerkat's earthIn/earthDig burrow). PASSIVE is a coll type (8), NOT _hidden —
	 * the meerkat stays visible underground and only its coll becomes untargetable, so the
	 * old `e._hidden` probe never fired for it. Balls skip PASSIVE colls natively. */
	private _mpEnemyPassive(e: any): boolean {
		try {
			if (!e || !e.coll) return false;
			const PASSIVE = (ig as any).COLLTYPE && (ig as any).COLLTYPE.PASSIVE != null
				? (ig as any).COLLTYPE.PASSIVE : 8;
			return e.coll.type === PASSIVE;
		} catch (_) { return false; }
	}

	/** ROUND 63: an enemy is "untargetable" if it is genuinely hidden OR passive-coll. Used
	 * to force a FULL snapshot every block while buried so the puppet keeps tracking the
	 * real position through the still-frame burrow->emerge cycle (fix A's burrowed force). */
	private _mpEnemyUntargetable(e: any): boolean {
		return !!e._hidden || this._mpEnemyPassive(e);
	}

	/** Round 17 (issue 1): HOST side — one of our real enemies just started an attack
	 * (fresh anim edge at block cadence). Relay {uid, anim, t} to the instance so every
	 * member's puppet performs the same attack toward the local player (their puppets
	 * no longer run local AI); `t` is the targeted member's username (null for
	 * host-targeted / bot / unknown), and only that member schedules the local hit.
	 * No-op when disconnected; the server relay no-ops when we're alone in the instance. */
	private emitEnemyAttack(uid: number, anim: string, targetName: string | null): void {
		try {
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			conn.enemyAttack({ uid, anim, t: targetName });
		} catch (_) { /* ignore */ }
	}

	/** Round 17 (issue 1): is `anim` an attack-relevant anim for a live host enemy?
	 * Attack anims are the enemy's own attack-action anims (e.g. "roll" for a hedgehog,
	 * "sting", "attack", "attackRev"...) — they are not the common idle/walk strings.
	 * The engaged gate (e.target) is applied by the caller, and the anim EDGE is the
	 * de-dupe, so an attack relays exactly once per anim change. Round 22 (RC3): the
	 * transitional/flinch anims are ALSO denied — the old "over-emitting is harmless"
	 * note is obsolete since round 21 made the relay drive a REAL local hit, so a member
	 * hitting an enemy (its `damage` flinch anim) used to schedule a phantom hit on
	 * ITSELF 250ms later. Only genuine attack/behaviour anims reach the members. */
	private isAttackRelevantAnim(a: string): boolean {
		if (!a) return false;
		if (a === 'idle' || a === 'walk' || a === 'run' || a === 'default') return false;
		// Round 22 (RC3): deny the non-attack transitional/flinch anims (case-sensitive
		// exact match like the idle/walk checks above).
		if (a === 'damage' || a === 'jump' || a === 'dash' || a === 'guard' || a === 'block'
			|| a === 'stun' || a === 'die' || a === 'dead') return false;
		return true;
	}

	/** The host's combat flag, streamed with every block (`cb`) so members enter
	 * combat the moment the host does — "either side attacks -> both in combat".
	 * Round 9: reads isCombatActive (the mode flags) instead of isCombatMode (which
	 * ALSO counts the cooldown timer): the graceful post-combat fade is a LOCAL
	 * affair on every client — streaming the cooldown as "combat" would re-trigger
	 * member combat for up to 10s in the next block. */
	private hostInCombat(): boolean {
		try {
			const m: any = sc as any;
			return !!(m.model && m.model.isCombatActive && m.model.isCombatActive());
		} catch (_) { return false; }
	}

	/**
	 * PER-BLOCK COMBAT SCOPE (round 8, rewritten round 9). Combat must never radiate
	 * across blocks, but the combat HUD (the kill-chain counter) must fade out
	 * GRACEFULLY like the vanilla post-combat fade, not snap away.
	 *
	 * Root causes found this round:
	 *  - the engine NEVER cleans sc.combat.activeCombatants[ENEMY]: entries of killed
	 *    enemies linger across map changes (onLevelLoadStart/onReset don't touch it),
	 *    so isPlayerPartyInCombat() keeps returning true and ANY updateCombatMode()
	 *    re-arms combat forever — even across back-to-title and re-login (sc.combat
	 *    persists for the whole process). That was "member inherits the map and is
	 *    stuck in combat in every following area, even after relogging": the round-8
	 *    updateCombatMode() reset read exactly those stale entries and switched
	 *    combat back ON each map change.
	 *  - cancelCombatCooldown() zeroes combatTimer instantly; the CombatHudGui fade
	 *    IS that timer draining (lineTimer = 0.7 * combatTimer/cooldown), so zeroing
	 *    it made the chain counter snap closed on block change.
	 *
	 * Fix: purge dead entries, switch both mode flags off (the engine's own reset
	 * idiom from sc.model.onReset), and LEAVE combatTimer alone — the onPreUpdate
	 * loop drains it over the ~10s cooldown and the HUD fades out exactly like the
	 * single-player game. This block's own enemies (host) / cb flag (member)
	 * re-establish combat when due.
	 */
	private resetCombatForNewBlock(): void {
		try { this.purgeStaleCombatants(); } catch (_) { /* ignore */ }
		try {
			const mdl: any = sc as any;
			if (mdl.model && mdl.model.setCombatMode) {
				mdl.model.setCombatMode(false);
				mdl.model.setCombatMode(false, true); // clear forceCombatMode too
			}
			if (mdl.combat) mdl.combat.playerStartedCombat = false; // event payload flag; lingers otherwise
			// Deliberately NOT cancelCombatCooldown() and NOT updateCombatMode() here:
			// the timer drain IS the graceful HUD fade, and updateCombatMode would
			// re-arm combat from whatever still looks engaged this frame.
		} catch (_) { /* ignore */ }
	}

	/** Drop killed/dead entries from sc.combat.activeCombatants[ENEMY]. The engine
	 * only removes entries via setTarget(null), and killed enemies don't always
	 * reach that path — the stale THREAT corpses are what kept isPlayerPartyInCombat
	 * true across map changes (and even title/re-login). Also injected around
	 * isPlayerPartyInCombat itself in install() so no engine-side updateCombatMode
	 * can re-arm combat from a stale entry between blocks. */
	private purgeStaleCombatants(): void {
		const c: any = (sc as any).combat;
		if (!c || !c.activeCombatants) return;
		const arr: any[] = c.activeCombatants[(sc as any).COMBATANT_PARTY.ENEMY];
		if (!arr || !arr.length) return;
		for (let i = arr.length; i--;) {
			const e = arr[i];
			if (!e || e._killed) {
				try { if (typeof c.removeActiveCombatant === 'function') c.removeActiveCombatant(e); else arr.splice(i, 1); }
				catch (_) { arr.splice(i, 1); }
			}
		}
	}

	/**
	 * ROUND 80 (collision-map fix): the network writes xProtected/yProtected/
	 * zProtected directly (lockEntity forbids setPos), which updates the coll's
	 * VISIBLE position but never re-buckets it in the impact.js spatial hash.
	 * Physics hit tests only walk the hash cells along the attacker's path, so a
	 * puppet/mirror that moved from its spawn cell was effectively invisible to
	 * melee TACKLEs and ball touches. This re-buckets a moved entry at its CURRENT
	 * position. Only entries already in the map are touched; hidden/PASSIVE entries
	 * (untracked, _inCollisionMap=false) stay untracked.
	 * ROUND 88 (collision-map leak fix): the previous implementation called the
	 * engine's removeFromCollMap while the coll's pos already reported the NEW
	 * position — once a network entity crossed a 64px cell boundary, removal
	 * looked in the wrong cell, leaving a stale entry in the OLD cell forever.
	 * Every hour of movement laid a growing trail of stale entries; map switches
	 * rebuilt the hash, which is why they "fixed" the slowdown. The old bucket is
	 * now remembered on the coll (_mpCollMapX/_mpCollMapY) and removed at THOSE
	 * coordinates before the coll is added at its current position.
	 */
	private _mpReindexColl(e: any): void {
		try {
			if (!e || e._killed || !e.coll) return;
			const c: any = e.coll;
			const phys: any = (ig as any).game && (ig as any).game.physics;
			if (!phys || !phys.collEntryMap || typeof phys.addToCollMap !== 'function') return;
			const oldX: number = c._mpCollMapX;
			const oldY: number = c._mpCollMapY;
			if (typeof oldX === 'number' && typeof oldY === 'number') {
				this._mpRemoveCollAt(c, oldX, oldY);
			} else if (c._inCollisionMap && typeof phys.removeFromCollMap === 'function') {
				// First reindex after a legacy add (pre-tracking): best effort.
				try { phys.removeFromCollMap(c); } catch (_) { /* ignore */ }
			}
			c._mpCollMapX = c.pos.x;
			c._mpCollMapY = c.pos.y;
			// Mirror addToCollMap's own gate (it only skips NONE/PASSIVE). IGNORE is
			// deliberately kept: the engine's setType also keeps IGNORE bucketed.
			if (!c._inCollisionMap && c.type !== (ig as any).COLLTYPE.NONE && c.type !== (ig as any).COLLTYPE.PASSIVE) {
				try { phys.addToCollMap(c); } catch (_) { /* ignore */ }
			}
		} catch (_) { /* a failed re-bucket must never break the frame */ }
	}

	/** ROUND 88: remove a coll from the impact.js spatial hash at an EXPLICIT old
	 * bucket position (the engine's own cell math, but without reading coll.pos). */
	private _mpRemoveCollAt(c: any, x: number, y: number): void {
		try {
			const phys: any = (ig as any).game && (ig as any).game.physics;
			const map: any = phys && phys.collEntryMap;
			if (!map || !map.length) return;
			const cs: number = phys.cellSize || 64;
			const padX: number = (c.padding ? c.padding.x : 0) * 2;
			const padY: number = (c.padding ? c.padding.y : 0) * 2;
			const x0: number = Math.max(0, Math.floor((x - padX) / cs));
			const y0: number = Math.max(0, Math.floor((y - padY) / cs));
			const x1: number = Math.min(map.width, Math.floor((x + c.size.x + padX) / cs) + 1);
			const y1: number = Math.min(map.height, Math.floor((y + c.size.y + padY) / cs) + 1);
			for (let cx = x1; cx-- > x0;) {
				for (let cy = y1; cy-- > y0;) {
					const cell: any = map[cx] && map[cx][cy];
					if (!cell) continue;
					const idx: number = cell.indexOf(c);
					if (idx !== -1) cell.splice(idx, 1);
				}
			}
			c._inCollisionMap = false;
		} catch (_) { /* ignore */ }
	}

	/** ROUND 88 (collision-map leak fix): purge spatial-hash cells of entries whose
	 * `_inCollisionMap` is false (stale trails from cell crossings before tracked
	 * re-bucketing). Every cell is touched once per sweep — a full map is a few
	 * thousand cells, so a 5s cadence is effectively free. */
	private _mpSweepStaleCollEntries(): void {
		try {
			const phys: any = (ig as any).game && (ig as any).game.physics;
			const map: any = phys && phys.collEntryMap;
			if (!map || !map.length) return;
			let removed = 0;
			for (let cx = 0; cx < map.width; cx++) {
				const col: any = map[cx];
				if (!col) continue;
				for (let cy = 0; cy < map.height; cy++) {
					const cell: any = col[cy];
					if (!cell || !cell.length) continue;
					for (let i = cell.length - 1; i >= 0; i--) {
						const c: any = cell[i];
						if (c && c._inCollisionMap === false) { cell.splice(i, 1); removed++; }
					}
				}
			}
			if (removed > 0) {
				const last: number = (this as any)._mpCollSweepLogAt || 0;
				if (Date.now() - last > 10000) {
					(this as any)._mpCollSweepLogAt = Date.now();
					console.log('[netsync] collision-map sweep removed ' + removed + ' stale entries');
				}
			}
		} catch (_) { /* ignore */ }
	}

	/** ROUND 80: mark an entity whose locked coll position was written directly so
	 * the next interpolation pass re-buckets its collision entry. */
	private _mpMarkCollDirty(e: any): void {
		try { if (e) e._mpCollDirty = true; } catch (_) { /* ignore */ }
	}

	/** ROUND 80 (body-push fix, persistent): the engine can restore a combatant's
	 * configured coll weight via defaultConfig.apply (stun end / RESET_ACTOR /
	 * state changes), which would re-enable body-pushing for a puppet or mirror.
	 * Re-assert weight 0 every rendered frame so network telepresences stay
	 * hittable but can never shove the player or an attacking enemy. */
	private _mpZeroNetworkWeights(): void {
		try {
			for (const uidStr in this.puppets) {
				const e: any = this.puppets[uidStr];
				if (e && !e._killed && e.coll && e.coll.weight !== 0) e.coll.weight = 0;
			}
			for (const pName in this.main.players) {
				const pm = this.main.players[pName];
				const e: any = pm && pm.entity;
				if (e && !e._killed && e.coll && e.coll.weight !== 0) e.coll.weight = 0;
			}
		} catch (_) { /* never break the frame */ }
	}

	/**
	 * ROUND 80 (town movement smoothing): render a remote player's mirror from a
	 * one-packet linear REPLAY segment while in a shared town. Each 10Hz state
	 * sample starts a new segment that runs from the mirror's current rendered
	 * position to the new sample over the OBSERVED inter-sample interval, so the
	 * motion is piecewise-linear, never jumps at packet handoff, and reaches each
	 * sample right as the next one arrives. The old "converge to the latest sample"
	 * lerp reached each sample and STOPPED before the next arrived, which read as
	 * stop-and-go jitter. Returns null outside town / before the first segment.
	 */
	private _mpTownRenderTarget(e: any): { x: number, y: number, z: number } | null {
		try {
			if (!isSharedTownNow()) return null;
			const s: any = e && e._mpTownSeg;
			if (!s || !(s.t0 > 0) || !(s.dur > 0)) return null;
			const k = Math.max(0, Math.min(1, (Date.now() - s.t0) / s.dur));
			return {
				x: s.x0 + (s.x1 - s.x0) * k,
				y: s.y0 + (s.y1 - s.y0) * k,
				z: s.z0 + (s.z1 - s.z0) * k,
			};
		} catch (_) { return null; }
	}

	/** ROUND 80: re-bucket every network entity that was marked dirty (direct
	 * position snaps + per-frame interpolation targets). */
	private _mpReindexDirtyColls(): void {
		try {
			for (const uidStr in this.puppets) {
				const e: any = this.puppets[uidStr];
				if (e && e._mpCollDirty) {
					e._mpCollDirty = false;
					this._mpReindexColl(e);
				}
			}
			for (const pName in this.main.players) {
				const pm = this.main.players[pName];
				const e: any = pm && pm.entity;
				if (e && e._mpCollDirty) {
					e._mpCollDirty = false;
					this._mpReindexColl(e);
				}
			}
		} catch (_) { /* never break the frame */ }
	}

	/**
	 * Per-frame interpolation of network-driven entities (puppets on members, and
	 * remote-player mirrors on both host and member): the synced data arrives only
	 * ~15-60x/sec, but this runs on EVERY rendered frame, closing a fraction
	 * (≈12%/frame @60fps → converges in ~150ms) of the remaining distance to the
	 * latest synced position. Synced monsters and player mirrors glide at full
	 * render framerate instead of stuttering/jittering between snapshots. Big jumps
	 * (teleport/spawn/respawn) snap instantly rather than gliding across the map
	 * (puppets snap in the block apply path via _mpSnapNext, mirrors snap in
	 * applyPlayerState on first-state/teleport/ledges).
	 */
	private interpolatePuppets(): void {
		const t = Math.min(1, ig.system.tick * 12);
		for (const uidStr in this.puppets) {
			const e = this.puppets[uidStr];
			if (!e || e._killed || !e.coll || typeof e._mpToX !== 'number') continue;
			const cp: any = e.coll.pos;
			const dx = e._mpToX - cp.xProtected;
			const dy = e._mpToY - cp.yProtected;
			const dz = e._mpToZ - cp.zProtected;
			if (dx === 0 && dy === 0 && dz === 0) continue;
			if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
				cp.xProtected = e._mpToX; cp.yProtected = e._mpToY; cp.zProtected = e._mpToZ;
				this._mpMarkCollDirty(e);
				continue;
			}
			if (dx !== 0) cp.xProtected = cp.xProtected + dx * t;
			if (dy !== 0) cp.yProtected = cp.yProtected + dy * t;
			if (dz !== 0) cp.zProtected = cp.zProtected + dz * t;
			this._mpMarkCollDirty(e);
		}
		// Fix 3: player-mirror interpolation in the same per-frame pump, same
		// ~12%/frame rate (t is frame-rate independent via ig.system.tick). Mirrors
		// are lockEntity-locked exactly like puppets, so lerp through the same
		// xProtected/yProtected/zProtected backing fields. applyPlayerState stores the
		// _mpTo* target and already SNAPS on first state / teleports / death-respawn,
		// so any entity with a target here is normal movement that just gets closed
		// toward at full render framerate. The LOCAL player is never a _mpMirror and
		// never sits in this.main.players, so it is never interpolated by construction.
		for (const pName in this.main.players) {
			const pm = this.main.players[pName];
			const e: any = pm && pm.entity;
			if (!e || e._killed || !e.coll || typeof e._mpToX !== 'number') continue;
			// ROUND 82: a mirror fading out at a door is already "gone" — freeze it in
			// place instead of interpolating the last stale position target.
			if (typeof e._mpFadeOutUntil === 'number') continue;
			const cpm: any = e.coll.pos;
			// ROUND 80 (town movement smoothing): in shared towns use the adaptive
			// one-packet replay segment. Its target is already a continuous linear
			// render position, so write it directly instead of converging to a fixed
			// 10Hz sample and stopping between updates. Collision is IGNORE in town,
			// so the ~one-packet visual delay is harmless there.
			const townTarget = this._mpTownRenderTarget(e);
			if (townTarget) {
				if (cpm.xProtected !== townTarget.x || cpm.yProtected !== townTarget.y || cpm.zProtected !== townTarget.z) {
					cpm.xProtected = townTarget.x;
					cpm.yProtected = townTarget.y;
					cpm.zProtected = townTarget.z;
					this._mpMarkCollDirty(e);
				}
				continue;
			}
			const dxm = e._mpToX - cpm.xProtected;
			const dym = e._mpToY - cpm.yProtected;
			const dzm = e._mpToZ - cpm.zProtected;
			if (dxm === 0 && dym === 0 && dzm === 0) continue;
			if (dxm !== 0) cpm.xProtected = cpm.xProtected + dxm * t;
			if (dym !== 0) cpm.yProtected = cpm.yProtected + dym * t;
			if (dzm !== 0) cpm.zProtected = cpm.zProtected + dzm * t;
			this._mpMarkCollDirty(e);
		}
		// ROUND 80: re-bucket any collision entries whose locked position changed
		// (direct snaps marked by the block/playerState applies + the lerp above).
		this._mpReindexDirtyColls();
		// ROUND 80: keep the no-body-push weight override alive against the
		// engine's own defaultConfig.apply resets.
		this._mpZeroNetworkWeights();
	// ROUND 32 (item 7): resolve the synced entities' floor height every frame via
	// the engine's own `updateGroundEntity`, not `updateBaseZPos` alone. Three
	// rounds keyed on `updateBaseZPos` left the shadow pinned to the map-entry
	// floor; the decisive difference is that `updateGroundEntity` is the engine's
	// FULL per-frame ground pass and — unlike the bare `updateBaseZPos` — does not
	// consult `zGravityFactor`/`float.height`/`vel.z` in a way that can leave a
	// network-driven (lockEntity'd, zero-velocity) coll's `baseZPos` stuck. The
	// sprite's `setShadowFromEntity` reads `coll.baseZPos` every frame, so once
	// `baseZPos` tracks the real floor the shadow follows. The args mirror the
	// engine's own stationary-coll call in moveEntity's skipPhysics branch:
	// (coll, zeroDir, onGround, 0, false). The dedupe below still keys on the
	// backing-field position so this only re-runs on real movement.
		try {
			const phys: any = (ig as any).game && (ig as any).game.physics;
			const uge: any = phys && typeof phys.updateGroundEntity === 'function' ? phys.updateGroundEntity : null;
			const zeroDir: any = (typeof Vec2 !== 'undefined' && (Vec2 as any).createC) ? (Vec2 as any).createC(0, 0) : { x: 0, y: 0 };
			if (uge) {
				const eList: any[] = [];
				for (const uidStr in this.puppets) {
					const e = this.puppets[uidStr];
					// ROUND 30 (item 4): _collData lives on the COLL, not the entity.
					// ROUND 31: gating on _collData (either form) left eList empty — a
					// lockEntity'd coll never runs moveEntity, so _collData stays falsy at
					// runtime — so round 31 drops the gate and initCollData's below.
					if (e && !e._killed && e.coll) eList.push(e);
				}
				for (const pName in this.main.players) {
					const pm = this.main.players[pName];
					const e: any = pm && pm.entity;
					if (e && !e._killed && e.coll) eList.push(e);
				}
				for (let i = 0; i < eList.length; i++) {
					const e = eList[i];
					const c: any = e.coll;
					// ROUND 31 (item 4): read the LOCKED backing fields, not the
					// `pos.x/y/z` accessor getters. A lockEntity'd coll's `pos`
					// accessor returns xProtected/yProtected/zProtected (which this
					// pump drives), but reading via the getters makes this dedupe
					// depend on the accessor surviving the lock — and any path where
					// it doesn't (or a re-lock re-seeding the plain object) leaves
					// this comparing stale values, so the floor refresh never re-ran
					// after a floor change. Reading the backing fields directly is
					// exactly what the network writes mutate, so any real movement
					// registers immediately.
					const px = typeof c.pos.xProtected === 'number' ? c.pos.xProtected : c.pos.x;
					const py = typeof c.pos.yProtected === 'number' ? c.pos.yProtected : c.pos.y;
					const pz = typeof c.pos.zProtected === 'number' ? c.pos.zProtected : c.pos.z;
					// ROUND 30 (item 4): include Z in the dedupe — a pure-vertical
					// floor change (elevator / standing jump) at constant x/y must
					// still re-run the floor lookup or the shadow lags the height.
					if (e._mpLastShadowX === px && e._mpLastShadowY === py && e._mpLastShadowZ === pz) continue;
					e._mpLastShadowX = px; e._mpLastShadowY = py; e._mpLastShadowZ = pz;
					// Sync the level index first — on a lockEntity'd entity, z writes
					// bypass moveEntityZ (the normal level/floor setter), so a stale level
					// would make updateBaseZPos look up the wrong floor.
					// ROUND: round z before the level lookup. The lerp above converges
					// zProtected GEOMETRICALLY toward the integer _mpToZ, so it settles at
					// e.g. 15.999… instead of exactly 16 — getLevelIdx(15.999…) then returns
					// the LOWER floor and the shadow stays pinned to the entry height.
					try {
						const lvl = (ig as any).game.getLevelIdx(Math.round(pz));
						if (typeof lvl === 'number' && lvl !== c.level) c.level = lvl;
					} catch (_) { /* ignore */ }
					// ROUND 31 (item 4): updateBaseZPos reads getGroundEntry/holeInfo off
					// _collData — create it if the coll never ran moveEntity. initCollData
					// is idempotent (returns false if present), so this is safe per frame.
					try { if (!c._collData && typeof c.initCollData === 'function') c.initCollData(); } catch (_) { /* ignore */ }
					if (!c._collData) continue;
					// ROUND 32 (item 7): updateGroundEntity, not updateBaseZPos. onGround
					// (3rd arg) = the coll is resting on its floor (pos.z == baseZPos),
					// matching moveEntity's skipPhysics branch. This is the engine's
					// complete ground pass, so the shadow's baseZPos tracks the real
					// floor under the mirror instead of pinning to the entry height.
					const onGround = pz === c.baseZPos;
					try { uge.call(phys, c, zeroDir, onGround, 0, false); } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* a floor refresh must never break the frame */ }
		// Round 19 (Part 3): cutscene puppets glide through the SAME per-frame lerp
		// targets (applyCutsceneEntity writes _mpTo* exactly like the block-apply
		// path; _mpSnapNext snaps the fresh spawn into place).
		for (const ck in this.csPuppets) {
			const e = this.csPuppets[ck];
			if (!e || e._killed || !e.coll || typeof e._mpToX !== 'number') continue;
			const cpp: any = e.coll.pos;
			const dx = e._mpToX - cpp.xProtected;
			const dy = e._mpToY - cpp.yProtected;
			const dz = e._mpToZ - cpp.zProtected;
			if (dx === 0 && dy === 0 && dz === 0) continue;
			if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
				cpp.xProtected = e._mpToX; cpp.yProtected = e._mpToY; cpp.zProtected = e._mpToZ;
				continue;
			}
			if (dx !== 0) cpp.xProtected = cpp.xProtected + dx * t;
			if (dy !== 0) cpp.yProtected = cpp.yProtected + dy * t;
			if (dz !== 0) cpp.zProtected = cpp.zProtected + dz * t;
		}
		// Round 62: visual projectile copies DEAD-RECKON through each host block
		// (ROUND 80): the render target advances linearly at the projectile's real
		// speed for up to one observed packet window after the latest sample, so the
		// visual neither decelerates near snapshots nor stops short of the impact
		// point when the host's final kill has no packet. If the host ever stops
		// streaming, reapStaleProjectiles removes it shortly after the window cap.
		const projBlend = Math.min(1, ig.system.tick * 14);
		for (const pk in this.projectiles) {
			const e = this.projectiles[pk];
			if (!e || e._killed || !e.coll || typeof e._mpProjBaseX !== 'number') continue;
			const cpp: any = e.coll.pos;
			const nowMs = Date.now();
			const ageMs = Math.max(0, nowMs - (e._mpProjBaseAt || nowMs));
			const winMs = (typeof e._mpProjWindowMs === 'number' && e._mpProjWindowMs > 0) ? e._mpProjWindowMs : 100;
			const adv = Math.min(ageMs, winMs) / 1000;
			const tx = e._mpProjBaseX + (e._mpProjVelX || 0) * adv;
			const ty = e._mpProjBaseY + (e._mpProjVelY || 0) * adv;
			const tz = e._mpProjBaseZ;
			const dx = tx - cpp.xProtected;
			const dy = ty - cpp.yProtected;
			const dz = tz - cpp.zProtected;
			if (dx * dx + dy * dy > 250 * 250 || Math.abs(dz) > 200) {
				cpp.xProtected = tx; cpp.yProtected = ty; cpp.zProtected = tz;
				continue;
			}
			if (dx !== 0) cpp.xProtected = cpp.xProtected + dx * projBlend;
			if (dy !== 0) cpp.yProtected = cpp.yProtected + dy * projBlend;
			if (dz !== 0) cpp.zProtected = cpp.zProtected + dz * projBlend;
		}
	}

	// ---- round 19: cutscene compatibility (fade/collision + csPuppets) ----

	/**
	 * ROUND 19 (Part 2): the single per-frame decision-maker for remote-mirror
	 * collision + cutscene fade (BOTH directions). Folds the shared-town IGNORE
	 * rule (formerly refreshTownCollision's write) into the cutscene-fade rule so
	 * the two can never fight:  target coll = (inTown || fade) ? IGNORE : base.
	 * Fade applies to animState.alpha (body + shadow via the sprite path) and the
	 * under-feet StatusBar's hook (the HP bar). Writes ONLY on change (cached per
	 * mirror) — mirrors may be mid-spawn (guarded), and a mirror spawned mid-fade
	 * self-heals on the next tick.
	 * ROUND 82: also owns the door-transition fades (_mpFadeInStart / _mpFadeOutUntil)
	 * and hides the under-feet HP bar with hook._visible — StatusBar.update overwrites
	 * hook.localAlpha every frame, so an alpha write alone never hid the town bar.
	 */
	public updateRemoteMirrorFade(): void {
		try {
			this._mpEnsureDoorHook();
			// ROUND 108: derive "town" from BOTH the engine's area model and the
			// raw map name. sc.map.currentPlayerArea can lag behind on a member
			// client right after a multiplayer map enter, while ig.game.mapName is
			// already the destination map (their diagnostic shows it is correct).
			const mapName = ((ig.game as any).mapName || '') as string;
			const inTown = isSharedTownNow() || isSharedTownMap(mapName);
			const nowMs = Date.now();
			for (const name in this.main.players) {
				const pm = this.main.players[name];
				if (!pm) continue;
				const entry: any = pm as any;
				const e = entry.entity;
				if (!e || e._killed || !e.coll) continue;
				const fade = this.inCutscene || !!entry._mpCutscene;
				// ROUND 82: door leave/enter transitions fade the mirror in/out over
				// ~450-500ms. A cutscene fade still falls back to the base 0.25 alpha
				// when no transition is active.
				let targetAlpha = fade ? 0.25 : 1;
				let hideStatus = inTown;
				if (typeof e._mpFadeInStart === 'number') {
					const start = e._mpFadeInStart;
					const dur = (typeof e._mpFadeInDur === 'number' && e._mpFadeInDur > 0) ? e._mpFadeInDur : 500;
					const k = (nowMs - start) / dur;
					if (k >= 1) {
						e._mpFadeInStart = undefined;
						e._mpFadeInDur = undefined;
					} else {
						targetAlpha = Math.max(0, Math.min(1, k));
						hideStatus = true;
					}
				} else if (typeof e._mpFadeOutUntil === 'number') {
					const dur = (typeof e._mpFadeOutDur === 'number' && e._mpFadeOutDur > 0) ? e._mpFadeOutDur : 450;
					targetAlpha = Math.max(0, Math.min(1, (e._mpFadeOutUntil - nowMs) / dur));
					hideStatus = true;
				}
				// Capture the mirror's base coll type once (the same _mpBaseCollType
				// pattern refreshTownCollision used — it captures it there too, so this
				// just reads it back if already set). Captured BEFORE any write this
				// function makes so a mid-grace first frame can't latch IGNORE as base.
				if (e._mpBaseCollType === undefined) e._mpBaseCollType = e.coll.type;
				// Round 21 (issue 1): 1s no-collision grace. A per-mirror _mpNoCollUntil
				// (set in spawnMirrorNow — remote map-enter / revival / pvp-exit) OR the
				// client-wide _mpMirrorGraceUntil (local soft revival / teleport) forces
				// IGNORE so the freshly-placed local player can't overlap this mirror.
				// `||` folds both to the earliest deadline; the change-gated cache below
				// handles both the activation and the time-based expiry automatically.
				const grace = nowMs < ((e as any)._mpNoCollUntil || this._mpMirrorGraceUntil || 0);
				const transition = typeof e._mpFadeInStart === 'number' || typeof e._mpFadeOutUntil === 'number';
				// A mirror staged with playPuppetDeath must stay walk-through for its
				// ~500ms FX window (its coll was deliberately flipped to IGNORE there).
				const dying = !!((e as any)._mpDying);
				const noPlayerCollide = !!(inTown || fade || grace || transition || dying);
				const targetColl = noPlayerCollide ? (ig as any).COLLTYPE.IGNORE : e._mpBaseCollType;
				// ROUND 108 (collision re-assert fix): the cache stores the last TARGET
				// we wrote, so a frame with an unchanged target used to skip the write.
				// The engine may legally overwrite coll.type / ignoreCollision after
				// that write (actor resets / default config re-applies can restore
				// VIRTUAL), and the target-only change gate let the flip stick forever —
				// exactly the observed "no collision for the first moments after map
				// entry, then collision returns": the spawn grace wrote IGNORE, the
				// engine restored VIRTUAL, but our cached target still said IGNORE.
				// Compare the ACTUAL coll state against the target too, so any stale
				// reality re-triggers the write on the next frame.
				const actualType = e.coll.type;
				const actualIgnore = !!e.coll.ignoreCollision;
				const collStale = actualType !== targetColl || actualIgnore !== noPlayerCollide;
				// Main-city refactor: hide the under-feet HP bar entirely while in a shared
				// town (a room full of auto-matched players would stack dozens of HP bars).
				// ROUND 82: use hook._visible (the only reliable gate — StatusBar.update
				// resets hook.localAlpha to 0.9/1 every frame, so the old alpha write never
				// survived). Capture the normal visibility once and restore it exactly.
				if (e.statusGui && e.statusGui.hook && e._mpBaseStatusVisible === undefined
					&& e.statusGui.hook._visible === true) {
					e._mpBaseStatusVisible = true;
				}
				const statusVisible = !hideStatus && e._mpBaseStatusVisible !== false;
				const hpAlpha = inTown ? 0 : (fade ? 0.25 : (typeof e._mpBaseHpAlpha === 'number' ? e._mpBaseHpAlpha : 1));
				const cached = this._mpMirrorFadeCache.get(e);
				if (!cached || cached.alpha !== targetAlpha || cached.coll !== targetColl
					|| cached.ignore !== noPlayerCollide
					|| cached.hp !== hpAlpha || cached.status !== statusVisible
					|| collStale) {
					// Diagnostic: every target flip, plus reality corrections (rate-
					// limited to 2s per mirror so a persistent fighter can't flood).
					const ignoreFlipped = !cached || cached.ignore !== noPlayerCollide;
					if (e._mpMirror && (ignoreFlipped || collStale)) {
						const last: number = (e as any)._mpCollLogAt || 0;
						if (ignoreFlipped || nowMs - last >= 2000) {
							(e as any)._mpCollLogAt = nowMs;
							console.log('[collision] mirror ' + name
								+ ' wantIgnore=' + noPlayerCollide
								+ ' targetType=' + targetColl
								+ ' actualType=' + actualType
								+ ' actualIgnore=' + actualIgnore
								+ ' inTown=' + inTown + ' fade=' + fade + ' grace=' + grace + ' dying=' + dying
								+ ' areaPath=' + currentAreaPath() + ' map=' + mapName);
						}
					}
					this._mpMirrorFadeCache.set(e, { alpha: targetAlpha, coll: targetColl, ignore: noPlayerCollide, hp: hpAlpha, status: statusVisible });
					// Body + shadow fade via animState.alpha (default 1; sprite path).
					try { if (e.animState) e.animState.alpha = targetAlpha; } catch (_) { /* ignore */ }
					// ROUND 107: coll.type=IGNORE alone is NOT enough for some engine
					// collision variants; the collision ENTRY's `ignoreCollision` flag is the
					// trace-entity equivalent (setSlipThrough writes it) and must be driven
					// by the same single decision-maker. Written before the type flip...
					try { e.coll.ignoreCollision = !!noPlayerCollide; } catch (_) { /* ignore */ }
					// HP bar: _visible is the real gate; localAlpha still follows the
					// cutscene/base convention while the engine keeps overriding it.
					try {
						if (e.statusGui && e.statusGui.hook) {
							e.statusGui.hook.localAlpha = hpAlpha;
							e.statusGui.hook._visible = statusVisible;
						}
					} catch (_) { /* ignore */ }
					// ROUND 80: setType keeps the spatial hash consistent with the
					// collision-type flip (IGNORE <-> base), unlike a raw type write.
					// ROUND 88: clean the OLD tracked bucket before the flip and
					// re-bucket under the new type afterwards, so the type flip can
					// never leave a stale hash entry behind either.
					try {
						this._mpReindexColl(e);
						if (e.coll && typeof e.coll.setType === 'function') e.coll.setType(targetColl);
						else if (e.coll) e.coll.type = targetColl;
						this._mpReindexColl(e);
					} catch (_) { /* ignore */ }
					// ...and asserted AGAIN after the flip: re-bucketing paths can
					// re-normalize ignoreCollision, and the town/cutscene slip-through
					// must survive the type write.
					try { if (e.coll.ignoreCollision !== (noPlayerCollide ? true : false)) e.coll.ignoreCollision = !!noPlayerCollide; } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* never break the frame */ }
	}

	/**
	 * ROUND 82 (door transition visuals): lazily hook ig.ENTITY.Door.collideWith so
	 * a LOCAL player stepping into a mapped door broadcasts it before the original
	 * method runs the walk+teleport event. Door is a lazy map-content module, so the
	 * hook waits (once) until the first door entity type exists.
	 */
	private _mpDoorHookInstalled = false;
	private _mpEnsureDoorHook(): void {
		try {
			if (this._mpDoorHookInstalled) return;
			const Door: any = (ig.ENTITY as any).Door;
			if (!Door || typeof Door.inject !== 'function') return;
			this._mpDoorHookInstalled = true;
			Door.inject({
				collideWith(this: any, other: any, dir: any) {
					try {
						const m = (window as any).__mpMain;
						const p = ig.game && ig.game.playerEntity;
						const canLeave = !(sc as any).model || !(sc as any).model.isMapLeaveBlocked
							|| !(sc as any).model.isMapLeaveBlocked();
						if (m && m.netSync && p && other === p && this.map && this.active && canLeave
							&& typeof (ig.game as any).isInterruptible === 'function' && (ig.game as any).isInterruptible()
							&& this.coll && p.coll && this.coll.pos.z === p.coll.pos.z) {
							m.netSync.broadcastDoorOpen(this);
						}
					} catch (_) { /* the native walk must never break */ }
					return this.parent(other, dir);
				},
			});
		} catch (_) { /* hook is cosmetic */ }
	}

	/** ROUND 82: send our door's identity/position to the instance so members on the
	 * same map can open their matching door and watch us walk through it. */
	public broadcastDoorOpen(door: any): void {
		try {
			const conn: any = this.main && this.main.connection;
			if (!conn || typeof conn.isOpen !== 'function' || !conn.isOpen()) return;
			if (typeof conn.doorTransition !== 'function') return;
			conn.doorTransition({
				map: ((ig.game as any).mapName || ''),
				x: Math.round(door.coll.pos.x),
				y: Math.round(door.coll.pos.y),
				z: Math.round(door.coll.pos.z),
				dir: typeof door.dir === 'string' ? door.dir : 'SOUTH',
				targetMap: typeof door.map === 'string' ? door.map : '',
				marker: typeof door.marker === 'string' ? door.marker : '',
			});
		} catch (_) { /* never break the walk */ }
	}

	/** ROUND 82: a remote player opened a door on our map — find our matching door
	 * (same target map/marker nearest the relayed spot), open it, and let the remote
	 * mirror pass during the open window (restoring collision right after it closes). */
	public applyRemoteDoorOpen(info: any): void {
		try {
			if (!info || !ig.game || (ig.game as any).mapName !== info.map) return;
			const doors: any[] = Array.isArray(ig.game.entities) ? ig.game.entities : [];
			let best: any = null;
			let bestDist = Infinity;
			for (let i = 0; i < doors.length; i++) {
				const d = doors[i];
				if (!d || !(d instanceof (ig.ENTITY as any).Door) || !d.coll || d._killed) continue;
				if (info.targetMap && d.map !== info.targetMap) continue;
				if (info.marker && d.marker !== info.marker) continue;
				const dx = d.coll.pos.x - (typeof info.x === 'number' ? info.x : 0);
				const dy = d.coll.pos.y - (typeof info.y === 'number' ? info.y : 0);
				const dist = dx * dx + dy * dy;
				if (dist < bestDist) { bestDist = dist; best = d; }
			}
			if (!best || bestDist > 96 * 96) return;
			try {
				// ROUND 85 (door stuck fix): the door MUST pass remote mirrors while it
				// is open, so set ignoreCollision temporarily. Restoring it must NOT depend
				// on openTimer: a player standing in the doorway keeps getOverlappingEntities
				// non-empty, which pins openTimer at 1 forever, and the old conditional
				// restore then never fired — leaving ignoreCollision=true permanently and
				// making the door unresponsive for everyone until the map reloaded. The
				// per-frame pump (_mpUpdateDoorIgnores) now restores it after a fixed
				// wall-clock grace; later remote opens extend the deadline.
				let entry: any = null;
				for (const r of this._mpDoorIgnoreRestores) {
					if (r.door === best) { entry = r; break; }
				}
				const now = Date.now();
				if (!entry) {
					entry = { door: best, prev: !!best.coll.ignoreCollision, until: now + 2000 };
					this._mpDoorIgnoreRestores.push(entry);
				}
				entry.until = Math.max(entry.until, now + 2000);
				best.coll.ignoreCollision = true;
				// open(false) plays the sound at the door (spatial) and auto-closes after
				// the same preWait window the owner's door uses.
				best.open(false);
			} catch (_) { /* ignore */ }
		} catch (_) { /* cosmetic — never break the frame */ }
	}

	/** ROUND 85: restore door collision-ignore flags after their fixed grace. Runs
	 * every frame from tick() — deliberately wall-clock based, NOT openTimer based,
	 * because a body in the doorway can hold openTimer at 1 indefinitely. */
	private _mpUpdateDoorIgnores(): void {
		try {
			if (!this._mpDoorIgnoreRestores.length) return;
			const now = Date.now();
			for (let i = this._mpDoorIgnoreRestores.length - 1; i >= 0; i--) {
				const r = this._mpDoorIgnoreRestores[i];
				const alive = !!(r.door && !r.door._killed && r.door.coll);
				if (alive && now < r.until) continue;
				if (alive) r.door.coll.ignoreCollision = r.prev;
				this._mpDoorIgnoreRestores.splice(i, 1);
			}
		} catch (_) { /* cosmetic */ }
	}

	/** Round 19 (Part 2): drop cached per-mirror fade/collision state (map change /
	 * disconnect / cutscene end — the next per-frame pass re-evaluates from
	 * scratch, so freshly-spawned mirrors start correct). */
	public resetMirrorFadeCache(): void {
		try { this._mpMirrorFadeCache.clear(); } catch (_) { /* ignore */ }
	}

	/** ROUND 82: drop ONE mirror's cached fade state after its leave-fade kill, so a
	 * long town session with many door round-trips can't grow the cache with dead
	 * entity keys. */
	public forgetMirrorFade(e: any): void {
		try { this._mpMirrorFadeCache.delete(e); } catch (_) { /* ignore */ }
	}

	/**
	 * ROUND 19 (Part 3, step 5): cutscene-stream cleanup, fired by the enterGame
	 * wrap. Live story enemies may PERSIST past the scene (a boss / spawner output
	 * stays on the map), so we deliberately do NOT kill _mpCutsceneSpawned
	 * entities here — the sender stream is presence-driven (it only emits while a
	 * cutscene enemy is alive), so there is nothing to stop. Just drop cached
	 * mirror fade state so the next pass re-evaluates cleanly.
	 */
	public cutsceneCleanup(): void {
		try { this.resetMirrorFadeCache(); } catch (_) { /* ignore */ }
	}

	/** Round 19 (Part 3): kill every cutscene puppet + drop the stream bookkeeping
	 * (map change / disconnect). kill(true) = silent, no loot/FX. */
	public clearCsPuppets(): void {
		try {
			for (const key in this.csPuppets) {
				const pe = this.csPuppets[key];
				if (pe && !pe._killed) { try { pe.kill(true); } catch (_) { /* ignore */ } }
				delete this.csPuppets[key];
				delete this.lastAnim[key];
			}
		} catch (_) { /* ignore */ }
		this._mpCsOwnerSeen = Object.create(null);
		this.resetMirrorFadeCache();
	}

	/**
	 * ROUND 19 (Part 3, step 3): stream this client's live cutscene-spawned
	 * enemies (~15Hz via its own accumulator) so other clients can render them as
	 * csPuppets. Presence-driven: only emits while ANY _mpCutsceneSpawned enemy is
	 * alive (story enemies can persist past the scene). Gated !host — the host's
	 * own cutscene enemies already reach members via the normal entityState block
	 * (sendEnemyBlock), so sending them here too would double-render.
	 */
	private sendCutsceneEntityBlock(): void {
		try {
			if (this.main.host) return;
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			this._mpCsSendTimer -= ig.system.tick;
			if (this._mpCsSendTimer > 0) return;
			this._mpCsSendTimer = 0.066; // ~15Hz
			const list: any[] = [];
			const entities = ig.game.entities;
			const Enemy = (ig.ENTITY as any).Enemy;
			for (let i = 0; i < entities.length; i++) {
				const e: any = entities[i];
				if (!(e instanceof Enemy) || e._killed || e._mpMirror || !e.coll) continue;
				if (!e._mpCutsceneSpawned) continue;
				if (list.length >= 64) break;
				const face = e.face || { x: 0, y: 1 };
				list.push({
					// uid = ig.Entity._lastId — the entity's own numeric id, stable per
					// enemy instance (the same field sendEnemyBlock uses for the block's
					// `i`). Every live entity carries it; no mapId needed.
					uid: e.uid,
					x: Math.round(e.coll.pos.x), y: Math.round(e.coll.pos.y), z: Math.round(e.coll.pos.z),
					fx: face.x, fy: face.y,
					t: e.enemyName || (e.enemyType && (e.enemyType as any).name) || '',
					a: typeof e.currentAnim === 'string' ? e.currentAnim : '',
					h: e.params ? e.params.currentHp : 0,
					m: e.params && e.params.getStat ? e.params.getStat('hp') : 0,
				});
			}
			if (!list.length) return;
			conn.updateCutsceneEntityBlock({ map: this.mapName, list });
		} catch (_) { /* never break the frame */ }
	}

	/**
	 * ROUND 19 (Part 3, step 4): a client's cutscene-spawned monster stream
	 * arrived. Render the entries as csPuppets — typed, position-locked, animated
	 * and HP-synced exactly like a host-block puppet, but IGNORE-collided. NO
	 * damage interaction this round: members can't hurt them and they can't hurt
	 * members (they're cosmetic renderings of someone else's story monsters).
	 */
	private applyCutsceneEntity(from: string, data: { map: string, list: any[] }): void {
		try {
			if (!from || from === this.main.name) return;      // skip own echo
			if (this.main.host) return;                       // host renders real enemies
			if (!data || !Array.isArray(data.list)) return;
			if (!data.map || data.map !== this.mapName) return; // stream for a map we left
			const now = Date.now();
			this._mpCsOwnerSeen[from] = now;
			const seen: { [key: string]: boolean } = Object.create(null);
			for (const s of data.list) {
				if (!s || typeof s.uid !== 'number') continue;
				const key = 'cs' + s.uid;
				seen[key] = true;
				let e: any = this.csPuppets[key];
				if (!e || e._killed) {
					e = this.spawnCutscenePuppet(s);
					if (!e) continue;
					e._mpFrom = from;
					this.csPuppets[key] = e;
				}
				// Position interpolation targets (same _mpTo*/_mpSnapNext contract as
				// the host-block path, so interpolatePuppets glides them smoothly).
				if (e._mpToX !== s.x || e._mpToY !== s.y || e._mpToZ !== s.z) {
					e._mpToX = s.x; e._mpToY = s.y; e._mpToZ = s.z;
					if (e._mpSnapNext) {
						e._mpSnapNext = false;
						const cp = e.coll && e.coll.pos;
						if (cp) { cp.xProtected = s.x; cp.yProtected = s.y; cp.zProtected = s.z; }
					}
				}
				if (e.face && (e.face.xProtected !== s.fx || e.face.yProtected !== s.fy)) {
					e.face.xProtected = s.fx; e.face.yProtected = s.fy;
				}
				// Anim + HP, change-gated like applyEntityState (round-18 notify pattern
				// so the puppet's StatusBar animates damage smoothly).
				if (s.a && !e._mpDying && this.lastAnim[key] !== s.a) {
					this.lastAnim[key] = s.a;
					e.currentAnim = { protected: s.a };
					this.playAnim(e, s.a);
				}
				if (e.params) {
					const hpBefore = e.params.currentHp;
					if (e.params.currentHp !== s.h) e.params.currentHp = s.h;
					if (s.m > 0 && e.params.baseParams && e.params.baseParams.hp !== s.m) e.params.baseParams.hp = s.m;
					if (e.params.currentHp !== hpBefore) {
						try { (sc as any).Model.notifyObserver(e.params, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
					}
				}
			}
			// Reap: THIS owner's csPuppets whose uid left the stream -> silently killed
			// (the real enemy died/despawned on the owner's side).
			for (const key in this.csPuppets) {
				const pe = this.csPuppets[key];
				if (!pe || pe._mpFrom !== from) continue;
				if (!seen[key]) {
					try { if (!pe._killed) pe.kill(true); } catch (_) { /* ignore */ }
					delete this.csPuppets[key];
					delete this.lastAnim[key];
				}
			}
			// Orphan reap: an owner whose stream stopped (>2s — left the map /
			// disconnected) has its csPuppets removed by the next apply from anyone.
			for (const key in this.csPuppets) {
				const pe = this.csPuppets[key];
				if (!pe || !pe._mpFrom || pe._mpFrom === from) continue;
				const last = this._mpCsOwnerSeen[pe._mpFrom];
				if (typeof last === 'number' && now - last > 2000) {
					try { if (!pe._killed) pe.kill(true); } catch (_) { /* ignore */ }
					delete this.csPuppets[key];
					delete this.lastAnim[key];
				}
			}
		} catch (_) { /* never break block apply */ }
	}

	/** Round 19 (Part 3): spawn a typed csPuppet for a cutscene entity snap (the
	 * type must be preloaded like spawnTypedPuppet does; pendingTypes prevents
	 * duplicate spawns while the async load is in flight). Returns the entity or
	 * null (blocked spawn / type not yet resident). */
	private spawnCutscenePuppet(s: any): any {
		try {
			const type = s.t;
			if (!type) return null;
			if (this.pendingTypes[type]) return null;
			const t0 = new sc.EnemyType(type);
			if (!(t0 as any).loaded) {
				this.pendingTypes[type] = true;
				t0.load(() => { delete this.pendingTypes[type]; });
				return null;
			}
			const e = ig.game.spawnEntity('Enemy', s.x, s.y, s.z, {
				enemyInfo: { type },
				skipHook: true,
			} as any);
			if (!e) return null;
			this.initCutscenePuppet(e, s);
			return e;
		} catch (_) {
			if (s && s.t) delete this.pendingTypes[s.t];
			return null;
		}
	}

	/** Round 19 (Part 3): apply the shared puppet semantics to a freshly-spawned
	 * csPuppet: position lock (lockEntity), _mpPuppet (the Enemy.update inject runs
	 * the captured Combatant.update — no local AI), params.isDefeated() -> false
	 * (never locally "defeated"), and coll.type = IGNORE (walk-through during the
	 * cutscene — no body-blocking either direction, and they neither damage nor
	 * take damage from members this round). */
	private initCutscenePuppet(e: any, s: any): void {
		try {
			e._mpPuppet = true;
			e._mpSnapNext = true;
			try { this.main.lockEntity(e, { x: s.x, y: s.y, z: s.z }); } catch (_) { /* ignore */ }
			try { if (e.setTarget) e.setTarget(null); } catch (_) { /* ignore */ }
			// ROUND 80: setType keeps the spatial hash consistent with IGNORE.
			try {
				if (e.coll && typeof e.coll.setType === 'function') e.coll.setType((ig as any).COLLTYPE.IGNORE);
				else if (e.coll) e.coll.type = (ig as any).COLLTYPE.IGNORE;
			} catch (_) { /* ignore */ }
			try {
				if (e.params && !e.params._mpIsDefeatedPatched) {
					e.params._mpIsDefeatedPatched = true;
					e.params.isDefeated = function () { return false; };
				}
			} catch (_) { /* ignore */ }
		} catch (_) { /* never break a spawn */ }
	}

	/**
	 * ROUND 62 (step 1): HOST side — stream every live enemy projectile (Ball/Stone
	 * with party ENEMY) at `blockInterval` (the option-driven 怪物同步频率, default
	 * 30Hz) so members can see the enemy's ranged attacks (弹幕). Enemy projectiles only
	 * exist while an enemy is hostile, so this shares the hostile stream's cadence.
	 * The host is the only client that runs real enemy AI, so only it spawns enemy
	 * projectiles (SHOOT_PROXY -> proxy.spawn -> ig.ENTITY.Ball/Stone). Each snap
	 * carries the projectile's uid, kind (Ball/Stone), the SOURCE enemy uid + proxy
	 * name (so a member rebuilds the same projectile visual from its own puppet's
	 * proxy data), position, and 2D velocity (flight angle only). Presence-driven:
	 * emits only while an enemy projectile is alive.
	 */
	private sendProjectileBlock(): void {
		try {
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			this._mpProjSendTimer -= ig.system.tick;
			if (this._mpProjSendTimer > 0) return;
			this._mpProjSendTimer = this.blockInterval;
			const list: any[] = [];
			const entities = ig.game.entities;
			const Projectile = (ig.ENTITY as any).Projectile;
			const Stone = (ig.ENTITY as any).Stone;
			const EnemyParty = (sc as any).COMBATANT_PARTY.ENEMY;
			for (let i = 0; i < entities.length; i++) {
				const e: any = entities[i];
				if (!(e instanceof Projectile) || e._killed || !e.coll) continue;
				if (e.party !== EnemyParty) continue;          // only ENEMY projectiles (not player throws)
				if (e._mpMirror || e._mpProj) continue;       // never re-stream a visual copy
				const combatant = e.combatant;
				let src = 0;
				let pn = '';
				if (combatant && typeof combatant.uid === 'number' && combatant.proxies) {
					src = combatant.uid;
					// Reverse-lookup the proxy name by animSheet identity: setBallInfo /
					// setStoneInfo assign `this.animSheet = config.animation` directly, so a
					// projectile's animSheet IS its proxy's data.animation object.
					for (const name in combatant.proxies) {
						const p = combatant.proxies[name];
						if (p && p.data && p.data.animation === e.animSheet) { pn = name; break; }
					}
				}
				const vel = e.coll.vel || { x: 0, y: 0 };
				list.push({
					i: e.uid,
					k: (e instanceof Stone) ? 'S' : 'B',
					src,
					pn,
					x: Math.round(e.coll.pos.x), y: Math.round(e.coll.pos.y), z: Math.round(e.coll.pos.z),
					vx: Math.round(vel.x), vy: Math.round(vel.y),
				});
				if (list.length >= 64) break;
			}
			if (!list.length) return;
			conn.updateProjectileState(this.mapName, list);
		} catch (_) { /* never break the frame */ }
	}

	/**
	 * ROUND 62 (step 2): MEMBER side — the host's enemy-projectile stream arrived.
	 * Spawn/update visual-only Ball/Stone copies keyed by uid. Absent uids are NOT
	 * reaped here (the host sends no empty blocks) — reapStaleProjectiles handles that
	 * on a ~150ms cadence.
	 */
	private applyProjectileState(map: string, list: any[]): void {
		try {
			if (this.main.host) return;                        // host renders its own real projectiles
			if (!map || map !== this.mapName) return;          // stream for a map we left
			if (!Array.isArray(list)) return;
			const now = Date.now();
			for (const s of list) {
				if (!s || typeof s.i !== 'number') continue;
				let e: any = this.projectiles[s.i];
				if (!e || e._killed) {
					e = this.spawnProjectilePuppet(s);
					if (!e) continue;                          // source puppet not ready — retry next block
					this.projectiles[s.i] = e;
				}
				e._mpProjSeen = now;
				// Position target (same _mpTo*/_mpSnapNext contract as puppets, so
				// interpolatePuppets glides it smoothly between blocks).
				if (e._mpToX !== s.x || e._mpToY !== s.y || e._mpToZ !== s.z) {
					e._mpToX = s.x; e._mpToY = s.y; e._mpToZ = s.z;
					if (e._mpSnapNext) {
						e._mpSnapNext = false;
						const cp = e.coll && e.coll.pos;
						if (cp) { cp.xProtected = s.x; cp.yProtected = s.y; cp.zProtected = s.z; }
					}
				}
				// ROUND 80 (projectile interpolation): dead-reckon from the latest
				// sample instead of converging to it. Keep the stream's velocity
				// (falling back to the proxy's nominal speed only when the host
				// reports a parked projectile), estimate the sample window from
				// observed packet intervals, and let interpolatePuppets advance a
				// moving target through that window. The old "converge to snapshot"
				// lerp visibly decelerated before every block and, without a final
				// death packet, left the visual short of the impact point.
				const vxRaw = typeof s.vx === 'number' ? s.vx : 0;
				const vyRaw = typeof s.vy === 'number' ? s.vy : 0;
				const rawLen = Math.hypot(vxRaw, vyRaw);
				// Prefer the host's ACTUAL velocity magnitude (behaviors like
				// SLOW_DOWN legitimately change it); the proxy's nominal speed is only
				// a first-sample fallback. Zero means the host projectile is parked —
				// dead-reckoning must park too, not resume at nominal speed.
				let spd = rawLen;
				if (!(spd > 0)) spd = (typeof e.speed === 'number' && e.speed > 0)
					? e.speed
					: ((e.coll && typeof e.coll.maxVel === 'number' && e.coll.maxVel > 0) ? e.coll.maxVel : 0);
				let nvx = vxRaw, nvy = vyRaw;
				if (rawLen > 0 && spd > 0 && spd !== rawLen) { nvx = vxRaw / rawLen * spd; nvy = vyRaw / rawLen * spd; }
				e._mpProjVelX = nvx;
				e._mpProjVelY = nvy;
				// Flight angle: the projectile rotates from its 2D velocity (Projectile.update
				// recomputes animState.angle from coll.vel every frame).
				if (e.coll && e.coll.vel) { e.coll.vel.x = nvx; e.coll.vel.y = nvy; }
				// Observed packet interval -> the dead-reckon window (one host block).
				const prevAt: number = (typeof e._mpProjBaseAt === 'number' && e._mpProjBaseAt > 0) ? e._mpProjBaseAt : 0;
				if (prevAt > 0 && now - prevAt >= 5 && now - prevAt <= 500) {
					const measured = now - prevAt;
					const old = (typeof e._mpProjWindowMs === 'number' && e._mpProjWindowMs > 0) ? e._mpProjWindowMs : measured;
					e._mpProjWindowMs = Math.max(16, Math.min(250, old * 0.7 + measured * 0.3));
				} else if (!(e._mpProjWindowMs > 0)) {
					e._mpProjWindowMs = Math.max(16, Math.min(250, this.blockInterval * 1000));
				}
				e._mpProjBaseX = s.x; e._mpProjBaseY = s.y; e._mpProjBaseZ = s.z;
				e._mpProjBaseAt = now;
			}
		} catch (_) { /* never break block apply */ }
	}

	/**
	 * ROUND 62 (step 3): spawn a VISUAL-ONLY copy of a host enemy projectile, rebuilt
	 * from the SOURCE enemy puppet's proxy data so it renders identically to the host's
	 * (same animation sheet / effects / light / size). The copy is then neutralized —
	 * party OTHER, coll IGNORE, no attackInfo/hitProxy/behaviors/timer — so it never
	 * hits, damages, self-destructs, or steers. Position is locked (lockEntity) and the
	 * stream drives its flight; only the 2D velocity is kept so it ROTATES correctly.
	 * Returns the neutralized entity, or null when the source puppet isn't ready yet
	 * (the next block retries).
	 */
	private spawnProjectilePuppet(s: any): any {
		try {
			const puppet = this.puppets[s.src];
			if (!puppet || puppet._killed || !puppet.proxies) return null;
			const proxy = (sc as any).ProxyTools.getProxy(s.pn, puppet);
			if (!proxy || !proxy.data || typeof proxy.spawn !== 'function') return null;
			// Spawn through the proxy's own spawn() so the animation sheet, effects and
			// light all come from the source enemy's data (BallInfo.spawn -> ig.ENTITY.Ball,
			// StoneInfo.spawn -> ig.ENTITY.Stone). The proxy normalizes velocity to its own
			// speed, so only the DIRECTION from the stream matters.
			const e = proxy.spawn(s.x, s.y, s.z, puppet, { x: s.vx || 0, y: s.vy || 0 });
			if (!e) return null;
			// Neutralize: no damage, no collision, no self-destruct, no AI behaviors.
			e.party = (sc as any).COMBATANT_PARTY.OTHER;
			// ROUND 80: setType keeps the spatial hash consistent with IGNORE.
			try {
				if (e.coll && typeof e.coll.setType === 'function') e.coll.setType((ig as any).COLLTYPE.IGNORE);
				else if (e.coll) e.coll.type = (ig as any).COLLTYPE.IGNORE;
			} catch (_) { /* ignore */ }
			e.attackInfo = null;
			e.hitProxy = null;
			e.combatant = null;
			e.target = null;
			e.behaviors = null;
			e.grab = null;
			e.destroyProxySrc = null;
			e.bounceProxySrc = null;
			e.timer = 0; // Ball.update only ticks the timer while > 0 -> never self-destructs
			e._mpProj = true;
			e._mpSnapNext = true;
			this.main.lockEntity(e, { x: s.x, y: s.y, z: s.z });
			return e;
		} catch (_) { return null; }
	}

	/** Round 62 (step 4): reap visual projectile copies whose host projectile stopped
	 * being seen (>200ms = ~3 stream blocks). Short-lived by nature; the grace smooths
	 * over a single dropped block without leaving dead projectiles frozen on screen. */
	private reapStaleProjectiles(): void {
		try {
			const now = Date.now();
			for (const uid in this.projectiles) {
				const e = this.projectiles[uid];
				if (!e) { delete this.projectiles[uid]; continue; }
				if (e._killed || (typeof e._mpProjSeen === 'number' && now - e._mpProjSeen > 200)) {
					if (!e._killed) { try { e.kill(true); } catch (_) { /* ignore */ } }
					delete this.projectiles[uid];
				}
			}
		} catch (_) { /* never break the frame */ }
	}

	/** Round 62: kill every visual projectile copy + drop the stream bookkeeping
	 * (map change / logout / server loss). kill(true) = silent, no FX. */
	public clearProjectiles(): void {
		try {
			for (const uid in this.projectiles) {
				const e = this.projectiles[uid];
				if (e && !e._killed) { try { e.kill(true); } catch (_) { /* ignore */ } }
				delete this.projectiles[uid];
			}
		} catch (_) { /* ignore */ }
	}

	/**
	 * Engine group aggro: the same call the vanilla proximity-aggro path makes when
	 * an enemy acquires a target (`sc.combat.notifyNearbyEnemiesOfTarget`). Radius
	 * comes from the enemy's own targetDetect.notifyNeighbourRadius so each enemy
	 * type aggros its natural cluster size.
	 */
	public notifyGroupAggro(enemy: any): void {
		try {
			const scAny: any = sc as any;
			if (!scAny.combat || typeof scAny.combat.notifyNearbyEnemiesOfTarget !== 'function') return;
			const td = enemy && enemy.enemyType && enemy.enemyType.targetDetect;
			const radius = (td && typeof td.notifyNeighbourRadius === 'number') ? td.notifyNeighbourRadius : 150;
			scAny.combat.notifyNearbyEnemiesOfTarget(enemy, radius);
		} catch (_) { /* ignore */ }
	}

	/** True while the local player is in our custom death state. */
	public isLocalDead(): boolean { return this._mpDead; }

	/** Silent end of the death state for an IMMINENT teleport: restore HP/camera
	 * but do NOT move the player — the teleport itself places them. Without this a
	 * teleport during the countdown (server party-move, menu travel) leaves the pin
	 * writing stale death-map coordinates onto the player in the new map. */
	public abortDeathForTeleport(): void {
		if (!this._mpDead) return;
		console.log('[multiplayer] teleport during death — aborting death state');
		const p: any = ig.game && ig.game.playerEntity;
		if (p && p.params) this.respawn(p, true);
		else this.clearDeathState();
	}

	private localInCombat(): boolean {
		try {
			const m: any = sc as any;
			return !!(m.model && m.model.isCombatMode && m.model.isCombatMode());
		} catch (_) { return false; }
	}

	/** Round 11: while partied the menus no longer pause the world, so an enemy can
	 * hit us while the bag (背包) is open. Detect the HP drop and force-close the
	 * menu so the hit reaction is visible and the player regains control. */
	private checkMenuCloseOnHit(): void {
		try {
			const p: any = ig.game && ig.game.playerEntity;
			if (!p || !p.params) { this._mpLastLocalHp = -1; return; }
			const hp = p.params.currentHp;
			const prev = this._mpLastLocalHp;
			this._mpLastLocalHp = hp;
			if (prev < 0 || hp >= prev || this._mpDead) return; // no damage this frame
			const mdl: any = (sc as any).model;
			if (mdl && typeof mdl.isMenu === 'function' && mdl.isMenu() && typeof mdl.enterRunning === 'function') {
				console.log('[netsync] attacked while in menu — auto-closing menu');
				mdl.enterRunning();
			}
		} catch (_) { /* never let sync crash the frame */ }
	}

	// ---- party charge time-stop (round 10) ----

	/** True while the LOCAL player is charging a skill/ball. Engine fact: the charge
	 * state lives on the player entity as `charging.time` (-1 = not charging, >= 0 =
	 * charging; accumulates in REAL time via ig.system.actualTick). */
	private localCharging(): boolean {
		try {
			const p: any = ig.game && ig.game.playerEntity;
			return !!(p && p.charging && p.charging.time >= 0);
		} catch (_) { return false; }
	}

	/** Party-wide charge time-stop. Vanilla charges stop the world with a named
	 * ig.slowMotion handle ("playerCharge", factor 0.1 over 0.2s) and exempt the
	 * charging player via coll.time.animStatic. For multiplayer we reproduce that
	 * freeze NETWORK-WIDE: every client streams its cg flag; while at least one PARTY
	 * member charges we hold our own 'mpCharge' handle (same 0.1 factor). Consequences
	 * by design:
	 *  - the first charger freezes everyone's world (players included);
	 *  - while frozen, others can ALSO start charging (their update still runs at 10%
	 *    and the charge meter itself fills at real time) — each new charger gets
	 *    animStatic on their own client and on every mirror;
	 *  - a charger who releases early has their fired skill crawl at 10% until the LAST
	 *    charger lets go, so all charged skills effectively land together when time
	 *    resumes;
	 *  - local charging is left to vanilla's own handle; ours additionally covers the
	 *    "I released but a teammate is still charging" case vanilla can't know about.
	 * Solo play is untouched (partyMembers <= 1 -> no handle). */
	private updateChargeFreeze(): void {
		try {
			const party: string[] = this.main.partyMembers;
			if (!party || party.length <= 1) {
				if (this._mpChargeFrozen) this.clearChargeFreeze();
				return;
			}
			let any = this.localCharging();
			if (!any) {
				for (const name in this.main.players) {
					if (party.indexOf(name) === -1) continue;
					const ent: any = this.main.players[name] && this.main.players[name]!.entity;
					if (ent && !ent._killed && ent._mpCharging) { any = true; break; }
				}
			}
			const sm: any = (ig as any).slowMotion;
			if (!sm || typeof sm.add !== 'function') return;
			if (any && !this._mpChargeFrozen) {
				sm.add(0.1, 0.2, 'mpCharge');
				this._mpChargeFrozen = true;
				console.log('[netsync] party charge time-stop engaged');
			} else if (!any && this._mpChargeFrozen) {
				this.clearChargeFreeze();
				console.log('[netsync] party charge time-stop released');
			}
		} catch (_) { /* visuals must never break sync */ }
	}

	/** Drop our shared charge slow-motion handle (map change / disconnect / party end). */
	private clearChargeFreeze(): void {
		try {
			if (this._mpChargeFrozen) {
				const sm: any = (ig as any).slowMotion;
				if (sm && typeof sm.clearNamed === 'function') sm.clearNamed('mpCharge', 0);
			}
		} catch (_) { /* ignore */ }
		this._mpChargeFrozen = false;
	}

	/** First live PARTY-member mirror (a teammate we can spectate / respawn at).
	 * Round 8: strictly scoped to partyMembers — a live NON-party player in the same
	 * block must NOT count as "someone alive": they would block the checkpoint path
	 * and respawn us next to a stranger. Soft death/spectate radiates within the
	 * party only; solo-exploring a block (no party mirror present) goes straight to
	 * the checkpoint path even if other players are connected. */
	private firstLiveMirror(): any {
		const ms = this.liveMirrors();
		return ms.length > 0 ? ms[0] : null;
	}

	/** ALL live PARTY-member mirrors (round 11: spectate cycling with LMB/RMB).
	 * Same strict party scoping as firstLiveMirror. */
	private liveMirrors(): any[] {
		const out: any[] = [];
		const party = this.main.partyMembers;
		for (const name in this.main.players) {
			if (party.indexOf(name) === -1) continue; // not our party -> never counts
			const ent = this.main.players[name] && this.main.players[name]!.entity;
			if (ent && !ent._killed && ent.coll) out.push(ent);
		}
		return out;
	}

	/**
	 * Own-player death & respawn (host AND member; each client owns its player):
	 *  - died IN combat  -> 30s countdown, camera locked onto a teammate's mirror
	 *    (spectator), controls blocked; if combat ends early, respawn right away;
	 *  - died OUT of combat -> respawn after a short beat (2s);
	 *  - teammate mirror gone (left/died) -> respawn immediately.
	 * The engine's native full-defeat flow is suppressed while connected (see the
	 * PartyModel.isDefeated inject in multiplayer.ts consulting isLocalDead()).
	 */
	private checkOwnDeath(): void {
		const p: any = ig.game.playerEntity;
		if (!p || !p.params) return;
		// ROUND 103: story PVP/arena/cutscene owns player death. Let the native
		// defeat flow run and clear any multiplayer soft-death state a switch into
		// one of those states could leave behind.
		if (this.nativeOwnsDeath()) {
			this._mpAllDeadAt = 0;
			if (this._mpDead) {
				try { this.respawn(p, true); } catch (_) { /* ignore */ }
			}
			return;
		}
		if (!this._mpDead) {
			// ROUND 103: use the engine's real defeat flag. HP can legitimately sit
			// at 0 without a defeat (SET_HP_CRITICAL / Karma Scale absorb), which used
			// to start the multiplayer death flow falsely.
			const defeated = !!(p.params
				&& typeof p.params.isDefeated === 'function'
				? (p.params.isDefeated() === true || (p.params.defeated === true))
				: p.params.currentHp <= 0);
			if (defeated && !p._killed) this.enterDeath(p);
			return;
		}
		// ---- dead ----
		p.params.currentHp = 0; // no out-of-combat regen while dead
		// Pin the corpse to the death spot: the engine has no plain control-block
		// setter (isControlBlocked is event-driven), so we simply revert any
		// movement each frame. playerState streams the death pos too, so the
		// mirror stays put for teammates. ONLY while still on the death map: if a
		// teleport slipped past us, re-anchor at the new map's position instead of
		// yanking the player back to stale coordinates.
		if (this._mpDeathPos && p.coll) {
			const curMap = (ig.game as any).mapName || '';
			if (curMap === this._mpDeathMap) {
				p.coll.pos.x = this._mpDeathPos.x;
				p.coll.pos.y = this._mpDeathPos.y;
				p.coll.pos.z = this._mpDeathPos.z;
			} else {
				this._mpDeathMap = curMap;
				this._mpDeathPos = { x: p.coll.pos.x, y: p.coll.pos.y, z: p.coll.pos.z };
				this._mpSpecEntity = null; // map load popped all camera targets; re-follow below
			}
		}
		const waited = Date.now() - this._mpDeadAt;
		const inCombat = this.localInCombat();
		// DEATH PRESENTATION (round 11): the corpse + death FX (pre_die blink, boom)
		// stay visible for ~1s so the player watches their own death; then the corpse
		// is hidden and the camera GLIDES over to a teammate (see followMirror below).
		if (!this._mpCorpseHidden && waited >= 1000) {
			this._mpCorpseHidden = true;
			try { if (typeof p.hide === 'function') p.hide(); } catch (_) { /* ignore */ }
			try {
				const et: any = (ig as any).EffectTools;
				if (et && typeof et.clearEffects === 'function') et.clearEffects(p);
			} catch (_) { /* ignore */ }
		}
		// Vanilla defeat flow already fired (whole party down): keep the GUI up until
		// the checkpoint teleport starts — do NOT re-trigger or respawn-in-place.
		if (this._mpCheckpointReloading) {
			// STALL SAFETY NET (round 8): the vanilla defeat flow is a blocking
			// ig.Event chain (~3.5s) ending in a LOAD teleport that our onTeleport
			// wrapper cleans up. If any step hangs (missing checkpoint data, event
			// conflict), the player would otherwise sit locked at 0 HP forever.
			// Escalate instead: >12s force a raw loadCheckpoint once; >18s give up
			// on the checkpoint and soft-respawn in place. The player is NEVER
			// permanently locked.
			const stallFor = this._mpCheckpointReloadAt ? Date.now() - this._mpCheckpointReloadAt : 0;
			if (stallFor > 18000) {
				console.warn('[multiplayer] checkpoint reload stalled >18s — soft respawn in place');
				this.respawn(p);
				return;
			}
			if (stallFor > 12000 && !this._mpCheckpointForced) {
				this._mpCheckpointForced = true;
				console.warn('[multiplayer] checkpoint reload stalled >12s — forcing raw loadCheckpoint');
				try {
					const st: any = (ig as any).storage;
					if (st && typeof st.loadCheckpoint === 'function') st.loadCheckpoint();
				} catch (e) { console.warn('[multiplayer] forced loadCheckpoint threw', e); }
			}
			this.updateDeathGui(waited, inCombat, true);
			return;
		}
		const mirror = this.firstLiveMirror();
		if (mirror) {
			// A teammate is still alive: spectate them and count down to an individual
			// respawn next to them. Any all-dead latch is cancelled — their being alive
			// means the party is NOT wiped.
			this._mpAllDeadAt = 0;
			// Round 14 (fix 4): LMB/RMB become spectate-switch while dead, BUT a menu
			// being open must restore the real mouse bindings instead — every GUI click
			// resolves through getGuiClick() = keyupd("aim"), which spectate bindings
			// unbound, silently killing all mouse clicks (the "cannot click ESC->设置"
			// bug). Runs every frame while dead, so bindings track menu open/close.
			this.updateSpecBindings();
			// The camera only moves once the 1s death presentation is over — and it
			// now GLIDES (smooth transition) instead of snapping (round 11).
			if (this._mpCorpseHidden) this.followMirror(mirror, true);
			// Round 11: LMB/RMB cycles the spectate target among live party members.
			this.checkSpectateSwitch();
			this.updateDeathGui(waited, inCombat, false);
			// 3s out of combat (was 2s): let the camera glide + spectate breathe a bit.
			const canRespawn = !inCombat ? waited >= 3000 : waited >= 30000;
			if (canRespawn) this.respawn(p);
		} else {
			// No live teammate mirror: the WHOLE party is down. Like vanilla single
			// player, that means defeat — everyone reads their last checkpoint together
			// (each client detects the wipe independently: own death + no live mirrors,
			// at roughly the same moment). Latch ~2s first: a teammate's last-instant
			// respawn (their dead flag dropping, mirror reappearing) still cancels it.
			if (!this._mpAllDeadAt) {
				this._mpAllDeadAt = Date.now();
				console.log('[multiplayer] whole party down — checkpoint reload in 2s');
			}
			if (this._mpPlayerCamDetached || this._mpSpecHandle) this.dropSpectate(false);
			this.updateDeathGui(waited, inCombat, true);
			if (Date.now() - this._mpAllDeadAt >= 2000) this.respawnAtCheckpoint(p);
		}
	}

	/** Whole-party wipe: run the VANILLA defeat flow — ig.game.respawn(): the
	 * playerDefeat effect + slow-mo/fade event chain ending in the LOAD step, which is
	 * ig.storage.loadCheckpoint() -> teleport to the last checkpoint with checkpoint
	 * HP — exactly the single-player death. We KEEP our death state (_mpDead, camera,
	 * GUI) through the ~3.5s cinematic: dead=1 keeps streaming so our mirror stays
	 * hidden for teammates until we reappear at the checkpoint; the moment the LOAD
	 * teleport starts, the onTeleport wrapper's abortDeathForTeleport() cleans the
	 * death state before the new map loads. */
	private respawnAtCheckpoint(p: any): void {
		this._mpAllDeadAt = 0;
		this._mpCheckpointReloading = true;
		this._mpCheckpointReloadAt = Date.now();
		this._mpCheckpointForced = false;
		console.log('[multiplayer] whole party down — loading last checkpoint (vanilla defeat flow)');
		try {
			const g: any = ig.game as any;
			if (g && typeof g.respawn === 'function') {
				// The ig.game.respawn shadow installed in install() swallows EVERY native
				// defeat call while connected — including our own. Explicitly allow this
				// one deliberate wipe-flow call (flag is checked synchronously at call
				// time; the ~3.5s cinematic that follows runs on its own).
				this._mpAllowRespawn = true;
				try { g.respawn(); return; } finally { this._mpAllowRespawn = false; }
			}
		} catch (e) { console.warn('[multiplayer] ig.game.respawn threw — raw checkpoint load instead', e); }
		try {
			const st: any = (ig as any).storage;
			if (st && typeof st.loadCheckpoint === 'function') { st.loadCheckpoint(); return; }
		} catch (e) { console.warn('[multiplayer] loadCheckpoint threw', e); }
		// Engine paths unavailable (shouldn't happen): fall back to respawn-in-place.
		this._mpCheckpointReloading = false;
		this.respawn(p);
	}

	/** No live teammate left to spectate (they died/left/disconnected), or we
	 * revived: return the camera to our own player. `smooth` (round 11) = glide
	 * back instead of snapping. */
	private dropSpectate(smooth?: boolean): void {
		try {
			const igAny: any = ig;
			const p: any = ig.game && ig.game.playerEntity;
			if (this._mpPlayerCamDetached && p && p.cameraHandle && igAny.camera) {
				// Push OUR handle first (that starts the glide), then pop the spectate
				// handle from under it. Same duplication guard as before: a map load
				// may have pushed a fresh player handle already.
				let already = false;
				try { already = !!(igAny.camera.targets && igAny.camera.targets.indexOf(p.cameraHandle) !== -1); } catch (_) { /* ignore */ }
				if (!already && igAny.camera.pushTarget) {
					try { igAny.camera.pushTarget(p.cameraHandle, smooth ? 'NORMAL' : 'IMMEDIATELY'); } catch (_) { /* ignore */ }
				}
				if (this._mpSpecHandle && igAny.camera.removeTarget) {
					try { igAny.camera.removeTarget(this._mpSpecHandle, 'IMMEDIATELY'); } catch (_) { /* ignore */ }
				}
			} else if (this._mpSpecHandle && igAny.camera && igAny.camera.removeTarget) {
				try { igAny.camera.removeTarget(this._mpSpecHandle, 'IMMEDIATELY'); } catch (_) { /* ignore */ }
			}
			this._mpSpecHandle = null;
			this._mpSpecEntity = null;
			this._mpPlayerCamDetached = false;
		} catch (_) { /* ignore */ }
	}

	private enterDeath(p: any): void {
		this._mpDead = true;
		this._mpDeadAt = Date.now();
		this._mpAllDeadAt = 0;
		this._mpCheckpointReloading = false;
		this._mpCheckpointReloadAt = 0;
		this._mpCheckpointForced = false;
		// Release the charge + party charge time-stop the instant we die. A player who
		// dies MID-CHARGE never runs Player.onKill -> clearCharge (manualKill gates that
		// kill), so charging.time stays >= 0, localCharging() stays true and
		// updateChargeFreeze holds the 'mpCharge' slow-motion (0.1x) forever — after a
		// full-party wipe + revive the host's enemy block then crawls at ~1/s instead of
		// the wilderness 15-60Hz. Clear BOTH the vanilla 'playerCharge' handle and ours.
		try { if (p && typeof p.clearCharge === 'function') p.clearCharge(); } catch (_) { /* ignore */ }
		this.clearChargeFreeze();
		this._mpDeathPos = p.coll ? { x: p.coll.pos.x, y: p.coll.pos.y, z: p.coll.pos.z } : null;
		this._mpDeathMap = (ig.game as any).mapName || '';
		// ROUND 103: remember the engine's last-safe respawn anchor for revival
		// placement (the mirror can be mid-air/over water; see pickReviveSpot).
		try {
			this._mpSafeRespawnPos = (p && p.respawn && p.respawn.pos && isFinite(p.respawn.pos.x))
				? { x: p.respawn.pos.x, y: p.respawn.pos.y, z: p.respawn.pos.z }
				: (this._mpDeathPos ? { ...this._mpDeathPos } : null);
		} catch (_) { this._mpSafeRespawnPos = this._mpDeathPos ? { ...this._mpDeathPos } : null; }
		// The engine's death flow (_onDeathHit) sets coll.type to IGNORE; remember
		// the prior type to restore on respawn. If it already ran (IGNORE), leave
		// null -> respawn restores the player default (COLLTYPE.VIRTUAL).
		try {
			const t = p.coll ? p.coll.type : undefined;
			this._mpDeathCollType = (t !== undefined && t !== 1 /* COLLTYPE.IGNORE */) ? t : null;
		} catch (_) { this._mpDeathCollType = null; }
		const inCombat = this.localInCombat();
		console.log('[multiplayer] local player died (inCombat=' + inCombat + ')'
			+ (inCombat ? ' — respawn in 30s or when combat ends' : ' — respawning shortly'));
		try { p.invincibleTimer = 9999; } catch (_) { /* ignore */ } // corpse takes no further hits
		// DEATH-HOLD (round 8): the engine's own death flow kills the player entity 0.5s
		// into the DYING state (Combatant.update -> this.kill() -> Player.onKill ->
		// observer teardown + ig.game.respawn()). Setting manualKill gates BOTH that
		// kill() and onCombatantDeathHit's respawn branch — the exact mechanism the
		// arena system uses (tmp.playerDeathArena). Our death system owns the corpse
		// until soft-revive/checkpoint; the only side effect is an ig.vars temp flag.
		// Cleared again in respawn()/clearDeathState().
		try { p.manualKill = 'tmp.mpSoftDeath'; } catch (_) { /* ignore */ }
		// DEATH PRESENTATION (round 11): vanilla has no death ANIM — the presentation
		// is an effect package, and we play the exact calls the engine's own death flow
		// uses: the pre_die blink + a boom burst (the combatant's own `death` sheet,
		// path "combatant" — already loaded). The corpse stays VISIBLE for ~1s; the
		// tick then hides it (with clearEffects, so no post-revive flicker — round 9)
		// and glides the camera to a teammate. The engine's combat death hit already
		// attached pre_die (duration:-1); ours is a finite-duration backstop so
		// non-combat deaths (spikes/fall) also blink.
		try {
			const deathFx: any = p.effects && p.effects.death;
			if (deathFx) {
				try { deathFx.spawnOnTarget('pre_die', p, { duration: 1.2 }); } catch (_) { /* ignore */ }
				try {
					if (p.coll) {
						// Round 13: spawn the death explosion WITHOUT the player as the effect
						// target. boom_medium carries a CHANGE_ALPHA step {alpha:0,duration:0.5}
						// that fades p.animState.alpha to 0; respawn() never explicitly restores
						// it (only the showRespawn fade does, and clearEffects can cut that off),
						// leaving the model invisible but movable. The corpse-hide at ~1s already
						// handles disappearance, so the boom just plays at the fixed position.
						deathFx.spawnFixed('boom_medium',
							p.coll.pos.x + p.coll.size.x / 2,
							p.coll.pos.y + p.coll.size.y + 1,
							p.coll.pos.z + p.coll.size.z / 2 + p.coll.size.y / 2 + 1, null);
					}
				} catch (_) { /* ignore */ }
			}
		} catch (_) { /* ignore */ }
		// Round 21 (issue 3): wipe-and-rebuild name tags on the LOCAL player's death so
		// our own tag can't survive the soft death. The per-frame pump rebuilds it (and
		// skips it while dead) next frame. wipeTags is internally guarded — a failure
		// must never abort the death flow.
		try { this.main.wipeTags(); } catch (_) { /* ignore */ }
		// ROUND 32 (item 8): on OUR OWN soft death, release every puppet we were
		// holding engaged so it de-aggros — the host has ALREADY de-aggro'd the
		// corpse (its lose-check drops a dead/IGNORE mirror within loseTime), but the
		// member-side puppet keeps fighting via the round-31 _mpEngaged re-pin
		// (block-apply @4725 re-pins any _mpEngaged puppet every block, and the
		// _mpTargetGuarded lock refuses setTarget(null) while _mpTg holds). That
		// asymmetry left a downed member still in combat, blocking the fast
		// "respawn when combat ends" revive. Clear _mpEngaged/_mpTg locally and drop
		// the puppet's target directly (bypassing the guard, exactly like the host's
		// de-aggro block does by clearing _mpTg first). HOST-UNAFFECTED: puppets
		// only exist on members. This touches ONLY the local aggro/target state —
		// NOT the round-27 damage gate (damage()/onPreDamageModification swallow of
		// puppet-rooted hits), so the "offscreen/de-aggro enemy can't hit / can't be
		// hit (both directions no damage)" fix is fully preserved: the host simply
		// stops forwarding combatHit once its enemy de-aggros, and any stray local
		// puppet hit is still swallowed as divergent.
		try {
			if (!this.main.host) {
				for (const uidStr in this.puppets) {
					const e: any = this.puppets[uidStr];
					if (!e || e._killed || !e._mpEngaged) continue;
					e._mpEngaged = null;
					e._mpTg = false; // clear BEFORE setTarget(null) so the guard lets it through
					try { if (e.setTarget && e.target) e.setTarget(null); } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
		this.showDeathGui(inCombat);
		// NOTE: the spectator camera attaches ~1s later in checkOwnDeath() with a SMOOTH
		// transition, NOT here — the user watches their own death FX first (round 11).
	}

	/** Lock the camera onto a teammate mirror (spectator). Swaps if the current
	 * spectate target died/left. `smooth` = glide instead of snap (round 11). */
	private followMirror(mirror: any, smooth?: boolean): void {
		if (this._mpSpecEntity === mirror && this._mpSpecHandle) return;
		try {
			const igAny: any = ig;
			const p: any = ig.game.playerEntity;
			const trans = smooth ? 'NORMAL' : 'IMMEDIATELY';
			const newHandle = new igAny.Camera.TargetHandle(new igAny.Camera.EntityTarget(mirror), 0, 0);
			// Push the new target FIRST so the camera starts its transition toward it,
			// then pop the old one from under it with IMMEDIATELY (the glide is already
			// underway; removing a non-top target doesn't move the view).
			igAny.camera.pushTarget(newHandle, trans);
			if (this._mpSpecHandle && igAny.camera.removeTarget) {
				try { igAny.camera.removeTarget(this._mpSpecHandle, 'IMMEDIATELY'); } catch (_) { /* ignore */ }
			}
			// Detach the player's own camera handle so the view fully follows the
			// teammate instead of blending corpse + mirror (once per death).
			if (!this._mpPlayerCamDetached && p && p.cameraHandle && igAny.camera && igAny.camera.removeTarget) {
				try { igAny.camera.removeTarget(p.cameraHandle, 'IMMEDIATELY'); this._mpPlayerCamDetached = true; } catch (_) { /* ignore */ }
			}
			this._mpSpecHandle = newHandle;
			this._mpSpecEntity = mirror;
		} catch (e) {
			console.warn('[multiplayer] spectator camera failed', e);
			this._mpSpecHandle = null;
		}
	}

	/** Round 11: LMB/RMB cycles the spectate target among live party mirrors
	 * (the bindings are swapped in armSpecBindings while dead). */
	private checkSpectateSwitch(): void {
		try {
			// Round 14 (fix 4): never consume menu clicks as spectate switches. Menus open
			// unpaused while partied, and the spectate bindings shadow MOUSE1/MOUSE2 — belt
			// and braces on top of updateSpecBindings() so a menu click is never eaten.
			const mdl: any = (sc as any).model;
			if (mdl && ((mdl.isMenu && mdl.isMenu())
				|| (mdl.isPaused && mdl.isPaused())
				|| (mdl.isQuickMenu && mdl.isQuickMenu()))) return;
			const inp: any = (ig as any).input;
			if (!inp || typeof inp.pressed !== 'function') return;
			const next = inp.pressed('mpSpecNext');
			const prev = inp.pressed('mpSpecPrev');
			if (!next && !prev) return;
			const list = this.liveMirrors();
			if (list.length < 2) return;
			let idx = list.indexOf(this._mpSpecEntity);
			if (idx < 0) idx = 0;
			idx = (idx + (next ? 1 : -1) + list.length) % list.length;
			this.followMirror(list[idx], true);
		} catch (_) { /* ignore */ }
	}

	/** Round 11: swap MOUSE1/MOUSE2 to the spectate-switch actions while dead.
	 * The original bindings (aim/dash defaults — or whatever the user rebound them
	 * to) are captured here and restored on revive/disconnect. ig.input keeps ONE
	 * action per key, so a plain re-bind is the only way to read mouse edges. */
	private armSpecBindings(): void {
		if (this._mpOrigMouseBinds) return; // already armed
		try {
			const inp: any = (ig as any).input;
			if (!inp || typeof inp.bind !== 'function' || !inp.bindings) return;
			this._mpOrigMouseBinds = { m1: inp.bindings[-1], m2: inp.bindings[-3] };
			inp.bind(-1 /* ig.KEY.MOUSE1 */, 'mpSpecNext');
			inp.bind(-3 /* ig.KEY.MOUSE2 */, 'mpSpecPrev');
		} catch (_) { this._mpOrigMouseBinds = null; }
	}

	private restoreMouseBindings(): void {
		if (!this._mpOrigMouseBinds) return;
		try {
			const inp: any = (ig as any).input;
			if (inp && typeof inp.bind === 'function') {
				if (this._mpOrigMouseBinds.m1) inp.bind(-1, this._mpOrigMouseBinds.m1);
				if (this._mpOrigMouseBinds.m2) inp.bind(-3, this._mpOrigMouseBinds.m2);
			}
		} catch (_) { /* ignore */ }
		this._mpOrigMouseBinds = null;
	}

	/** Round 14 (fix 4): while dead with a live teammate mirror, keep MOUSE1/MOUSE2
	 * usable for GUI clicks whenever a menu is open. Menus don't pause while partied,
	 * and every GUI click resolves through getGuiClick() = ig.input.keyupd("aim") —
	 * armSpecBindings() rebinds MOUSE1/MOUSE2 to mpSpecNext/mpSpecPrev, unbounding
	 * "aim", so with the menu open all mouse clicks would silently die. When a menu
	 * substate is up we restore the real bindings; otherwise re-arm the spectate
	 * switches. restoreMouseBindings nulls _mpOrigMouseBinds, so re-arming cleanly
	 * re-captures the originals each cycle. Runs from checkOwnDeath's dead+mirror
	 * branch every frame. */
	private updateSpecBindings(): void {
		try {
			const mdl: any = (sc as any).model;
			const menuOpen = !!(mdl && ((mdl.isMenu && mdl.isMenu())
				|| (mdl.isPaused && mdl.isPaused())
				|| (mdl.isQuickMenu && mdl.isQuickMenu())));
			if (menuOpen) this.restoreMouseBindings(); // aim/dash back -> GUI clicks work
			else this.armSpecBindings();
		} catch (_) { this.armSpecBindings(); }
	}

	private showDeathGui(inCombat: boolean): void {
		try {
			// NOTE: TextGui has no `fontSize` option (valid: font/speed/textAlign/
			// maxWidth/...) and setText takes ONE arg — don't pass extras.
			const gui = new (sc as any).TextGui('');
			(ig as any).gui.addGuiElement(gui);
			// Round 17 (issue 3): the engine centers a plain TextGui via ALIGNMENT at draw
			// time (X_CENTER = containerW/2 - size.x/2 + pos.x; the root container is
			// ig.system.width), and sc.TextGui.setText refreshes hook.size, so the countdown
			// auto-tracks its own width — no pivot/re-anchor needed (setPivot is INERT for a
			// plain TextGui: pivot is only consumed in the clip/scale/rotate branch of
			// ig.Gui._drawRecursive). Set the alignment once here; setText handles the rest.
			try { gui.setAlign((ig as any).GUI_ALIGN.X_CENTER, (ig as any).GUI_ALIGN.Y_TOP); } catch (_) { /* ignore */ }
			try { gui.setPos(0, 48); } catch (_) { /* ignore */ }
			try { gui.hook.zIndex = 3000; } catch (_) { /* ignore */ }
			this._mpDeathGui = gui;
			this._mpDeathGuiText = '';
			this.updateDeathGui(0, inCombat, false);
		} catch (e) { this._mpDeathGui = null; }
	}

	private updateDeathGui(waitedMs: number, inCombat: boolean, allDead?: boolean): void {
		if (!this._mpDeathGui || typeof this._mpDeathGui.setText !== 'function') return;
		try {
			// Round 14 (fix 2): countdown-only prompt. The old spectator-hint prose
			// ('你已死亡 — N 秒后复活（脱战立即复活）· 观战中：左/右键切换队友视角' and the
			// no-countdown fallback) was too long for the mini-GUI; show just the live
			// countdown, or a short "about to revive" stub when there is no countdown.
			const text = allDead
				? t('deathAllDown')
				: inCombat
					? t('deathCountdown').replace('{n}', String(Math.max(0, Math.ceil((30000 - waitedMs) / 1000))))
					: t('deathSoon');
			// Only re-render when the text actually changes — setText does a full
			// text re-parse + atlas prerender, so a per-frame call is wasteful.
			if (text === this._mpDeathGuiText) return;
			this._mpDeathGuiText = text;
			// Round 17 (issue 3): setText alone keeps the countdown centered — the
			// X_CENTER alignment set in showDeathGui re-centers from the refreshed
			// hook.size every draw, so the width-changing countdown stays centered.
			// (The old round-16 setPivot/setPos re-anchor block is GONE: setPivot is
			// inert for a plain TextGui.)
			this._mpDeathGui.setText(text);
		} catch (_) { /* ignore */ }
	}

	private removeDeathGui(): void {
		if (!this._mpDeathGui) return;
		try { this._mpDeathGui.remove(); } catch (_) { /* ignore */ }
		this._mpDeathGui = null;
		this._mpDeathGuiText = '';
	}

	private respawn(p: any, keepPos?: boolean): void {
		this._mpDead = false;
		this._mpAllDeadAt = 0;
		this._mpCheckpointReloading = false;
		this._mpCheckpointReloadAt = 0;
		this._mpCheckpointForced = false;
		this._mpCorpseHidden = false;
		// Belt-and-braces: a revive must never resume into a held charge time-stop.
		// (enterDeath already cleared it; this also covers a revive reached via a path
		// that skipped enterDeath, e.g. abortDeathForTeleport re-entry.)
		try { if (p && typeof p.clearCharge === 'function') p.clearCharge(); } catch (_) { /* ignore */ }
		this.clearChargeFreeze();
		// Round 21 (issue 1): 1s no-collision grace after the local player is re-placed
		// next to a teammate mirror (this respawn repositions us). updateRemoteMirrorFade
		// forces every mirror to IGNORE until this deadline so we can't overlap one.
		this._mpMirrorGraceUntil = Date.now() + 1000;
		this.restoreMouseBindings();
		this.removeDeathGui();
		// Camera GLIDES back to our own player (round 11) instead of snapping.
		this.dropSpectate(true);
		// Bring the entity back (hidden in enterDeath — showEntity no-ops when not
		// hidden) BEFORE repositioning, then clear every lingering effect: the engine's
		// own revive (doManualRevive) starts with ig.EffectTools.clearEffects — leftover
		// death/damage effects on the corpse were the permanent flicker after a soft
		// revive (round 9).
		try { if (typeof p.show === 'function') p.show(); } catch (_) { /* ignore */ }
		try {
			const et: any = (ig as any).EffectTools;
			if (et && typeof et.clearEffects === 'function') et.clearEffects(p);
		} catch (_) { /* ignore */ }
		// Round 13: the death boom's CHANGE_ALPHA step fades animState.alpha to 0 and
		// clearEffects can interrupt the showRespawn fade-to-1 mid-way, leaving the
		// model invisible but movable. Force alpha back to 1 the moment we show.
		try { if ((p as any).animState) (p as any).animState.alpha = 1; } catch (_) { /* ignore */ }
		// Restore the collision type the engine's death flow set to IGNORE.
		try {
			if (p.coll) {
				const targetType = (this._mpDeathCollType != null) ? this._mpDeathCollType : (ig as any).COLLTYPE.VIRTUAL;
				if (typeof p.coll.setType === 'function') p.coll.setType(targetType);
				else p.coll.type = targetType;
			}
		} catch (_) { /* ignore */ }
		this._mpDeathCollType = null;
		// Stand back up next to a live PARTY teammate when one is present (a live
		// party mirror is by definition on our map). keepPos = a teleport is about
		// to place us; don't fight it.
		const mirror = keepPos ? null : this.firstLiveMirror();
		if (!keepPos && p.coll) {
			try {
				const spot = this.pickReviveSpot(mirror, p);
				if (spot) {
					// ROUND 103: commit through the engine setter (validates the point,
					// updates collision-map bucketing + baseZ), not raw coll.pos writes.
					if (typeof p.setPos === 'function') p.setPos(spot.x, spot.y, spot.z);
					else { p.coll.pos.x = spot.x; p.coll.pos.y = spot.y; p.coll.pos.z = spot.z; }
					if (p.respawn && p.respawn.pos) {
						try { (p.respawn.pos as any).x = spot.x; (p.respawn.pos as any).y = spot.y; (p.respawn.pos as any).z = spot.z; } catch (_) { /* ignore */ }
					}
				}
			} catch (_) { /* ignore — revival must never be blocked */ }
		}
		// REVIVE PRESENTATION (round 11): the vanilla water/checkpoint-respawn
		// visuals — a beam from the death spot to the revive spot (`respawnLine` on
		// the combatant's own `death` sheet) + the `showRespawn` burst on the player
		// (ig.game.effects.teleport). The camera is already gliding back (dropSpectate
		// above), so the player sees themselves materialize at the revive spot.
		// _mpDeathPos is only cleared at the END of this method — read it now.
		try {
			const deathPos = this._mpDeathPos;
			const deathFx: any = p.effects && p.effects.death;
			if (deathFx && typeof deathFx.spawnFixed === 'function' && deathPos && p.coll) {
				try {
					deathFx.spawnFixed('respawnLine', deathPos.x, deathPos.y, deathPos.z, p, {
						target2Point: { x: p.coll.pos.x, y: p.coll.pos.y, z: p.coll.pos.z },
						// Round 13: no duration defaults to loopEndTime (~0.1s), so the revive
						// beam flashes out instantly. Vanilla doQuickRespawn passes 0.5-1.5s.
						duration: 0.8,
					});
				} catch (_) { /* ignore */ }
			}
			const tele: any = (ig.game as any).effects && (ig.game as any).effects.teleport;
			if (tele && typeof tele.spawnOnTarget === 'function') {
				try { tele.spawnOnTarget('showRespawn', p); } catch (_) { /* ignore */ }
			}
		} catch (_) { /* ignore */ }
		// ENGINE-LEVEL REVIVE (round 8). The old direct `currentHp = maxHp` write left
		// params.defeated=true (latched by reduceHp when hp hit 0) and dying!=ALIVE
		// untouched, so the game still considered the player DEAD — locked at 0 HP,
		// input blocked, never recovering (the member "30s and still not revived"
		// bug). params.revive() is the engine's own revive primitive: defeated=false,
		// hp restored via increaseHp(getStat('hp')), healStatus(). We deliberately do
		// NOT use doManualRevive() — it also fires sc.combat.notifyCombatantDefeated,
		// a defeat broadcast that is the wrong signal for a soft revival.
		try {
			p.manualKill = null; // release the death-hold armed in enterDeath()
			p.dying = 0; // sc.DYING_STATE.ALIVE
			if (p.params && typeof p.params.revive === 'function') {
				p.params.revive(1); // 1 = full HP fraction
			} else if (p.params) {
				p.params.defeated = false;
				const maxHp = p.params.getStat ? p.params.getStat('hp') : 0;
				p.params.currentHp = maxHp > 0 ? maxHp : 1;
			}
		} catch (_) {
			try {
				if (p.params) {
					p.params.defeated = false;
					const maxHp = p.params.getStat ? p.params.getStat('hp') : 0;
					p.params.currentHp = maxHp > 0 ? maxHp : 1;
				}
			} catch (__) { /* ignore */ }
		}
		try { if (typeof p.params.maxSp === 'number') p.params.currentSp = p.params.maxSp; } catch (_) { /* ignore */ }
		try { p.invincibleTimer = 2; } catch (_) { /* ignore */ }
		this._mpDeathPos = null;
		this._mpDeathMap = '';
		this._mpSafeRespawnPos = null;
		try { if (p.setCurrentAnim) p.setCurrentAnim('idle', true, null, true); } catch (_) { /* ignore */ }
		// Round 21 (issue 3): wipe-and-rebuild name tags on LOCAL revival (position +
		// coll already restored above). The per-frame pump rebuilds the own tag at the
		// new spot next frame. Internally guarded — a wipe failure never breaks revival.
		try { this.main.wipeTags(); } catch (_) { /* ignore */ }
		console.log('[multiplayer] respawned (soft revive)' + (mirror ? ' next to teammate' : (keepPos ? ' (teleport)' : '')));
	}

	/**
	 * Round 21 (issue 2): find a WALL-FREE revive spot next to a teammate mirror. The
	 * old hard-coded +24 X landed the player inside a wall whenever the mirror stood
	 * against an east wall, so we validate with the engine's tile test and ring-search
	 * free alternatives.
	 *
	 * Engine facts (game.compiled.js byte 272572): ig.game.isAreaBlocked(x, y, z, w, h,
	 * depth, includeEntities) returns true when the rectangle (top-left x,y,z, size w,h,
	 * depth) overlaps a solid tile — it internally offsets y by the level's height and
	 * no-ops safely when the level/collision is missing. includeEntities=false here: we
	 * only care about walls, overlapping the teammate mirror is intended.
	 *
	 * Order: mirror pos + (24,0) (the old behavior) if free; else the ring offsets;
	 * else the mirror's EXACT position (guaranteed walkable — the mirror stands there).
	 * On ANY exception falls back to the old +24 spot — revival must never break.
	 */
	/** ROUND 103: validate a soft-revive spot: solid, grounded, not over fall/
	 * dangerous terrain. Used before re-placing the player body at revive time. */
	private validReviveSpot(x: number, y: number, z: number, w: number, h: number, d: number): { x: number, y: number, z: number } | null {
		try {
			const g: any = ig.game;
			const t: any = (ig as any).terrain;
			const phy: any = g && g.physics;
			if (!g || !g.isAreaBlocked) return null;
			if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
			const lvl = (typeof g.getLevelIdx === 'function') ? g.getLevelIdx(z) : -1;
			if (lvl < 0 || !g.levels || !g.levels[lvl] || !g.levels[lvl].collision) return null;
			if (g.isAreaBlocked(x, y, z, w, h, Math.min(d, 4), true)) return null;
			let ground = z;
			if (phy && typeof phy.getBaseZPos === 'function') {
				ground = phy.getBaseZPos(x + w / 2, y + h / 2, z, w, h);
				if (!Number.isFinite(ground) || ground < -900 || Math.abs(ground - z) > 24) return null;
			}
			if (g.isAreaBlocked(x, y, ground, w, h, Math.min(d, 4), true)) return null;
			if (typeof g.isOverHole === 'function' && g.isOverHole(x, y, ground, w, h, Math.min(4, d), false)) return null;
			if (t && typeof t.getPointTerrain === 'function') {
				const val = t.getPointTerrain(x + w / 2, y + h / 2, ground + 4, Math.min(w, 4), Math.min(h, 4));
				if (val && ((typeof t.isFallTerrain === 'function' && t.isFallTerrain(val))
					|| (typeof t.isDangerTerrain === 'function' && t.isDangerTerrain(val)))) return null;
			}
			return { x, y, z: ground };
		} catch (_) { return null; }
	}

	/** ROUND 103: pick a safe revive spot. Candidate order: offsets around the
	 * live teammate mirror, the mirror itself, the engine-maintained safe respawn
	 * anchor, the death spot, then map start — each validated by validReviveSpot. */
	private pickReviveSpot(mirror: any, p: any): { x: number, y: number, z: number } | null {
		try {
			const w = p.coll.size.x;
			const h = p.coll.size.y;
			const d = p.coll.size.z;
			const cands: Array<{ x: number, y: number, z: number }> = [];
			if (mirror && mirror.coll) {
				const b = mirror.coll.pos;
				const offs: Array<[number, number]> = [
					[24, 0], [-24, 0], [0, -24], [0, 24], [-48, 0], [48, 0], [0, -48], [0, 48],
					[-24, -24], [-24, 24], [24, -24], [24, 24], [-64, 0], [64, 0], [0, -64], [0, 64],
				];
				for (const [dx, dy] of offs) cands.push({ x: b.x + dx, y: b.y + dy, z: b.z });
				cands.push({ x: b.x, y: b.y, z: b.z });
			}
			if (this._mpSafeRespawnPos) cands.push(this._mpSafeRespawnPos);
			if (this._mpDeathPos) cands.push(this._mpDeathPos);
			if (p.respawn && p.respawn.pos) cands.push({ x: p.respawn.pos.x, y: p.respawn.pos.y, z: p.respawn.pos.z });
			if (p.mapStartPos) cands.push({ x: p.mapStartPos.x, y: p.mapStartPos.y, z: p.mapStartPos.z });
			for (const c of cands) {
				if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) continue;
				const ok = this.validReviveSpot(c.x, c.y, c.z, w, h, d);
				if (ok) return ok;
			}
			return null;
		} catch (_) {
			return (mirror && mirror.coll)
				? { x: mirror.coll.pos.x + 24, y: mirror.coll.pos.y, z: mirror.coll.pos.z }
				: null; // revival must never break
		}
	}

	// ------------------------------------------------------------------ inbound
	private applyPlayerState(player: string, s: any): void {
		if (!player || player === this.main.name) return;
		// Round 15: roster gate — kill the stale-stream respawn at its source.
		// When the LOCAL player changes maps, clearMap() kills the old mirrors
		// but a leftover playerState from the old instance can still arrive
		// during the changeMap deferral window; the dead-mirror self-heal below
		// would then spawnMirrorAt at stale coordinates and the name-tag loop
		// would project that ghost forever. playersOnThisMap is maintained by
		// onPlayerChangeMap (enters:true/false events + loadingComplete
		// reconcile against the changeMapResponse roster). Fail-open when the
		// roster is empty (first-load window / pre-reconcile) so we never
		// block legitimate mirrors.
		// ROUND 84: a member whose KNOWN sub-map equals ours is always accepted,
		// even when the roster slot was transiently missing (the "later entrant
		// can't see the earlier entrant" race).
		let knownOnMap = false;
		try {
			const pmap: any = (this.main as any).playerMapByName;
			if (pmap && pmap[player] !== undefined) {
				const myMap = (ig.game && (ig.game as any).mapName) || '';
				if (pmap[player] !== myMap) {
					// ROUND 83: the player moved to another sub-map — their relayed state is
					// off-map, so also clear any stale name tag that a missed leave event
					// would otherwise leave floating.
					try { this.main.dropRemoteTag(player); } catch (_) { /* ignore */ }
					return;
				}
				knownOnMap = true;
			}
		} catch (_) { /* ignore */ }
		try {
			const onMap: any = (this.main as any).playersOnThisMap;
			if (onMap && !onMap[player] && !knownOnMap) {
				// ROUND 83: before the first roster reconcile (playersRosterReady false)
				// an empty roster fails open so unknown members can self-heal. Once the
				// roster is settled, absence from playersOnThisMap is authoritative —
				// even for an empty room — so a departed/fading mirror can never be
				// resurrected by a stale playerState.
				const ready = !!(this.main as any).playersRosterReady;
				if (ready || Object.keys(onMap).length > 0) {
					try { this.main.dropRemoteTag(player); } catch (_) { /* ignore */ }
					return;
				}
			}
		} catch (_) { /* ignore */ }
		let pl = this.main.players[player];
		// Death flag: while the remote player is dead their mirror must be GONE for us
		// (a corpse frozen in place reads as a bug — the teammate should visibly
		// disappear until they respawn). kill(true) marks it _killed; the live-state
		// path below clears the reference and respawns the mirror when `dead` drops.
		if (s.dead) {
			if (pl && pl.entity && !(pl.entity as any)._killed) {
				const entD: any = pl.entity;
				// Fix 3: clear pending interpolation targets so the corpse never drifts
				// and the fresh respawn mirror starts from a snap (first-state detection
				// keys on the absence of _mpToX).
				entD._mpToX = undefined; entD._mpToY = undefined; entD._mpToZ = undefined;
				// Fix 1: stage the full death FX (pre_die blink -> boom -> silent kill)
				// instead of the plain silent kill — a teammate's death must be visible.
				// Mirrors are Enemy-typed, so they own effects.death (the same "combatant"
				// death sheet the local player uses — there is no player.json effect sheet).
				// The ~500ms queue then delivers the sequence; _mpDying freezes the mirror.
				this.playPuppetDeath(entD, false);
				console.log('[netsync] ' + player + ' died — mirror removed');
				// Round 21 (issue 3): wipe-and-rebuild name tags on a REMOTE player's death
				// so their tag can't linger on a removed mirror. The per-frame pump rebuilds
				// tags for whatever is still live next frame. Internally guarded.
				try { this.main.wipeTags(); } catch (_) { /* ignore */ }
			}
			// Party HUD still needs to show the death. Round 22 (EXTRA): the top-left
			// HpHudBarGui FLASHES RED only when its targetHp goes NEGATIVE (the vanilla
			// defeat signal) — a plain 0-pin just shrank the bar. Emit the same negative
			// target + mark the model dead + the HP_CHANGED notify used elsewhere here.
			const dm: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[player];
			if (dm && dm.params) {
				const hpBefore = dm.params.currentHp;
				const maxHp = dm.params.getStat ? dm.params.getStat('hp') : 0;
				dm.params.currentHp = maxHp > 0 ? -maxHp : -1;
				dm._mpDead = true;
				if (dm.params.currentHp !== hpBefore) {
					try { (sc as any).Model.notifyObserver(dm.params, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
				}
			}
			return; // no pos/anim writes onto a dead mirror
		}
		if (!pl || !pl.entity) {
			// Rate-limited: this is the "mirror missing" path — if we never see this log the
			// playerState stream isn't arriving; if we see it but no mirror, spawnMirrorAt fails.
			const now = Date.now();
			if (!this._lastNoMirrorLog || now - this._lastNoMirrorLog > 2000) {
				this._lastNoMirrorLog = now;
				console.log('[netsync] playerState from ' + player + ' but NO live mirror (have players: '
					+ Object.keys(this.main.players).filter(k => this.main.players[k] && this.main.players[k]!.entity).join(',') + '). Spawning at '
					+ (s.pos ? Math.round(s.pos.x) + ',' + Math.round(s.pos.y) : '?'));
			}
		}
		// A mirror killed in combat stays referenced as a corpse — the spawn guards see a
		// truthy entity and refuse to respawn. Detect the dead mirror, clear it, and fall
		// through to respawn so the remote player reappears.
		if (pl && pl.entity && (pl.entity as any)._killed) {
			try { delete this.main.players[player]; } catch (_) { /* ignore */ }
			// Round 21 (issue 3): wipe-and-rebuild name tags on REMOTE revival — the dead
			// mirror is about to be re-spawned as a fresh one below (the _mpNoCollUntil
			// grace on the fresh spawn covers the re-position). Wiping here (before the
			// re-spawn trigger) prevents the old tag ghosting at the corpse's last spot.
			try { this.main.wipeTags(); } catch (_) { /* ignore */ }
			pl = undefined;
		}
		// Round 19 (Part 1): record whether the remote player is in a cutscene. The
		// per-frame fade/collision pass (updateRemoteMirrorFade) and the host's aggro
		// guards (mirrorTargets / applyEnemyDamage / forwardMirrorHit) read it off the
		// players-map entry. Set on every state (create + update) — a mirror spawned
		// by this packet's spawn branch below is caught by the next frame's pass.
		if (pl) (pl as any)._mpCutscene = !!s.cs;
		if (pl && pl.entity) {
			const ent: any = pl.entity;
			// ROUND 104: owner is over fall terrain/quick-falling — arm the aggro
			// grace so host-side target logic doesn't de-aggro during the fall.
			try { if (s.fl) ent._mpWaterGraceUntil = Date.now() + 1500; } catch (_) { /* ignore */ }
			// Round 27 (item 4): stash the owner's guard state ON THE MIRROR so the host's
			// dynamic-shield injection can judge damage/guard/perfect-guard for this player.
			// gd/gst/gws arrive with the guard packet; gw/gm/ga/def are cached when present
			// (they ride the same payload but are omitted when unchanged — opt 3).
			this._applyCombatStash(ent, s);
			if (s.pos) {
				// Fix 3: store the network position as an INTERPOLATION TARGET instead of
				// writing it directly — direct per-packet writes = visible jitter on bad
				// networks. SNAP (write + clear pending targets) on the first state for
				// this mirror (no previous target), on teleports/ledges (>120px horizontal
				// or >32 z-delta), and after death/respawn (targets are cleared there too),
				// so a corpse or revive never drifts. Facing/animation still apply
				// immediately below, as before.
				const hasTgt = typeof ent._mpToX === 'number';
				const dx = hasTgt ? s.pos.x - ent._mpToX : 0;
				const dy = hasTgt ? s.pos.y - ent._mpToY : 0;
				const dz = hasTgt ? Math.abs(s.pos.z - ent._mpToZ) : 0;
				const snapped = !hasTgt || dx * dx + dy * dy > 120 * 120 || dz > 32;
				if (snapped) {
					// Snap: the mirror is lockEntity-locked, so write through the same
					// protected backing fields copyEntityPosition uses.
					this.main.copyEntityPosition(s.pos, ent.coll.pos);
					// ROUND 80: direct lock-backing write — re-bucket the collision
					// entry at the snapped position on the next interpolation pass.
					this._mpMarkCollDirty(ent);
				}
				ent._mpToX = s.pos.x; ent._mpToY = s.pos.y; ent._mpToZ = s.pos.z;
				// ROUND 80 (town movement smoothing): keep an adaptive one-packet
				// replay segment for the shared-town renderer. Each sample starts a
				// new segment from the mirror's CURRENT rendered position to the new
				// sample, lasting the observed inter-sample interval (~100ms at 10Hz).
				// Starting from the rendered position (not the previous sample) makes
				// the handoff continuous even when packet intervals jitter; a snap
				// starts a static segment at the snapped position so a teleport/
				// respawn never glides. Leaving town drops the segment and the normal
				// combat-capable lerp takes over.
				try {
					if (isSharedTownNow()) {
						const nowMs = Date.now();
						const prevSeg: any = ent._mpTownSeg;
						const prevAt: number = (typeof ent._mpTownLastAt === 'number' && ent._mpTownLastAt > 0) ? ent._mpTownLastAt : 0;
						let sx = s.pos.x, sy = s.pos.y, sz = s.pos.z;
						if (!snapped) {
							const cp: any = ent.coll && ent.coll.pos;
							if (cp) {
								if (typeof cp.xProtected === 'number') sx = cp.xProtected;
								if (typeof cp.yProtected === 'number') sy = cp.yProtected;
								if (typeof cp.zProtected === 'number') sz = cp.zProtected;
							}
						}
						let dur = 100;
						if (!snapped && prevAt > 0 && nowMs - prevAt >= 40 && nowMs - prevAt <= 500) {
							dur = nowMs - prevAt;
						} else if (!snapped && prevSeg && prevSeg.dur > 0) {
							dur = prevSeg.dur;
						}
						ent._mpTownSeg = {
							x0: sx, y0: sy, z0: sz, t0: nowMs, dur,
							x1: s.pos.x, y1: s.pos.y, z1: s.pos.z,
						};
						ent._mpTownLastAt = nowMs;
					} else if (ent._mpTownSeg) {
						ent._mpTownSeg = null;
						ent._mpTownLastAt = 0;
					}
				} catch (_) { /* history is cosmetic */ }
				// ROUND 50: stamp WHEN the owner's real position last advanced, so the
				// host's synthetic monster-hit gate (drainSyntheticHits) can reject a
				// verdict against a mirror whose owner has stopped moving (out of range,
				// being knocked back mid-swing, or a stalled stream). Without this the
				// host only sees the mirror's last-rendered spot — frozen in place — and
				// keeps judging "in reach" against a member who is no longer there.
				// Written ONLY on real XY movement (or the first stamp) so a steady stream
				// from a stationary member still lets them be hit.
				try {
					const lat: any = ent._mpLastToAtMs;
					if (lat === undefined || dx * dx + dy * dy > 0.25) (ent as any)._mpLastToAtMs = Date.now();
				} catch (_) { /* ignore */ }
				pl.position = { x: s.pos.x, y: s.pos.y, z: s.pos.z }; // keep the safety-net spawn pos fresh
			}
			if (s.face && ent.face) { ent.face.xProtected = s.face.x; ent.face.yProtected = s.face.y; }
			if (s.anim && ent._mpLastAnim !== s.anim) {
				ent._mpLastAnim = s.anim;
				ent.currentAnim = { protected: s.anim };
				this.playAnim(ent, s.anim);
				// Round 9: melee slash visuals. The remote player's attack ACTION runs
				// only on their machine (COMBAT_SWEEP step -> hitbox + sweep effect);
				// mirrors just replay the animation, so teammates never saw the swing
				// effect. Spawn the visual-only sweep sheet on the animation start
				// (round 11: element-tinted + class family from the em/cl stream).
				this.spawnAttackFxForAnim(ent, s.anim, ent._mpLastEm, ent._mpLastCl);
				// Fix 3: unsynced FX replay keyed off the anim string — the guard dome
				// and dash dust (both null-safe no-ops when their sheets aren't resident).
				this.syncGuardFx(ent, s.anim);
				this.syncDashFx(ent, s.anim);
			}
			// Fix 3: element-mode switch burst — checked on every remote block, not just
			// anim changes (the owner swaps elements without changing their anim).
			// Round 22 (opt 3): em/cl are now omitted from the packet when unchanged —
			// only apply (and re-cache) when present. The anim-change branch below falls
			// back to these cached values for the sweep FX (an attack packet may omit
			// em/cl because they did not change, yet still needs the correct class/element).
			if (typeof s.em === 'number') {
				if (ent._mpLastEm !== undefined && ent._mpLastEm !== s.em) this.syncModeChangeFx(ent, s.em);
				ent._mpLastEm = s.em;
			}
			if (typeof s.cl === 'string') ent._mpLastCl = s.cl;
			// Round 18 (issue 3): the mirror's under-feet StatusBar only updates via model
			// observer notifications — a bare currentHp write left it frozen at full. Write
			// change-gated + max-HP consistency + vanilla HP_CHANGED notify (bar animates).
			if (ent.params && typeof s.hp === 'number') {
				const p: any = ent.params;
				const before = p.currentHp;
				if (typeof s.maxHp === 'number' && s.maxHp > 0 && p.baseParams && p.baseParams.hp !== s.maxHp) p.baseParams.hp = s.maxHp;
				if (p.currentHp !== s.hp) {
					p.currentHp = s.hp;
					try { (sc as any).Model.notifyObserver(p, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
				}
			}
			// Round 10 charge sync: PARTY-member mirrors carry their charging flag.
			// While the shared freeze is up, a charging mirror keeps updating at REAL
			// time (coll.time.animStatic — the exact flag vanilla sets on the charging
			// player locally), so their charge anim/movement stays smooth while the
			// rest of the world crawls at 10%. Non-party players (shared towns) never
			// affect our freeze.
			if (this.main.partyMembers.indexOf(player) !== -1) {
				const cgNow = !!s.cg;
				if (cgNow !== !!ent._mpCharging) {
					ent._mpCharging = cgNow;
					try { if (ent.coll && ent.coll.time) ent.coll.time.animStatic = cgNow; } catch (_) { /* ignore */ }
				}
			}
		} else if (s.pos) {
			// No mirror yet — spawn it at their position (self-heal).
			this.main.spawnMirrorAt(player, s.pos);
			// Round 19: the spawn is async (EnemyType load), so the entry may not
			// exist yet — record the cutscene flag if it does; the per-frame fade
			// pass self-heals the mirror when it lands either way.
			const fresh = this.main.players[player];
			if (fresh) {
				(fresh as any)._mpCutscene = !!s.cs;
				// ROUND 79 (cache-coherence fix): this packet SPAWNED the mirror, so the
				// entity-apply branch above did NOT run for it — stash the combat stats on
				// the fresh entity RIGHT NOW if the spawn was synchronous. (The async case
				// is covered by the next packet: these fields now ride EVERY playerState.)
				try { if (fresh.entity) this._applyCombatStash(fresh.entity, s); } catch (_) { /* ignore */ }
			}
		}
		// Party HUD model (top-left HP/SP bars read the MODEL, not the mirror).
		const model: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[player];
		if (model && model.params) {
			// Round 22 (EXTRA): the dead branch pinned the model HP negative + set
			// _mpDead; this LIVE branch is the revival path — clear the dead marker so
			// a later death re-arms the red flash (and readers of _mpDead see revived).
			model._mpDead = false;
			const p: any = model.params;
			const hpBefore = p.currentHp;
			if (typeof s.hp === 'number') p.currentHp = s.hp;
			if (typeof s.maxHp === 'number' && s.maxHp > 0 && p.baseParams) p.baseParams.hp = s.maxHp;
			if (typeof s.sp === 'number') p.currentSp = s.sp;
			if (typeof s.maxSp === 'number' && s.maxSp > 0) p.maxSp = s.maxSp;
			// Round 18 (issue 3): the top-left HpHudBarGui reads the model via observer
			// notifications — notify on a real currentHp change so the bar tracks live.
			if (p.currentHp !== hpBefore) {
				try { (sc as any).Model.notifyObserver(p, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
			}
		}
	}

	/** ROUND 79 (cache-coherence fix): stash the owner's guard state + combat stats on
	 * a mirror entity. Extracted from applyPlayerState so the packet that SPAWNS the
	 * mirror also applies them (the old code only stashed on the existing-entity branch,
	 * and the omission gate then dropped the fields from every later packet - so a fresh
	 * mirror never learned def/gm/ga/df/ef/fc and the host recomputed damage against the
	 * husk's stats). Now the fields ride EVERY playerState, so every call re-stamps them;
	 * this helper just makes the spawn packet apply immediately too. Never throws. */
	private _applyCombatStash(ent: any, s: any): void {
		try {
			// Round 27 (item 4): guard state + timing for the host's damage judge.
			if (typeof s.gd === 'number') ent._mpGd = s.gd;
			if (typeof s.gst === 'number') { ent._mpGst = s.gst; ent._mpGstAtMs = Date.now(); }
			if (typeof s.gws === 'number') ent._mpGws = s.gws;
			if (typeof s.gw === 'number') ent._mpGw = s.gw;
			if (typeof s.gm === 'number') ent._mpGm = s.gm;
			if (typeof s.ga === 'number') ent._mpGa = s.ga;
			if (typeof s.def === 'number') ent._mpDef = s.def;
			if (typeof s.fc === 'number') ent._mpFocus = s.fc;
			// ROUND 78/79: element factors + params damageFactor (the engine's g factor
			// for the host's damage recompute).
			if (Array.isArray(s.ef)) ent._mpEf = s.ef;
			if (typeof s.df === 'number') ent._mpDf = s.df;
		} catch (_) { /* never break the state packet */ }
	}

	private applyEntityState(map: string, list: IEnemySnap[], cb: boolean, full?: boolean): void {
		if (this.main.host) return;                 // host is the authority; ignore echoes
		if (map !== this.mapName) return;           // block for a map we already left
		// Round 24: any block proves the host is live — reaping waits for this (stall
		// mode: no block for >1200ms -> reapStalePuppets refuses to kill anything). A
		// FULL-flagged block (f:1, the ~1s heartbeat) also advances the full-roster
		// counter so unadopted map enemies can be reaped once BOTH streams reported.
		this._mpLastBlockAt = Date.now();
		if (full) this._mpFullBlockSeen++;
		// Shared combat state: the host is fighting -> we enter combat too. The engine's
		// own triggers never fire on a member (host enemies hit our MIRROR, not our real
		// player), so nudge the model directly. When the host's combat ENDS (cb drops),
		// re-evaluate our local state once so we leave combat together with the host
		// (graceful fade via the local cooldown) instead of waiting for the last local
		// puppet de-aggro — stale entries are purged first, so this can't re-arm.
		if (cb) {
			try {
				const m: any = sc as any;
				if (m.model && m.model.setCombatMode && !(m.model.isCombatActive && m.model.isCombatActive())) {
					m.model.setCombatMode(true);
				}
			} catch (_) { /* ignore */ }
		} else {
			try {
				const m: any = sc as any;
				// Gate: only act when we're actually still marked in combat — on normal
				// exploration blocks this branch must stay a cheap no-op.
				if (m.model && m.model.isCombatMode && m.model.isCombatMode()) {
					this.purgeStaleCombatants();
					const pl: any = ig.game && ig.game.playerEntity;
					if (pl && typeof pl.updateCombatMode === 'function') pl.updateCombatMode();
				}
			} catch (_) { /* ignore */ }
		}
		const now = Date.now();
		// Round 23: stamp EVERY entry (full snap OR bare liveness marker) into the
		// PERSISTENT liveness maps. The old per-block seenUid/seenMapId sets lived and
		// died within one block; now reapStalePuppets (run on a ~500ms timer, NOT per
		// block) reaps adopted puppets / unadopted map enemies whose stamps go stale
		// (uid >600ms; mapId >2500ms + full-roster gate — see reapStalePuppets) — a
		// single dropped block can no longer reap a live puppet, and a dead host enemy
		// clears on the member shortly after instead of on the next block.
		// Build a mapId -> live map-enemy index ONCE per block (not per puppet) so
		// ensurePuppet's adoption lookup is O(1) instead of re-scanning all ~550 entities
		// for every unadopted enemy in the block (that was the member-side frame hitch).
		let mapEnemyIdx: { [mapId: number]: any } | null = null;
		for (const s of list) {
			if (!s || typeof s.i !== 'number') continue;
			this._mpUidSeen[s.i] = now;
			// Round 24: only TRUTHY mapIds are stamped — mapId 0 (a stray EnemySpawner
			// product) is never host-owned and is reaped immediately, never via this stamp.
			if (s.mi) this._mpMapSeen[s.mi] = now;
			// Lazily build the index only when some puppet actually needs adopting.
			if (!this.puppets[s.i] && s.mi && !mapEnemyIdx) mapEnemyIdx = this.buildMapEnemyIndex();
			const e = this.ensurePuppet(s, mapEnemyIdx);
			if (!e || !e.coll) continue;
			// Round 22 (opt 2): an UNCHANGED enemy ships as a bare liveness marker
			// {"i": uid}. It still counts as "seen" (reap guard above) and keeps the
			// adopted puppet alive, but carries NO state fields — so everything below
			// must NOT clobber pos/anim/hp/target with undefined. Only FULL entries
			// carry numeric fields (the encoder always ships them all together).
			const isFull = typeof s.x === 'number';
			// Store the block position as the INTERPOLATION TARGET — tick()'s per-frame
			// lerp moves the puppet toward it, turning 15Hz updates into smooth 60fps
			// motion. (Direct per-block writes were the visible stutter.)
			if (isFull && (e._mpToX !== s.x || e._mpToY !== s.y || e._mpToZ !== s.z)) {
				e._mpToX = s.x; e._mpToY = s.y; e._mpToZ = s.z;
				if (e._mpSnapNext) { // fresh adopt/respawn: skip the glide from wherever we were
					e._mpSnapNext = false;
					const cp0: any = e.coll.pos;
					cp0.xProtected = s.x; cp0.yProtected = s.y; cp0.zProtected = s.z;
					// ROUND 80: the direct lock-backing write moves the coll without
					// setPos — re-bucket it in the spatial hash immediately.
					this._mpMarkCollDirty(e);
				}
			}
			if (isFull && e.face && (e.face.xProtected !== s.fx || e.face.yProtected !== s.fy)) {
				e.face.xProtected = s.fx; e.face.yProtected = s.fy;
			}
			// Host-authoritative aggro: the host enemy engaged (has a target) -> our
			// puppet engages the local player; the host enemy went idle -> drop the
			// puppet's local aggro. RE-ASSERTED EVERY FULL BLOCK (not only on change):
			// puppets run the FULL local AI between blocks, and that AI's target-lose
			// logic can drop the host-assigned target for a moment — which was the
			// member-side HP bar flickering back to blue and combat mode dropping out
			// until the next tg *change* re-synced it. Host authority wins every block.
			// A liveness marker (isFull=false) deliberately skips this: its tg is
			// unchanged by definition, and the _mpTargetGuarded lock (ensurePuppet)
			// holds the puppet's target between full blocks anyway.
			if (isFull) {
				const tgNow = !!s.tg;
				e._mpTg = tgNow;
				const pl: any = ig.game.playerEntity;
				try {
					// ROUND 47: the host now ships the target's NAME (s.tn). A puppet is
					// hostile (red bar / combat) whenever the HOST enemy has ANY target —
					// i.e. it's fighting the group — not only when it's aimed at us. The
					// old tg-only gate dropped the puppet's target the moment the host
					// enemy de-aggro'd off OUR mirror onto someone else, which read as a
					// blue/idle bar while the fight was still on. Only aim the puppet at
					// the LOCAL player when the host target is actually us (tn == our
					// name) OR (legacy) the name is absent but engaged; an enemy aimed at
					// someone else stays red via combat mode, not via a fake local target.
					const myName = (this.main && this.main.name) || '';
					const aimedAtMe = tgNow && (s.tn === undefined ? true : (!!myName && s.tn === myName));
					// Round 19 (Part 4): while the LOCAL player is in a cutscene, puppets
					// must NOT re-aggro us (we can't defend mid-story). We still drop any
					// existing player-target; we just never acquire/re-acquire it.
					if (aimedAtMe && !this.inCutscene) { if (pl && !e.target && !e._killed) e.setTarget(pl); }
					else if (pl && e.target === pl && !aimedAtMe) e.setTarget(null);
					// ROUND 31 (item 5): an ENGAGED puppet (one the member attacked — see
					// forwardEnemyDamage) whose engine lose-check just dropped its target is
					// re-pinned here every block, decoupled from member hit cadence and from
					// the host's tg timing. The lose-drop happens locally (the puppet's far
					// from its "target"), and once targetless the enemy went fully passive —
					// it never attacked the member and read as un-hittable. Re-pin only the
					// member-ENGAGED ones (never idle enemies = no local full-map aggro).
					// ROUND 47: ...but only while the member's OWN attack was the last thing
					// that pulled it (a fresh local aggro). If the host already re-aimed the
					// enemy at someone (tg on) and it just isn't aimed at us, do NOT re-pin a
					// fake local target — that would flip the bar red on us while the host
					// enemy is actually fighting elsewhere.
					if (!tgNow && !this.inCutscene && pl && !e.target && !e._killed && e._mpEngaged && e.setTarget) {
						try { e.setTarget(pl); e.targetLoseTimer = 0; } catch (_) { /* ignore */ }
					}
					// ROUND 47 (the "stays red forever" fix): once the HOST says this enemy
					// has NO target at all (tn === '') it's genuinely de-aggro'd — but the
					// member's own attack earlier latched _mpEngaged, and the _mpEngaged
					// re-pin above would immediately re-target the local player, holding the
					// bar RED forever even though the host shows it idle/blue. When the host
					// reports a fully-idle enemy, release the member-side engagement latch so
					// the puppet de-aggros to match. Host authority wins; the member can
					// always re-engage by hitting it again.
					if (tgNow === false && s.tn === '' && e._mpEngaged) {
						try { this._sfxLog('tg.release', 'uid=' + s.i + ' tn=idle -> deaggro member'); } catch (_) { /* ignore */ }
						try { e._mpEngaged = null; } catch (_) { /* ignore */ }
						try { e._mpTg = false; } catch (_) { /* ignore */ }
						try { if (pl && e.target === pl && e.setTarget) e.setTarget(null); } catch (_) { /* ignore */ }
					}
				} catch (_) { /* ignore */ }
			}
			// ROUND 62 (underground invulnerability): mirror the host enemy's _hidden flag
			// onto the puppet. A burrowed/phased hillkat is untargetable on the host (the
			// native engine never applies damage to a _hidden enemy), but the member's
			// puppet had no such flag — fix A (burrowed => full snapshot) made the puppet
			// track the underground position, so a member's ball could connect and the
			// forwarded damage bypassed the host's native invulnerability. Write the flag
			// here; the onPreDamageModification branch-A gate reads it to drop the hit
			// (no local damage, no forward, no flinch, no kill) while the puppet is hidden.
			// Only set/unset on an actual flip so the burrow/emerge transition is one-shot.
			if (isFull) {
				const hdNow = (s.hd || 0) === 1;
				if (!!e._hidden !== hdNow) e._hidden = hdNow;
			}
			this._mpRehidePuppet(e, isFull);
			// ROUND 63 (meerkat burrow untargetability): the hillkat/meerkat goes
			// untargetable via SET_COLL_TYPE PASSIVE, not HIDE — so the ROUND 62 _hidden
			// mirror never fired for it. Mirror the PASSIVE coll type onto the puppet:
			// balls skip PASSIVE colls natively (COLLISION_MAP[PROJECTILE] has no PASSIVE
			// entry), so a member's ball passes straight through the buried puppet exactly
			// like it does on the host — no local hit, no forward, no 0~1 mirror-husk hit.
			// The puppet stays VISIBLE (coll.type doesn't hide it), so the earthIn/earthDig
			// anim (synced via `a`) still shows it sinking underground. Only set/unset on
			// an actual flip, and cache the real type once to restore on emerge.
			if (isFull) {
				const psvNow = (s.psv || 0) === 1;
				if (e._mpPassiveSynced !== psvNow) {
					e._mpPassiveSynced = psvNow;
					try {
						if (psvNow) {
							if (e._mpEnemyCollType === undefined) e._mpEnemyCollType = e.coll.type;
							// ROUND 80: use coll.setType(), not a raw type write. setType
							// removes/re-adds the coll in the impact.js spatial hash when the
							// PASSIVE flag flips; a raw write left the entry in the map, so a
							// "burrowed" puppet could still be touched and a re-emerged puppet
							// could stay untouchable depending on which stale cell the hash had.
							if (typeof e.coll.setType === 'function') e.coll.setType((ig as any).COLLTYPE.PASSIVE);
							else e.coll.type = (ig as any).COLLTYPE.PASSIVE;
						} else {
							const restore = (e._mpEnemyCollType !== undefined) ? e._mpEnemyCollType : e.coll.type;
							if (typeof e.coll.setType === 'function') e.coll.setType(restore);
							else e.coll.type = restore;
						}
						this._sfxLog('psv.sync', 'uid=' + s.i + ' passive=' + (psvNow ? 1 : 0));
					} catch (_) { /* best-effort */ }
				}
			}
			// Round 14 (fix 5): a _mpDying puppet is mid-death-FX — never re-issue a live
			// anim onto it from the host block (it's already pinned to the damage anim).
			if (isFull && s.a && !e._mpDying && this.lastAnim[s.i] !== s.a) {
				this.lastAnim[s.i] = s.a;
				e.currentAnim = { protected: s.a };
				this.playAnim(e, s.a);
			}
			if (isFull && e.params) {
				const hpBefore = e.params.currentHp;
				if (e.params.currentHp !== s.h) e.params.currentHp = s.h;
				if (e._mpPuppet) e.params.defeated = false; // keep host-authoritative (DoT bypasses the refund)
				if (s.m > 0 && e.params.baseParams && e.params.baseParams.hp !== s.m) e.params.baseParams.hp = s.m;
				// Round 18 (issue 2): Enemy.setElementMode copies the locally-UNSCALED mode
				// max into baseParams.hp — re-lock every element-mode param copy to the
				// host's scaled max so a mode switch can't show an unscaled max. All
				// accesses guarded; best-effort.
				if (s.m > 0 && (e as any)._mpPuppet && (e as any).elementModes && (e as any).elementModes.modes) {
					try {
						for (const k in (e as any).elementModes.modes) {
							const md: any = (e as any).elementModes.modes[k];
							if (md && typeof md.hp === 'number') md.hp = s.m;
						}
					} catch (_) { /* best-effort */ }
				}
				// Round 18 (issue 2): replicate vanilla reduceHp's HP_CHANGED notification so
				// the puppet's StatusBar animates damage smoothly. Gated on an actual change:
				// a block matching the member's own local hit fires nothing (local damage
				// animation preserved).
				if (e.params.currentHp !== hpBefore) {
					try { (sc as any).Model.notifyObserver(e.params, (sc as any).COMBAT_PARAM_MSG.HP_CHANGED); } catch (_) { /* best-effort */ }
				}
			}
			// ROUND 61 (fix C): mirror the host's guard/break bar onto the puppet so the
			// member sees the break progress + the red "broken" flash. sp/maxSp drive the
			// bar fill; brk forces the status Gui into its broken state. Everything guarded
			// — an absent statusGui/field just skips the cosmetic, never breaks the block.
			if (isFull && e.params) {
				try {
					if (typeof s.sp === 'number' && typeof e.params.currentSp === 'number' && e.params.currentSp !== s.sp) {
						e.params.currentSp = s.sp;
						try { (sc as any).Model.notifyObserver(e.params, (sc as any).COMBAT_PARAM_MSG.SP_CHANGED); } catch (_) { /* best-effort */ }
					}
					if (typeof s.msp === 'number' && s.msp > 0 && e.params.baseParams && typeof e.params.baseParams.sp === 'number' && e.params.baseParams.sp !== s.msp) {
						e.params.baseParams.sp = s.msp;
					}
				} catch (_) { /* best-effort */ }
				try {
					const brokenNow = (s.brk || 0) === 1;
					if (e._mpBrokenSynced !== brokenNow) {
						e._mpBrokenSynced = brokenNow;
						const gui: any = e.statusGui;
						if (gui) {
							if ('breakActive' in gui) gui.breakActive = brokenNow;
							else if ('broken' in gui) gui.broken = brokenNow;
							else if (gui.spBar && 'broken' in gui.spBar) gui.spBar.broken = brokenNow;
						}
						// ROUND 63 (break FX): replay the "BREAK!" dramatic effect (label +
						// speedlines + blur) on the member's puppet the moment the host enemy
						// breaks. The meerkat's reaction break (CHARGE_WEAK -> STUN) never
						// touched the statusGui bar, so this was the missing annotation the
						// member never saw. doDramaticEffect on a non-player target skips the
						// camera/slow-mo, so only the visible break FX + "BREAK!" label play.
						if (brokenNow) { try { this._mpPlayBreakFx(e); } catch (_) { /* best-effort */ } }
						this._sfxLog('brk.sync', 'uid=' + s.i + ' broken=' + (brokenNow ? 1 : 0));
					}
				} catch (_) { /* best-effort */ }
			}
			// ROUND 63 (meerkat red-flash): mirror the host enemy's VULNERABLE annotation
			// (the 2s "charge light" red blink a charged ball can break through). The old
			// readEnemyBroken probed the guard/break bar, but the meerkat has maxSp 0 and
			// no bar — its "red flash" is the annotate.passive VULNERABLE window, driven by
			// CHANGE_ENEMY_ANNOTATION during SpecialAttack. Replay the red blink on the
			// puppet when it flips; stop it when the host leaves the window (or it breaks).
			if (isFull) {
				const vulNow = (s.vul || 0) === 1;
				if (e._mpVulSynced !== vulNow) {
					e._mpVulSynced = vulNow;
					this._mpApplyVulnerable(e, vulNow);
				}
			}
			// ROUND 66 (poise/shield damage sync): mirror the host enemy's ACTIVE shields
			// onto the puppet. Without them the puppet's native isShielded finds nothing,
			// so a poised/guarding enemy (hedgehog roll-up, baseFactor 0.25) takes FULL
			// damage from the member — no silver guard number, no reduction — while the
			// host's real enemy reduces it. With the shields attached the puppet's own
			// damage chain produces the SAME factor/number/poise as the host natively.
			if (isFull) this.syncPuppetShields(e, s.sh);
		}
		// Round 23: the per-block reap pass is GONE — replaced by the time-based
		// reapStalePuppets() (run from tick() on a ~500ms accumulator), which uses the
		// persistent _mpUidSeen/_mpMapSeen stamps written above. A single dropped block
		// can no longer kill a live puppet; member-side deaths now clear within ~600ms
		// instead of on the next block.
	}

	/**
	 * ROUND 62 (underground untargetability): keep a burrowed/phased puppet's coll OUT of
	 * the game's collision lists so a member's ball can't connect while the host enemy is
	 * underground. The mod locks the puppet (lockEntity + a short-circuiting Enemy.update),
	 * so the engine's own updateSprites / getOverlappedEntities path that would hide it
	 * natively never runs — the coll stays tracked and hittable underground. Mirror it by
	 * hand: while e._hidden, untrack the coll exactly like ig.Entity.hide (with the
	 * per-entity entityAttached removed too), which drops it out of the ball's
	 * getOverlappedEntities / hit check entirely. Re-track it when the host reports the
	 * enemy has emerged, so it becomes hittable again. All engine calls are feature-
	 * detected and best-effort; the hp-refund in onPreDamageModification is the backstop
	 * for any hit that still slips through.
	 */
	/** ROUND 66 (poise/shield damage sync): reconcile the puppet's synced shield
	 * connections with the host enemy's streamed list (IEnemySnap.sh). The puppet runs
	 * no AI, so ADD_SHIELD state guards (the hedgehog's roll-up "full" shield,
	 * baseFactor 0.25, hitResist HEAVY) never attach locally — without this the member
	 * deals FULL damage to a poised enemy instead of the shield-reduced chip with the
	 * silver guard number. Each streamed shield is reconstructed as the SAME
	 * COMBAT_SHIELDS class with the SAME numeric fields, so the puppet's native
	 * isShielded reproduces the host's factor / hitResist / stableOverride / direction
	 * gates exactly. Synced connections are tagged (_mpShieldSync) so shields from any
	 * other source are left untouched; an absent/empty list clears only synced ones.
	 * duration is pinned to -1 (no timer expiry) — attach/detach is host-driven via the
	 * stream. Shield visual FX (domes) are NOT reproduced; damage correctness is the
	 * goal. */
	private syncPuppetShields(e: any, sh: IShieldSnap[] | undefined): void {
		try {
			if (!e || !Array.isArray(e.shieldsConnections)) return;
			const want: { [key: string]: IShieldSnap } = {};
			if (sh) {
				for (let i = 0; i < sh.length; i++) {
					const s = sh[i];
					if (s && typeof s.n === 'string') want[s.n + '|' + s.k] = s;
				}
			}
			// Detach synced shields the host no longer reports.
			for (let i = e.shieldsConnections.length; i--;) {
				const c: any = e.shieldsConnections[i];
				if (!c || !c._mpShieldSync) continue;
				const key = ((c.shield && c.shield.name) || '') + '|' + c._mpShieldKind;
				if (want[key]) continue;
				try {
					if (typeof e.removeShield === 'function') e.removeShield(c);
					else e.shieldsConnections.splice(i, 1);
				} catch (_) { try { e.shieldsConnections.splice(i, 1); } catch (_) { /* ignore */ } }
			}
			// Attach shields the host reports that aren't synced yet.
			const reg: any = (sc as any).COMBAT_SHIELDS || {};
			for (const key in want) {
				let exists = false;
				for (let i = 0; i < e.shieldsConnections.length; i++) {
					const c: any = e.shieldsConnections[i];
					if (c && c._mpShieldSync
						&& (((c.shield && c.shield.name) || '') + '|' + c._mpShieldKind) === key) { exists = true; break; }
				}
				if (exists) continue;
				const s = want[key];
				try {
					const cls: any = (s.k === 'PARTS' && reg.PARTS) ? reg.PARTS
						: (s.k === 'DIRECTIONAL' && reg.DIRECTIONAL) ? reg.DIRECTIONAL
						: (sc as any).CombatShield;
					if (!cls) continue;
					const inst: any = new cls({}, s.n);
					// Assign the numeric fields DIRECTLY — the constructors map string enum
					// keys, but the host already resolved them to numbers.
					inst.baseFactor = typeof s.bf === 'number' ? s.bf : 1;
					inst.elementFactors = Array.isArray(s.ef) && s.ef.length >= 4 ? s.ef.slice(0, 4) : [1, 1, 1, 1];
					inst.hitResist = typeof s.hr === 'number' ? s.hr : 4;   // ATTACK_TYPE.MASSIVE
					inst.stableOverride = typeof s.so === 'number' ? s.so : 3; // ATTACK_TYPE.HEAVY
					inst.strength = typeof s.st === 'number' ? s.st : 3;    // SHIELD_STRENGTH.BLOCK_ALL
					inst.neutralize = s.nt === 1;
					inst.duration = -1; // never expires on a timer — the stream drives detach
					if (s.k === 'DIRECTIONAL') {
						inst.range = typeof s.rg === 'number' ? s.rg : 0.5;
						inst.back = s.bk === 1;
					}
					if (s.k === 'PARTS') {
						inst.parts = Array.isArray(s.pt) ? s.pt.slice() : null;
						inst.inverse = s.iv === 1;
					}
					if (typeof e.addShield === 'function') {
						const conn: any = e.addShield(inst, 0);
						if (conn) { conn._mpShieldSync = true; conn._mpShieldKind = s.k; }
					}
				} catch (_) { /* one bad shield must not break the block */ }
			}
		} catch (_) { /* best-effort — never break the state block */ }
	}

	private _mpRehidePuppet(e: any, isFull: boolean): void {
		try {
			if (!(e && e.coll)) return;
			const coll: any = e.coll;
			const game: any = ig.game;
			const hidden = !!e._hidden;
			if (hidden && !e._mpHiddenRe) {
				e._mpHiddenRe = true;
				if (game && game.collision && typeof game.collision.untrackEntity === 'function') {
					try { game.collision.untrackEntity(coll); } catch (_) { /* ignore */ }
				}
				const att: any = e.entityAttached;
				if (att && att.length && game && game.freeEntityAttached) {
					try {
						for (let k = 0; k < att.length; k++) {
							const a: any = att[k];
							if (a && a.coll && game.collision && typeof game.collision.untrackEntity === 'function') {
								try { game.collision.untrackEntity(a.coll); } catch (_) { /* ignore */ }
							}
						}
					} catch (_) { /* ignore */ }
				}
			} else if (!hidden && e._mpHiddenRe) {
				e._mpHiddenRe = false;
				if (game && game.collision && typeof game.collision.trackEntity === 'function') {
					try { game.collision.trackEntity(coll); } catch (_) { /* ignore */ }
				}
				const att: any = e.entityAttached;
				if (att && att.length && game && game.collision && typeof game.collision.trackEntity === 'function') {
					try {
						for (let k = 0; k < att.length; k++) {
							const a: any = att[k];
							if (a && a.coll) { try { game.collision.trackEntity(a.coll); } catch (_) { /* ignore */ } }
						}
					} catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* ignore */ }
	}

	/**
	 * ROUND 63 (meerkat red flash): replay the host's "charge light" BLINK_COLOR on the
	 * puppet when its VULNERABLE annotation flips. Uses the same cached EffectSheet path
	 * as applySkillFx — the sheet may not be resident on the member (the puppet never
	 * runs its own SpecialAttack, so nothing pre-loaded "charge"), so it loads async and
	 * the spawn lands a frame late. The real effect auto-stops after its 2s duration; we
	 * also stop() it early if the host leaves the window before then. Best-effort visual.
	 */
	private _mpApplyVulnerable(e: any, on: boolean): void {
		try {
			if (on) {
				try {
					const ES: any = (ig as any).EffectSheet;
					if (ES) {
						let sheet = this._fxSheets['charge'];
						if (!sheet) sheet = this._fxSheets['charge'] = new ES('charge');
						const target = e;
						sheet.load(() => {
							try {
								if (!sheet.loaded || !target || target._killed) return;
								if (target._mpVulSynced !== true) return; // flipped off before the load landed
								target._mpVulFx = sheet.spawnOnTarget('light', target, { duration: 2 });
							} catch (_) { /* visual only */ }
						});
					}
				} catch (_) { /* visual only */ }
				this._sfxLog('vul.on', 'uid=' + (e._mpUid || 0));
			} else {
				try { if (e._mpVulFx) e._mpVulFx.stop(); } catch (_) { /* ignore */ }
				e._mpVulFx = null;
				this._sfxLog('vul.off', 'uid=' + (e._mpUid || 0));
			}
		} catch (_) { /* best-effort visual */ }
	}

	/**
	 * ROUND 63 (break FX): replay the host's "BREAK!" dramatic effect on the member's
	 * puppet. The host plays it natively when a guard-bar or reaction break triggers
	 * (sc.combat.doDramaticEffect(BREAK) in the hit-reaction path); the member's locked
	 * puppet never runs reactions, so we replay the label + speedlines + blur here. Passing
	 * the puppet as both source and target skips camera/slow-mo (no alwaysFocus), so only
	 * the visible break FX + "BREAK!" annotation play. Best-effort visual.
	 */
	private _mpPlayBreakFx(e: any): void {
		try {
			const combat: any = (sc as any).combat;
			const BREAK = (sc as any).DRAMATIC_EFFECT && (sc as any).DRAMATIC_EFFECT.BREAK;
			if (combat && BREAK && typeof combat.doDramaticEffect === 'function') {
				combat.doDramaticEffect(e, e, BREAK);
			}
			this._sfxLog('brk.fx', 'uid=' + (e._mpUid || 0));
		} catch (_) { /* best-effort visual */ }
	}

	/** Round 23: MEMBER-side stale-puppet reap (replaces the old per-block reap pass
	 * inside applyEntityState). On a member every live non-mirror enemy must be
	 * host-owned; anything else is a divergent local ghost and is killed silently
	 * (kill(true): no loot/FX):
	 *  - adopted puppet (has _mpUid) whose uid has NOT appeared in any host block for
	 *    >600ms -> died on the host (killed by it, or it stopped streaming the enemy);
	 *  - unadopted map enemy (real mapId) the host hasn't reported -> once BOTH streams
	 *    have reported a full roster (>=2 full-flagged blocks) a missing/stale (>2500ms)
	 *    stamp means the host already killed it before we arrived (or our quest state
	 *    differs) — even for an enemy that was NEVER stamped (we joined after the kill);
	 *  - mapId-0 enemy (a stray EnemySpawner product that beat the spawner inject)
	 *    -> never host-owned -> removed IMMEDIATELY.
	 * Trade-off (vs the old per-block reap): member-side deaths now reflect within
	 * ~600ms instead of on the next block, but a single dropped block can no longer
	 * reap a live puppet. Preserves every old exemption (_mpMirror / _killed /
	 * _mpDying / _mpCutsceneSpawned) and the exact kill sequence (noteMemberKill
	 * fence + _mpTg=false + playPuppetDeath(e,false)). Runs from tick() on a ~500ms
	 * accumulator. Stamps for reaped uids/mapIds are dropped; the stamp maps are
	 * capped (cleared when oversized) so a long session can't grow them unbounded. */
	private reapStalePuppets(): void {
		try {
			if (this.main.host) return; // the host owns every real enemy; nothing to reap
			const now = Date.now();
			// Round 24 (host-stall guard): no entityState block has arrived for >1200ms —
			// the host stalled, lagged hard, or dropped the connection. Reaping on a hiccup
			// would mass-kill every live puppet, so stand down until blocks resume.
			if (now - this._mpLastBlockAt > 1200) return;
			const Enemy = (ig.ENTITY as any).Enemy;
			const entities = ig.game.entities;
			const reapedUids: { [uid: number]: boolean } = Object.create(null);
			const reapedMapIds: { [mapId: number]: boolean } = Object.create(null);
			for (let i = 0; i < entities.length; i++) {
				const e: any = entities[i];
				// Round 14 (fix 5): _mpDying puppets are owned by the delayed-death queue —
				// never reap them mid-FX (the queue's silent kill removes them).
				// Round 19 (Part 3, step 2): _mpCutsceneSpawned enemies are THIS client's
				// own story monsters — preserved instead of killed (they render locally
				// and stream out via cutsceneEntity; this fixes them being silently
				// reaped on their own client every host block).
				if (!(e instanceof Enemy) || e._mpMirror || e._killed || e._mpDying
					|| (e as any)._mpCutsceneSpawned) continue;
				const uid = e._mpUid || 0;
				if (uid !== 0) {
					// Adopted puppet: reap when its uid hasn't been seen in any host block
					// for >600ms (adoption stamps the uid in the SAME block, so a
					// never-stamped uid — impossible in practice — is left alone).
					const seen = this._mpUidSeen[uid];
					if (typeof seen === 'number' && now - seen > 600) {
						// Round 16 (issue 7): fence the reap kill exactly like the predicted-kill
						// path — remember the uid as a member kill so ensurePuppet's fast path
						// can't re-adopt a FRESH live puppet alongside this frozen corpse if the
						// host block toggles the enemy's presence within the linger window (the
						// duplicate-puppet bug). Runs before playPuppetDeath stages the death.
						this.noteMemberKill(uid);
						// Fix 1 (member): clear the target lock before kill so Combatant.onKill's
						// setTarget(null) isn't swallowed (see the predicted-kill site) — the puppet
						// must leave activeCombatants and re-evaluate the member's combat mode.
						e._mpTg = false;
						// Round 14 (fix 5): FX-first death instead of the instant silent kill — the
						// death anim + blink + boom play even for reaped puppets (host already killed
						// the real enemy; nothing else would show it).
						this.playPuppetDeath(e, false);
						delete this.puppets[uid]; delete this.lastAnim[uid];
						reapedUids[uid] = true;
					}
				} else if (e.mapId) {
					// Unadopted map enemy: the host hasn't reported this mapId. Once BOTH
					// streams have reported a full roster (>= 2 full-flagged blocks), the
					// stamp is authoritative — a missing stamp means the enemy is dead on the
					// host (it was killed before we arrived, or our quest state differs), EVEN
					// when it was never stamped at all (we joined after the host killed it).
					// 2500ms stale threshold: mapId stamps are only refreshed by full blocks
					// (~1s cadence), so 600ms would reap healthy enemies between full blocks.
					const seen = this._mpMapSeen[e.mapId];
					if (this._mpFullBlockSeen >= 2 && (typeof seen !== 'number' || now - seen > 2500)) {
						e._mpTg = false;
						this.playPuppetDeath(e, false);
						reapedMapIds[e.mapId] = true;
					}
				} else {
					// mapId-0 ghost (never host-owned): remove it immediately.
					e._mpTg = false;
					this.playPuppetDeath(e, false);
				}
			}
			// Drop stamps for reaped uids/mapIds so they can't pin stale data.
			for (const uidStr in reapedUids) delete this._mpUidSeen[Number(uidStr)];
			for (const miStr in reapedMapIds) delete this._mpMapSeen[Number(miStr)];
			// Cap the stamp maps: a long session must not grow them unbounded (simple and
			// bounded — drop everything when oversized; the next host block re-stamps the
			// live set within ~66ms, so a clear is a momentary self-heal, not data loss).
			if (Object.keys(this._mpUidSeen).length > 2000) this._mpUidSeen = Object.create(null);
			if (Object.keys(this._mpMapSeen).length > 2000) this._mpMapSeen = Object.create(null);
		} catch (_) { /* never break the frame */ }
	}

	/** Resolve (or create) the puppet for a host snapshot. Preference order:
	 *  1. an already-adopted puppet for this uid (fast path),
	 *  2. a live map enemy whose mapId matches (adopt it — correct type/appearance),
	 *  3. a freshly spawned typed mirror (for host spawner enemies / cleared maps). */
	private ensurePuppet(s: IEnemySnap, mapEnemyIdx?: { [mapId: number]: any } | null): any {
		const existing = this.puppets[s.i];
		if (existing && !existing._killed) return existing;

		// Fresh member kill: we killed this puppet locally, but the host block may still
		// list the enemy for a moment (host hasn't applied/processed our damage yet). Do
		// NOT re-adopt/respawn while the kill is fresh, else the monster pops back to life
		// for up to a second. The entry expires after 5s so a legitimately respawned host
		// enemy with the same uid (EnemySpawner) still gets mirrored eventually.
		const kt = this.memberKills[s.i];
		if (kt) {
			if (Date.now() - kt < 5000) return null;
			delete this.memberKills[s.i];
		}

		let e: any = null;
		if (s.mi) e = (mapEnemyIdx && mapEnemyIdx[s.mi]) || this.findMapEnemy(s.mi); // adopt our own typed map enemy
		if (!e && s.t) e = this.spawnTypedPuppet(s);  // fallback: spawn from the block's type
		if (!e) return null;

		// ROUND 73 diagnostics: log ghost-type puppet creation (once per host uid).
		if (!e._mpPuppet && this.isGhostType(s.t)) {
			this.ghostLog('member.spawn', s.i, s.t, 'mi=' + s.mi, 'hd=' + s.hd, 'mapId=' + (e.mapId || 0));
		}

		// Bind the host's uid onto this entity so future blocks find it in O(1) and the
		// cull pass recognises it as host-owned.
		e._mpUid = s.i;
		if (!e._mpPuppet) {
			e._mpPuppet = true;
			e._mpSnapNext = true; // first block after adoption snaps instead of gliding
			try { this.main.lockEntity(e, { x: s.x, y: s.y, z: s.z }); } catch (_) { /* ignore */ }
			// ROUND 80 (body-push fix): a synced puppet is a telepresence of the HOST
			// enemy — it must never physically shove the local player. weight 0 keeps
			// the coll hittable (ball/melee touch still register) while making it
			// immovable for the impact push solver, so the meerkat's underground
			// charge can't push the member away from the spot where the host's
			// attack will land. Also overwrite its ActorConfig weight: the engine's
			// cancelStun/defaultConfig.apply would otherwise restore the original
			// weight right after the puppet's first local flinch.
			try {
				if (e.coll) e.coll.weight = 0;
				if (e.defaultConfig && typeof e.defaultConfig.overwrite === 'function') e.defaultConfig.overwrite('weight', 0);
			} catch (_) { /* ignore */ }
			// Puppets must NOT run the enemy AI attack pick — the host streams
			// animations (mpAnim pins), and a self-picked REAL attack action's
			// DIRECT_HIT step (selectType TARGET) can damage the local player with NO
			// geometry/distance check. Shadow the prototype method with an own property
			// so ig.ActorEntity.update's truthiness check (`if (this.postActionUpdate)`)
			// skips it for puppets — they play only host-driven animations.
			(e as any).postActionUpdate = null;
			// Clear any stale target the map enemy carried at adoption; the (now FULL,
			// bot-like) AI re-acquires one on its next update — which is normally the
			// local player, exactly like the game's own follower bots pick up their
			// party members. Position stays host-locked, so the AI drives behaviour
			// and animation only, never movement.
			try { if (e.setTarget) e.setTarget(null); } catch (_) { /* ignore */ }
			// Host-authoritative aggro LOCK (round-7 combat-drop fix): the engine drops
			// an enemy's target in updateTarget (distance > loseDistance for loseTime)
			// and onNavigationFailed (>5 failures). A position-locked puppet trips both
			// between 15Hz blocks, so the local AI kept nulling the host-assigned target
			// — read as the HP bar flashing red->blue and the member dropping out of
			// combat. While _mpTg is set, refuse setTarget(null) entirely. The tg block
			// clears _mpTg BEFORE calling setTarget(null) on de-aggro, so host authority
			// still ends combat; and a _killed puppet never holds the lock.
			if (!e._mpTargetGuarded && e.setTarget) {
				e._mpTargetGuarded = true;
				const origSetTarget = e.setTarget.bind(e);
				e.setTarget = function (t: any, fixed?: boolean) {
					if (!t && e._mpTg && !e._killed) return;
					return origSetTarget(t, fixed);
				};
			}
			// Host-authoritative HP: never let the puppet be "defeated" locally. Status DoT
			// (burn/chill via instantDamage), spike damage and status-application damage all
			// bypass onPreDamageModification, so the hp-refund there alone can't stop them.
			// Overriding params.isDefeated()->false blocks the death trigger at its source:
			// Combatant.update's `_onDeathHit`(needs isDefeated) and instantDamage's guard.
			try {
				if (e.params && !e.params._mpIsDefeatedPatched) {
					e.params._mpIsDefeatedPatched = true;
					e.params.isDefeated = function () { return false; };
				}
			} catch (_) { /* ignore */ }
		}
		this.puppets[s.i] = e;
		return e;
	}

	/** Spawns a correctly-typed enemy mirror. enemyInfo.type is REQUIRED (Enemy.init
	 * does `new sc.EnemyType(g.enemyInfo.type)`); without it the enemy is invisible and
	 * never animates. We load the type first, then spawn. Returns the entity, or null
	 * if the spawn was blocked (spawnCondition/_killed). */
	private spawnTypedPuppet(s: IEnemySnap): any {
		// If this enemy type is still loading, skip for now — the next block (after the
		// load completes) spawns it. Prevents stacking duplicate puppets while waiting.
		if (this.pendingTypes[s.t]) return null;
		try {
			const type = new sc.EnemyType(s.t);
			if (!(type as any).loaded) {
				this.pendingTypes[s.t] = true;
				type.load(() => { delete this.pendingTypes[s.t]; });
				return null;
			}
			const e = ig.game.spawnEntity('Enemy', s.x, s.y, s.z, {
				enemyInfo: { type: s.t },
				skipHook: true,
			} as any);
			return e || null;
		} catch (_) {
			delete this.pendingTypes[s.t];
			return null;
		}
	}

	private findMapEnemy(mapId: number): any {
		const list = ig.game.entities;
		const Enemy = (ig.ENTITY as any).Enemy;
		for (let i = 0; i < list.length; i++) {
			const e: any = list[i];
			if (e instanceof Enemy && !e._mpMirror && !e._killed && e.mapId === mapId) return e;
		}
		return null;
	}

	/** Build mapId -> live non-mirror Enemy index for O(1) adoption lookups (one scan
	 * per block, instead of one full scan per unadopted enemy). */
	private buildMapEnemyIndex(): { [mapId: number]: any } {
		const idx: { [mapId: number]: any } = Object.create(null);
		const list = ig.game.entities;
		const Enemy = (ig.ENTITY as any).Enemy;
		for (let i = 0; i < list.length; i++) {
			const e: any = list[i];
			if (e instanceof Enemy && !e._mpMirror && !e._killed && e.mapId) idx[e.mapId] = e;
		}
		return idx;
	}

	/** The uid we track this entity by: the host's uid once adopted, else 0. */
	private uidOf(e: any): number {
		return e._mpUid || 0;
	}

	/**
	 * HOST MIGRATION: called when this client is promoted from member to host. Our
	 * puppet enemies are position-locked AND animationFixed-pinned (playAnim), so
	 * simply stopping the AI override would leave them frozen, target-less and stuck
	 * on one sprite. The robust fix is to RESPAWN each enemy fresh (same type/pos/hp/
	 * mapId) so the engine re-runs its full AI setup, then re-target it at us. The old
	 * puppet is killed silently (kill(true) -> no loot/FX). After this the client owns
	 * real, AI-driven enemies and starts streaming the block for the remaining members.
	 */
	public promoteToHost(): void {
		const mapAtStart = ig.game && ig.game.mapName;
		// Round 22 (opt 2) / Round 23 (split): the delta maps were built from OLD
		// (puppet) uids — the respawned real enemies get fresh uids, so clear BOTH and
		// force the first blocks after promotion to be FULL. Open hit windows + the
		// member-side liveness stamps are ours to drop too (we're the authority now).
		this._mpLastBaseEncoded.clear();
		this._mpLastHostileEncoded.clear();
		this._mpBaseFullAccum = 0;
		this._mpHostileFullAccum = 0;
		this._mpBaseTimer = 0;
		this._mpBaseLastPlayerCount = -1;
		this._mpHostileLastPlayerCount = -1;
		this._mpUidSeen = Object.create(null);
		this._mpMapSeen = Object.create(null);
		// Round 24: roster is unknown until both streams report a full block; reap
		// resets alongside the other member-side state above.
		this._mpFullBlockSeen = 0;
		this._mpReapTimer = 0;
		this._mpLastBaseCb = -1;
		this._mpLastHostileCb = -1;
		// Round 14 (fix 5): any member-side dying puppets (delayed-death FX pending)
		// become real enemies on promotion — kill them silently (kill(true): no
		// loot/FX) so no half-dead, frozen puppets linger, then drop the queue.
		for (const q of this._mpDeathQueue) {
			const de = q && q.e;
			if (de && !de._killed) {
				de._mpTg = false;
				try { de.kill(true); } catch (_) { /* ignore */ }
			}
		}
		this._mpDeathQueue = [];
		let respawning = 0;
		let anyEngaged = false;
		for (const uidStr in this.puppets) {
			const e = this.puppets[uidStr];
			delete this.puppets[uidStr];
			delete this.lastAnim[uidStr];
			if (!e || e._killed) continue;
			try {
				const type = e.enemyName || (e.enemyType && (e.enemyType as any).name) || '';
				const pos = { x: e.coll.pos.x, y: e.coll.pos.y, z: e.coll.pos.z };
				const hp = e.params ? e.params.currentHp : 0;
				const mapId = e.mapId || 0;
				// Was this enemy engaged (had a target / host streamed tg=1)? Round-8
				// aggro-inheritance: the engine's detectDistance default (120) is SMALLER
				// than loseDistance (240), so an enemy engaged beyond 120px can NOT
				// re-acquire by proximity after a target-less respawn — which was exactly
				// "host switched maps and every monster lost aggro / went passive".
				const engaged = !!(e.target || e._mpTg);
				if (engaged) anyEngaged = true;
				if (!type) {
					// Can't resolve the type -> can't respawn it; leave the puppet as-is
					// rather than killing it into a permanent gap.
					// Round 17: with the puppet AI removed (A1), a _mpPuppet leftover on the
					// promoted HOST would run the AI-less Combatant.update forever — a frozen
					// monster on the authority side. Clear the marker (+ the target lock so
					// the setTarget(null) guard can't hold an old aggro) so it regains full AI.
					try { e._mpPuppet = false; e._mpTg = false; } catch (_) { /* ignore */ }
					console.warn('[netsync] promoteToHost: puppet uid=' + uidStr + ' has NO resolvable type — kept as puppet');
					continue;
				}
				// Preserve the enemy's full spawn settings (level/group/state/targetOnSpawn/
				// dropHealOrb/varIncrease/...) so the respawned enemy matches the original;
				// a bare {enemyInfo:{type}} would reset it to defaults. enemyInfo goes in
				// FIRST with our resolved type so the merge result ALWAYS carries it —
				// settings without enemyInfo produced null-typed enemies (invisible +
				// "all monsters vanished" after host migration). e.settings (when present)
				// deep-merges over it and may replace type with its own full info object.
				const baseSettings = ig.merge(
					{ skipHook: true, mapId, enemyInfo: { type } },
					e.settings || {});
				// Load is async — spawn only once the type is resident, else the enemy is
				// invisible. If it's already cached this runs immediately.
				new sc.EnemyType(type).load(() => {
					// Guard: if we teleported away while the type loaded, don't spawn into
					// the wrong map at stale coordinates.
					if (!ig.game || ig.game.mapName !== mapAtStart) return;
					try {
						const spawned: any = ig.game.spawnEntity('Enemy', pos.x, pos.y, pos.z, baseSettings as any);
						if (!spawned) {
							// spawnCondition evaluated false or the entity self-killed in init.
							console.warn('[netsync] promoteToHost: respawn BLOCKED for ' + type + ' at '
								+ Math.round(pos.x) + ',' + Math.round(pos.y));
							return;
						}
						// Safety net: an enemy without a resolved type is invisible and
						// crashes on kill — patch it even though we passed enemyInfo.
						if (!spawned.enemyType) {
							console.warn('[netsync] promoteToHost respawn LACKED enemyType for ' + type + ' — patching');
							try { spawned.enemyType = new sc.EnemyType(type); spawned.enemyName = spawned.enemyName || type; } catch (_) { /* ignore */ }
						}
						// Restore remaining HP.
						if (spawned.params && hp > 0) spawned.params.currentHp = hp;
						// Aggro inheritance (round 8): an ENGAGED puppet's respawned enemy
						// immediately targets the local player (targetFixed=true keeps it
						// through the first AI tick). Passive/peaceful enemies (not engaged)
						// still spawn target-less and aggro only by proximity, as vanilla.
						if (engaged && !spawned._killed) {
							const pl: any = ig.game.playerEntity;
							try { if (pl && spawned.setTarget) spawned.setTarget(pl, true); } catch (_) { /* ignore */ }
						}
					} catch (err) {
						console.warn('[netsync] promoteToHost respawn threw for ' + type, err);
					}
				});
				try { e.kill(true); } catch (_) { /* ignore */ }
				respawning++;
			} catch (_) { /* ignore */ }
		}
		// The fight continues across the migration: if any puppet was engaged, the new
		// host is in combat too (setTarget above already flips the engine's combat mode
		// via targetedBy -> updateCombatMode; this is belt-and-braces for the case where
		// the spawns are still async-loading). NOTE (round 9): playerStartedCombat is
		// deliberately NOT touched — the engine never clears it and it only feeds the
		// ENEMY_ATTACKS common-event condition, not the combat state.
		if (anyEngaged) {
			try {
				if ((sc as any).model && (sc as any).model.setCombatMode) (sc as any).model.setCombatMode(true);
			} catch (_) { /* ignore */ }
		}
		console.log('[netsync] promoted to host: respawning ' + respawning + ' puppets as real AI enemies'
			+ (anyEngaged ? ' (combat continues)' : ''));
	}

	/** Plays an animation on a locked mirror/puppet (setting `currentAnim` alone is inert
	 * under the lock). Issued on anim CHANGE only. */
	private playAnim(entity: any, anim: string): void {
		// A single persistent ig.Action holding one SHOW_ANIMATION step is far cheaper
		// than the old per-frame CLEAR_ANIMATION+DO_ACTION event objects, and setAction
		// cleanly cancels the prior action (no event-step pile-up). SHOW_ANIMATION also
		// sets animationFixed=true, pinning the anim against ActorEntity.update's
		// walk-anim logic. Falls back to a plain setCurrentAnim if the action path throws.
		try {
			const action = new (ig as any).Action('mpAnim', [
				{ type: 'SHOW_ANIMATION', anim },
				{ type: 'WAIT', time: -1 },
			], false, false);
			entity.setAction(action);
		} catch (e) {
			try {
				if (entity.setCurrentAnim) entity.setCurrentAnim(anim, true, null, true);
				entity.animationFixed = true;
			} catch (_) { /* ignore */ }
		}
	}

	/** Round 9: visual-only melee sweep for a remote player's attack animation.
	 *
	 * On the attacking player's own machine the attack ACTION step COMBAT_SWEEP calls
	 * sc.CombatSweep.show(), which spawns BOTH the damaging CircleHitForce hitbox AND
	 * the sheet effect. Mirrors only replay the animation (no action step runs), so
	 * teammates never saw the swing arc. We re-spawn just the VISUAL half here via
	 * EffectSheet.spawnOnTarget — never sc.CombatSweep.show (that would add a live
	 * hitbox on the mirror side and double-deal damage through the enemy strip).
	 * spawnOnTarget returns null/no-ops if the sheet isn't loaded, which is safe.
	 *
	 * v2 (round 11): element-tinted + class-aware sweeps. The playerState stream now
	 * carries the owner's element mode (em) and class string (cl), so mirrors pick
	 * the same COMBAT_SWEEPS family + key the engine itself would use:
	 *   attack/attackRev   -> COMBAT_SWEEPS[cl]          .keys[em] (+ "Rev")
	 *   attackFinisher     -> COMBAT_SWEEPS[cl+"_FINISHER"].keys[em]
	 * Unknown class falls back to SPHEROMANCER (round-9 behaviour). Skill SHOW_EFFECT
	 * visuals are synced separately via the EffectSheet hook (applySkillFx).
	 * ROUND 42 (item 2): also fire an audible sweep whoosh on the mirror for the art
	 * anims. The Lv1 neutral spin art (回旋斩 / "Spin Dance") has NO sound entry in the
	 * vanilla `special-neutral` sheet data, so nothing reached playAtEntity and the member
	 * heard the charge + release blips but NEVER the art firing. The sweep sheets' own
	 * effect audio is unreachable too (playAtEntity is wrapper-wrapped, and the mirror's
	 * effect doesn't target our player), so play the mirror's sweep sheet effect AND push
	 * an explicit whoosh directly through the wrapped playAtEntity under the loop-guard.
	 * A close-combat art anim (its name contains "spin" — spinFullLong/spinFullRev — or
	 * is attackLong/attackFinisher) uses the finisher family; a plain melee anim uses the
	 * base family, mirroring the engine's own COMBAT_SWEEP step choice. */
	private spawnAttackFxForAnim(ent: any, anim: string, elementMode?: number, clazz?: string): void {
		try {
			const sweeps: any = (sc as any).COMBAT_SWEEPS;
			if (!sweeps) return;
			const em = (typeof elementMode === 'number' && elementMode >= 0 && elementMode <= 4) ? elementMode : 0;
			// ROUND 42: the art's sweep whoosh is handled by the REAL skill-FX relay
			// (the 'special-neutral' sheet is whitelisted in the EffectSheet wrap, so the
			// receiver re-plays the actual close-combat-sweep-massive PLAY_SOUND from
			// data/effects/special-neutral.json). No hardcoded sound path here — the old
			// _mpCombatSweepSound fallback never existed in the engine and was removed.
			let entry: any = null;
			let reversed = false;
			const isArt = anim === 'attackFinisher' || anim === 'attackLong'
				|| (typeof anim === 'string' && anim.indexOf('spin') >= 0);
			if (anim === 'attack' || anim === 'attackRev') {
				entry = (clazz && sweeps[clazz]) || sweeps.SPHEROMANCER;
				reversed = anim === 'attackRev';
			} else if (isArt) {
				entry = (clazz && sweeps[clazz + '_FINISHER']) || sweeps.SPHEROMANCER_FINISHER;
				reversed = anim === 'attackFinisherRev' || anim === 'spinFullRev';
			} else {
				return;
			}
			const sheet = entry && entry.sheet;
			if (!sheet || typeof sheet.spawnOnTarget !== 'function' || !entry.keys) return;
			let key: string = entry.keys[em] || entry.keys[0];
			if (reversed) key += 'Rev';
			// Some families lack Rev variants for every element — degrade to the
			// non-reversed key rather than skipping the visual entirely.
			if (typeof sheet.hasEffect === 'function' && !sheet.hasEffect(key)) {
				if (reversed) key = entry.keys[em] || entry.keys[0];
				if (!sheet.hasEffect(key)) return;
			}
			sheet.spawnOnTarget(key, ent, { rotateFace: 8, flipLeftFace: false, duration: 0 });
		} catch (_) { /* visuals must never break sync */ }
	}
}
