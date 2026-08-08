import { Multiplayer } from '../multiplayer';
import { t } from '../i18n';
import { isSharedTownNow } from '../util/areaUtil';

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
}

export class NetSync {
	/** uid -> puppet enemy (member side). Null-prototype: keyed by the numeric uid. */
	private puppets: { [uid: number]: any } = Object.create(null);
	private mapName = '';
	private sendTimer = 0;
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
	/** Round 19 (Part 3): member-side cutscene-spawned monsters ('cs'+uid -> puppet).
	 * Deliberately SEPARATE from the host-block `puppets` map — the two spaces never
	 * interact (different spawn path, different reap rules, IGNORE collision). */
	private csPuppets: { [key: string]: any } = Object.create(null);
	/** Round 19: ~15Hz accumulator for the member cutscene-entity stream. */
	private _mpCsSendTimer = 0;
	/** Round 19: last-seen timestamp per cutscene-entity stream owner (username).
	 * An owner whose stream stops for >2s has its csPuppets reaped as orphans
	 * (left the map / disconnected). */
	private _mpCsOwnerSeen: { [from: string]: number } = Object.create(null);
	/** Round 19: last-applied {alpha, coll} per remote mirror ENTITY (Map keyed by
	 * the entity reference, so a freshly-respawned mirror is a fresh key and always
	 * gets its fade written on the next pass — a name-keyed cache would inherit a
	 * stale "already applied" entry and leave a mid-cutscene respawn at full alpha).
	 * Reset on map change / disconnect / cutscene end. */
	private _mpMirrorFadeCache: Map<any, { alpha: number, coll: any }> = new Map();

	/** Read by the ig.game.respawn shadow installed in install(). */
	public allowNativeRespawn(): boolean { return this._mpAllowRespawn; }

	constructor(private main: Multiplayer) { }

	public install(): void {
		const conn = this.main.connection;
		conn.onPlayerState((p, s) => this.applyPlayerState(p, s));
		conn.onEntityState((map, list, cb) => this.applyEntityState(map, list, cb));
		// Host forwarded an enemy-hit that landed on OUR mirror: apply it to our real player.
		conn.onCombatHit((hit) => this.applyCombatHit(hit));
		// Member forwarded its damage to US (the host): apply it to the real enemy.
		conn.onEnemyDamage((hit) => this.applyEnemyDamage(hit));
		// Round 11: a remote player cast a special skill — replay its effect sheet
		// on their mirror.
		conn.onSkillFx((player, fx) => this.applySkillFx(player, fx));
		// Round 19: a client's cutscene-spawned monsters arrived (the server stamps
		// the stream owner as `from`). Render them as csPuppets on members.
		conn.onCutsceneEntity((from, data) => this.applyCutsceneEntity(from, data));

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
							if (b && pl && b === pl && m && m.netSync && connOk) return;
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
							if (connOk && !allowed) {
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
			// NO-PAUSE WHILE PARTIED (round 10, user: 关闭所有时间暂停功能). Every
			// user-triggerable gameplay pause (ESC pause menu, main menu / bag / inventory,
			// SHIFT quick menu, skip-confirm dialog, teleport-info dialog) funnels through
			// ig.Game.setPaused(true) — the engine has exactly this one pause API. While in
			// a party with other online players we swallow the PAUSE (never the unpause):
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
								if (connOk && partied) {
									console.log('[netsync] pause suppressed while partied');
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
								try { const ns = cur(); if (ns) ns.inCutscene = true; } catch (_) { /* ignore */ }
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
						if ((this as any)._mpDying || (this as any)._mpPuppet) {
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
							// (A) member hit a puppet: let the damage stand locally, forward it to
							// the host, and handle the killing blow without loot/kill-vars.
							const dmg = rest[3]; // damageResult (u)
							if (dmg && typeof dmg.damage === 'number' && dmg.damage > 0) {
								ns.forwardEnemyDamage(this, dmg.damage);
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
								ns.syncPuppetHitFlinch(this);
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
						} else if (this._mpMirror) {
							// (B) host: an enemy hit a remote player's mirror -> forward to owner.
							// rest[0] is the attacking enemy — its position rides along so the
							// owner can knock their player away from the hit (round 11).
							ns.forwardMirrorHit(this, rest[3], rest[0]);
						} else {
							// (C) host: our REAL enemy was damaged through applyEnemyDamage's
							// target.damage(mirror, ...) call — the engine recomputed its own
							// number from the mirror's stats; force the exact forwarded value
							// (the member already saw THIS number land locally).
							try {
								const atk: any = rest[0];
								const root: any = atk && atk.getCombatantRoot ? (atk.getCombatantRoot() || atk) : atk;
								if (root && root._mpMirror && root._mpForcedDamage != null) {
									const du = rest[3];
									if (du) du.damage = root._mpForcedDamage;
									root._mpForcedDamage = null;
								}
							} catch (_) { /* ignore */ }
						}
						return r;
					},
				});

				// MEMBER-side: a puppet's attack must not actually hurt the local player —
				// the real damage arrives as a forwarded combatHit from the host. Zero any
				// damage whose attacker is a puppet — including RANGED: a projectile isn't
				// the puppet itself, so walk the `owner` chain up to whatever fired it.
				// The member only ever loses HP to the host's authoritative numbers (no
				// double-hit).
				try {
					(ig.ENTITY as any).Player.inject({
						// Round 14 (fix 3): while partied the menus no longer pause the world
						// (the setPaused swallow above), so ig.game.isControlBlocked() stays
						// FALSE with SHIFT/ESC/TAB open and the local player keeps moving /
						// attacking behind the menu. gatherInput() is the single input choke
						// point (it returns the shared input object the engine reads), so zero
						// the movement/attack axes whenever a menu substate is up — only for an
						// online party (solo players keep the engine's own pause semantics).
						// NOT wrapping isPlayerControlBlocked / isControlBlocked — verified they
						// break quick-menu open and element swapping.
						gatherInput(this: any) {
							const r = this.parent();
							try {
								const m: any = (window as any).__mpMain;
								const connOk = !!(m && m.connection && m.connection.isOpen && m.connection.isOpen());
								const partied = !!(m && m.partyMembers && m.partyMembers.length > 1);
								if (connOk && partied) {
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
						// enemy attacks, spikes). Real HP only moves via the host's
						// authoritative combatHit (applyCombatHit uses params.reduceHp
						// directly, not damage()). Blocking at the damage entry point ALSO
						// stops the engine's onPerfectDash FX/witch-time that the
						// invincibleTimer path would otherwise spam on every blocked hit
						// (and covers hitInvincible/BREAK attacks, which bypass the timer).
						damage(this: any, ...args: any[]) {
							try {
								const m = (window as any).__mpMain;
								if (m && m.netSync && m.netSync.isLocalDead()) return false;
							} catch (_) { /* ignore */ }
							return this.parent(...args);
						},
						onPreDamageModification(this: any, a: any, ...rest: any[]) {
							const r = this.parent(a, ...rest);
							try {
								// Engine signature: onPreDamageModification(f, a, c, g, u, q, t)
								// where f (our `a`) is a scratch hit-config object and the
								// ATTACKER is the 2nd arg = rest[0]. Walking .owner on the
								// config object never matched a puppet, so puppet hits were
								// never zeroed (member took local damage AND the forwarded
								// combatHit — double damage).
								const attacker = rest[0];
								let root = attacker;
								while (root && root.owner && root.owner !== root) root = root.owner;
								if ((!root || !root._mpPuppet) && attacker && attacker.getCombatantRoot) {
									const cr = attacker.getCombatantRoot();
									if (cr) root = cr;
								}
								if (root && root._mpPuppet) {
									const dmg = rest[3];
									if (dmg && typeof dmg.damage === 'number') dmg.damage = 0;
								}
							} catch (_) { /* ignore */ }
							return r;
						},
					});
				} catch (e) { console.warn('[netsync] player damage-guard inject failed', e); }
			} catch (e) { console.warn('[netsync] enemy puppet inject failed', e); }

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

			// ROUND 19 (Part 3, step 1): flag cutscene-spawned monsters. Story sequences
			// spawn enemies via ig.Game.spawnEntity with mapId 0 and settings WITHOUT
			// skipHook (every mod spawn passes skipHook — mirrors, typed puppets, promote-
			// to-host respawns). Mark those so (a) the member reap pass preserves them
			// locally instead of silently killing them every host block, and (b) the
			// sender stream broadcasts them as temporary csPuppets.
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
								&& (r.mapId || 0) === 0) {
								r._mpCutsceneSpawned = true;
							}
						} catch (_) { /* never break a spawn */ }
						return r;
					};
				}
			} catch (e) { console.warn('[netsync] spawnEntity wrap failed', e); }

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
						if (ent && !ent._killed && ent.coll && !ent._hidden) out.push(ent);
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
						const had = enemy.target;
						this.parent(enemy);
						// If the vanilla logic didn't acquire a target, try the nearest mirror
						// in detect range (same distance/z-delta rules the vanilla branch uses).
						if (!had && !enemy.target) {
							const mirrors = mirrorTargets();
							if (mirrors.length) {
								const td = this.targetDetect;
								for (let i = 0; i < mirrors.length; i++) {
									const mir = mirrors[i];
									const dist = enemy.distanceTo(mir);
									const dz = Math.abs(enemy.coll.pos.z - mir.coll.pos.z);
									if (dist < td.detectDistance && (!td.detectZDelta || dz < td.detectZDelta)) {
										if (td.onDistance || td.onCloseBattle) { this.assignTarget(enemy, mir, true); break; }
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
	 * enemyAttack — {uid, anim} at a fresh attack-anim edge). Our member-side puppet no
	 * longer runs local AI (A1), so replay the attack toward the LOCAL player at the
	 * host's cadence: real aggro (setTarget — the pre-fix AI did the same) + the attack
	 * anim. The authoritative damage/feedback still arrive separately via the host's
	 * combatHit, so this is purely the visual attack replay that keeps round-2
	 * "monsters attack members" alive. Guards: skip dead/dying puppets; a failed relay
	 * must never break block-apply. */
	public applyEnemyAttack(uid: number, anim: string): void {
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
		} catch (_) { /* a failed attack relay must never break block-apply */ }
	}

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
	 * MEMBER side: our hit on a puppet already applied locally (HP drop + damage
	 * number, bot-like feedback). Forward the SAME amount to the host so the
	 * authoritative real enemy loses the HP too — shared HP bars. Forward every
	 * hit (no rate limit; tiny packets on a LAN) so locally-shown damage always
	 * matches what the host applies.
	 */
	public forwardEnemyDamage(entity: any, damage: number): void {
		if (this.main.host) return;                  // only members forward
		const uid = entity && entity._mpUid;
		if (!uid || typeof damage !== 'number' || damage <= 0) return;
		this.main.connection.enemyDamage({ uid, damage, attacker: this.main.name });
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
				if (!entity.target) entity.setTarget(pl);
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
		try { (e as any).coll.type = (ig as any).COLLTYPE.IGNORE; } catch (_) { /* ignore */ }
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
	private applyEnemyDamage(hit: { uid: number, damage: number, attacker: string }): void {
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
				try { target.setTarget(mirror); } catch (_) { /* ignore */ }
			}
			// Group aggro: a member hitting ONE enemy of a cluster must aggro the
			// whole cluster on the host too (same engine call the vanilla proximity
			// aggro uses). Neighbours acquire the attacker's mirror as their target,
			// which then streams to the member via the block's tg flag.
			this.notifyGroupAggro(target);
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
					// getElement() reads tackle.attackInfo.element — neutral passes
					// element shields/filters that would otherwise swallow the hit.
					// The fake tackle MUST be restored synchronously: left in place,
					// the mirror's own Combatant.update consumes it via checkTackle
					// next frame and onDamage crashes on the bare object (no
					// damageFactor/limiter — the round-12 host crash).
					const prevTackle = mirrorAny.tackle;
					mirrorAny.tackle = { attackInfo: { element: 0 } };
					try {
						const info = new (sc as any).AttackInfo(mirrorAny.params, {
							type: 'MEDIUM', element: 0, hitInvincible: true,
						});
						// Class default is limiter:null and the ctor never sets it —
						// onDamage derefs c.limiter.* unconditionally.
						info.limiter = info.limiter || {};
						// Round 20 (fix 2): a member's forwarded hit must land even when the
						// monster has no target yet or sits far from the host's screen.
						// Combatant.damage (game.compiled.js ~byte 2492349) rejects ENEMY-party
						// hits when `!this.target && !b.limiter.noAggro` (and the mirror
						// attacker isn't a player, so the far-off-screen clause also rejects).
						// noAggro opts the hit out of that gate. The engine ALSO gates
						// Enemy.onDamage's auto-aggro (damageUpdate, ~byte 2583530) on
						// `!b.limiter.noAggro`, so this does NOT steal aggro — the explicit
						// setTarget + notifyGroupAggro above remain the aggro drivers.
						info.limiter.noAggro = true;
						// Fix 2: the 3rd arg (Combatant.damage's `c`) must be the target, not
						// null. The engine gates `!c && this.coll.subColls.length > 0` ->
						// return false, so null there drops every multi-part enemy into the
						// bare-HP fallback below — member-forwarded hits showed only the
						// number, no flinch/knockback/sparks. Passing the target kills the
						// guard, and onDamage's `r = c || this` still resolves to the target.
						applied = target.damage(mirror, info, target) !== false;
					} finally {
						mirrorAny.tackle = prevTackle;
					}
				} catch (_) { applied = false; }
				if (!applied) (mirror as any)._mpForcedDamage = null;
				// Round 20 (fix 3): on the success path the engine already ran
				// doDamageMovement with the degenerate direction (see awayDir above) — our
				// call runs second and snap-sets the velocity to the correct away direction.
				if (applied) this.applyEnemyKnockback(target, mirror, awayDir);
			}
			if (!applied) {
				// Fallback (mirror not up / multi-part enemy colliding / damage refused):
				// bare HP write + a manual damage number so the hit is still visible.
				target.params.reduceHp(dmg);
				this.spawnHitNumberOn(target, dmg, false);
				// Round 20 (fix 3): the fallback skips the engine's whole damage chain, so
				// there was no knockback at all — apply the away-from-mirror knockback here.
				this.applyEnemyKnockback(target, mirror, awayDir);
			}
		} catch (_) { /* never let a combat packet crash the frame */ }
	}

	/** Round 20 (fix 3): knock a host enemy away from the member's mirror after a
	 * member-initiated hit. The engine's getHitVel derives knockback from the ATTACKER's
	 * velocity, which is zero on a lockEntity-locked mirror — it falls back to
	 * flip(victim.vel) and knocks a stationary monster DOWN instead of away. We call
	 * doDamageMovement directly with the center-to-center away direction: hitStable=false
	 * snap-sets coll.vel (no additive fighting), reverse=false (dir already points away
	 * from the mirror), MEDIUM fly level matches the enemy's own damage reaction, and the
	 * returned stun feeds damageTimer. Safe no-op when the mirror is gone or the engine
	 * routine is unavailable. */
	private applyEnemyKnockback(target: any, mirror: any, dir: { x: number, y: number }): void {
		try {
			if (!mirror || !target || typeof target.doDamageMovement !== 'function') return;
			const stun = target.doDamageMovement({ x: dir.x, y: dir.y }, 'MEDIUM', false, false, 0, false, false, 1);
			target.damageTimer = Math.max(target.damageTimer || 0, stun || 0.25);
		} catch (_) { /* knockback is cosmetic — never break the hit */ }
	}

	/** Spawn a damage number on a combatant at its REAL hit position (the old
	 * `spawnHitNumber(null, ...)` calls silently threw — the engine reads pos.x). */
	private spawnHitNumberOn(ent: any, dmg: number, critical: boolean): void {
		try {
			if (!ig.ENTITY.HitNumber || !(ig.ENTITY.HitNumber as any).spawnHitNumber || !ent) return;
			let pos: any = null;
			try { if (typeof ent.getHitCenter === 'function') pos = ent.getHitCenter(ent, (ig as any).Vec3.create()); } catch (_) { /* ignore */ }
			if (!pos && ent.coll) {
				const s = ent.coll.size || { x: 0, y: 0, z: 0 };
				pos = { x: ent.coll.pos.x + s.x / 2, y: ent.coll.pos.y + s.y / 2, z: ent.coll.pos.z + s.z / 2 };
			}
			if (!pos) return;
			(ig.ENTITY.HitNumber as any).spawnHitNumber(pos, ent, dmg, 1, 1, 0, !!critical, false);
		} catch (_) { /* ignore */ }
	}

	/**
	 * MEMBER side: the host told us an enemy hit OUR mirror — apply the damage to our
	 * real player. Uses the player's own params.reduceHp so defense/element are already
	 * baked into the forwarded number, and plays the standard hit reaction + damage
	 * number so the hit feels real. Guards i-frames (invincibleTimer) so a stun-locked
	 * player isn't machine-gunned.
	 */
	private applyCombatHit(hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number }): void {
		try {
			if (!hit || hit.player !== this.main.name) return;   // not for us
			if (this._mpDead) return;                            // corpse takes no hits
			const p: any = ig.game.playerEntity;
			if (!p || !p.params || p._killed) return;
			if (p.invincibleTimer && p.invincibleTimer > 0) return; // i-frames
			let dmg = Math.max(1, Math.round(hit.damage));
			// Round 20 (fix 1): a GUARDING member's shield must reduce forwarded monster
			// damage. applyCombatHit goes straight into params.reduceHp, bypassing the
			// engine's shield pipeline (CombatParams.reduceHp performs no shield check).
			// Replicate the engine's PLAYER-shield damageFactor here (game.compiled.js
			// ~byte 2442243): f = atk/def, then the engine's non-linear curve, minus the
			// GUARD_STRENGTH modifier, clamped to [0,1]; final damage = dmg*f and MAY
			// reach 0 (the unguarded minimum-1 floor below stays; only guarded hits may
			// go to 0). Guarding is signalled by currentAnim === 'guard' — the same flag
			// the playerState stream and syncGuardFx key off.
			const guarding = typeof p.currentAnim === 'string' && p.currentAnim === 'guard';
			if (guarding) {
				const atk = (typeof hit.attack === 'number' && hit.attack > 0) ? hit.attack : dmg;
				const def = p.params.getStat('defense');
				let f = def > 0 ? atk / def : 0;
				f = f <= 1 ? 0.2 - (1 - Math.pow(f, 0.3)) : 0.2 + (Math.pow(f, 1.1) - 1) * 0.35;
				f = Math.max(0, Math.min(1, f - (p.params.getModifier('GUARD_STRENGTH') || 0)));
				dmg = Math.max(0, Math.round(dmg * f)); // guarded hits may reduce to 0
				// Accumulate the guard bar exactly like the engine's Player.damageShield
				// (game.compiled.js ~byte 3018447): guard.damage += taken/7, with the
				// <=0.75 soft-cap. We ONLY accumulate — the ENGINE owns the bar's lifecycle
				// (regen, the >=1 break path, the guard-drop on break), so a forwarding-
				// induced break still behaves like a real engine break.
				try {
					if (p.guard && typeof p.guard.damage === 'number') {
						const before = p.guard.damage;
						p.guard.damage = before + dmg / 7;
						if (before <= 0.75 && p.guard.damage >= 1) p.guard.damage = 0.99;
					}
				} catch (_) { /* guard-bar accumulation is cosmetic — never break the hit */ }
			}
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
				// Round 20 (fix 1): while guarding, skip the knockback movement — the guard
				// pose is stable (the engine's guard shield keeps the player rooted). Keep
				// the hit number / flinch (showHitEffect + spawnHitNumberOn) below.
				if (!guarding && typeof p.doDamageMovement === 'function') {
					const stun = p.doDamageMovement(dir, 'LIGHT', false, false, 0);
					p.damageTimer = Math.max(p.damageTimer || 0, stun || 0.2);
				}
				const scAny: any = sc as any;
				if (scAny.combat && typeof scAny.combat.showHitEffect === 'function' && p.coll) {
					const s = p.coll.size || { x: 0, y: 0, z: 0 };
					scAny.combat.showHitEffect(p,
						{ x: p.coll.pos.x + s.x / 2, y: p.coll.pos.y + s.y / 2, z: p.coll.pos.z + s.z },
						1 /* sc.ATTACK_TYPE.LIGHT */, hit.element || 0, 0 /* SHIELD_RESULT.NONE */, !!hit.critical);
				}
			} catch (_) { /* feedback is cosmetic — never block the HP write */ }
			// Damage number at the player's real hit position (the old null-pos call
			// silently threw, so members never saw their own HP-loss numbers).
			this.spawnHitNumberOn(p, dmg, !!hit.critical);
		} catch (e) { /* never let a combat packet crash the frame */ }
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
				// Round 19 (Part 3): a map change voids every cutscene puppet (they
				// belong to the map we just left) + cached mirror fade state.
				this.clearCsPuppets();
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
			// Round 14 (fix 5): advance member-side delayed-death FX (boom + silent kill).
			this.processDeathQueue();
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
				this.sendEnemyBlock();
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
			if (!this.main.host) this.sendCutsceneEntityBlock();
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
		// No anim updates while dead: the mirror keeps its last pose instead of
		// mirroring the corpse's local input-driven walk cycle.
		const anim = this._mpDead ? '' : (typeof p.currentAnim === 'string' ? p.currentAnim : '');
		const face = p.face || { x: 0, y: 1 };
		const params = p.params || {};
		this.main.connection.updatePlayerState({
			pos: { x: pos.x, y: pos.y, z: pos.z },
			face: { x: face.x, y: face.y },
			anim,
			// Death flag: teammates remove our mirror while we're dead (a corpse
			// standing frozen in place reads as a bug — the player should visibly
			// be GONE until respawn).
			dead: this._mpDead ? 1 : 0,
			hp: params.currentHp, maxHp: params.getStat ? params.getStat('hp') : 0,
			sp: params.currentSp, maxSp: params.maxSp,
			// Round 10: skill/ball charge flag — drives the party-wide charge
			// time-stop on every client (charging.time >= 0 = charging; vanilla
			// accumulates it in REAL time even while the world is slowed).
			cg: this.localCharging() ? 1 : 0,
			// Round 11: element mode + class drive the element-tinted, class-correct
			// melee sweep visuals on every mirror (see spawnAttackFxForAnim).
			em: this.localElementMode(),
			cl: this.localPlayerClass(),
			// Round 19 (Part 1): cutscene flag — teammates fade our mirror + dim our
			// name tag while we're in a story sequence, and skip aggro targeting us.
			cs: (sc as any).model && (sc as any).model.isCutscene ? ((sc as any).model.isCutscene() ? 1 : 0) : 0,
		});
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

	private sendEnemyBlock(): void {
		this.sendTimer -= ig.system.tick;
		if (this.sendTimer > 0) return;
		this.sendTimer = 0.066; // ~15x/sec
		const out: IEnemySnap[] = [];
		const list = ig.game.entities;
		const Enemy = (ig.ENTITY as any).Enemy;
		for (let i = 0; i < list.length; i++) {
			const e: any = list[i];
			if (!(e instanceof Enemy)) continue;
			// NOTE: do NOT skip `_hidden` here — a host enemy that burrows/phases must stay
			// in the block or members would reap (kill) its puppet and lose the adopted map
			// enemy. We keep streaming it (frozen in place) so the puppet survives.
			if (e._mpMirror || e._killed || !e.coll) continue;
			const face = e.face || { x: 0, y: 1 };
			out.push({
				i: e.uid,
				mi: e.mapId || 0,
				t: e.enemyName || (e.enemyType && (e.enemyType as any).name) || '',
				x: Math.round(e.coll.pos.x), y: Math.round(e.coll.pos.y), z: Math.round(e.coll.pos.z),
				fx: face.x, fy: face.y,
				a: typeof e.currentAnim === 'string' ? e.currentAnim : '',
				h: e.params ? e.params.currentHp : 0,
				m: e.params && e.params.getStat ? e.params.getStat('hp') : 0,
				tg: e.target ? 1 : 0,
			});
			// Round 17 (issue 1): forward a live host enemy's ATTACK to the members so
			// their puppets perform it toward the local player (puppets no longer run the
			// local AI). Detect a FRESH edge into an attack-relevant anim at block cadence
			// (~15Hz) — the anim edge IS the de-dupe, so an attack whose anim persists over
			// several blocks relays exactly once. Gated on e.target: enemies only attack
			// while engaged. Missed super-fast attacks are a visual-only degradation; the
			// authoritative damage/feedback still reach members via the host's combatHit.
			try {
				const atkAnim = typeof e.currentAnim === 'string' ? e.currentAnim : '';
				if (atkAnim && e._mpLastAtkAnim !== atkAnim) {
					e._mpLastAtkAnim = atkAnim;
					if (e.target && this.isAttackRelevantAnim(atkAnim)) {
						this.emitEnemyAttack(e.uid, atkAnim);
					}
				}
			} catch (_) { /* an attack relay must never break the block */ }
		}
		this.main.connection.updateEntityStateBlock(this.mapName, out, this.hostInCombat());
	}

	/** Round 17 (issue 1): HOST side — one of our real enemies just started an attack
	 * (fresh anim edge at block cadence). Relay {uid, anim} to the instance so every
	 * member's puppet performs the same attack toward the local player (their puppets
	 * no longer run local AI). No-op when disconnected; the server relay no-ops when
	 * we're alone in the instance. */
	private emitEnemyAttack(uid: number, anim: string): void {
		try {
			const conn = this.main.connection;
			if (!conn || !conn.isOpen()) return;
			conn.enemyAttack({ uid, anim });
		} catch (_) { /* ignore */ }
	}

	/** Round 17 (issue 1): is `anim` an attack-relevant anim for a live host enemy?
	 * Attack anims are the enemy's own attack-action anims (e.g. "roll" for a hedgehog,
	 * "sting", "attack", "attackRev"...) — they are not the common idle/walk strings.
	 * The engaged gate (e.target) is applied by the caller, and the anim EDGE is the
	 * de-dupe, so an attack relays exactly once per anim change. Over-emitting for
	 * transitional anims (damage/jump) is harmless — the member just replays that anim
	 * too. */
	private isAttackRelevantAnim(a: string): boolean {
		if (!a) return false;
		if (a === 'idle' || a === 'walk' || a === 'run' || a === 'default') return false;
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
				continue;
			}
			if (dx !== 0) cp.xProtected = cp.xProtected + dx * t;
			if (dy !== 0) cp.yProtected = cp.yProtected + dy * t;
			if (dz !== 0) cp.zProtected = cp.zProtected + dz * t;
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
			const cpm: any = e.coll.pos;
			const dxm = e._mpToX - cpm.xProtected;
			const dym = e._mpToY - cpm.yProtected;
			const dzm = e._mpToZ - cpm.zProtected;
			if (dxm === 0 && dym === 0 && dzm === 0) continue;
			if (dxm !== 0) cpm.xProtected = cpm.xProtected + dxm * t;
			if (dym !== 0) cpm.yProtected = cpm.yProtected + dym * t;
			if (dzm !== 0) cpm.zProtected = cpm.zProtected + dzm * t;
		}
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
	}

	// ---- round 19: cutscene compatibility (fade/collision + csPuppets) ----

	/**
	 * ROUND 19 (Part 2): the single per-frame decision-maker for remote-mirror
	 * collision + cutscene fade (BOTH directions). Folds the shared-town IGNORE
	 * rule (formerly refreshTownCollision's write) into the cutscene-fade rule so
	 * the two can never fight:  target coll = (inTown || fade) ? IGNORE : base.
	 * Fade applies to animState.alpha (body + shadow via the sprite path) and the
	 * under-feet StatusBar's hook.localAlpha (the HP bar). Writes ONLY on change
	 * (cached per mirror) — mirrors may be mid-spawn (guarded), and a mirror
	 * spawned mid-fade self-heals on the next tick.
	 */
	public updateRemoteMirrorFade(): void {
		try {
			const inTown = isSharedTownNow();
			for (const name in this.main.players) {
				const pm = this.main.players[name];
				if (!pm) continue;
				const entry: any = pm as any;
				const e = entry.entity;
				if (!e || e._killed || !e.coll) continue;
				const fade = this.inCutscene || !!entry._mpCutscene;
				const targetAlpha = fade ? 0.25 : 1;
				// Capture the mirror's base coll type once (the same _mpBaseCollType
				// pattern refreshTownCollision used — it captures it there too, so this
				// just reads it back if already set).
				if (e._mpBaseCollType === undefined) e._mpBaseCollType = e.coll.type;
				const targetColl = (inTown || fade) ? (ig as any).COLLTYPE.IGNORE : e._mpBaseCollType;
				const cached = this._mpMirrorFadeCache.get(e);
				if (!cached || cached.alpha !== targetAlpha || cached.coll !== targetColl) {
					this._mpMirrorFadeCache.set(e, { alpha: targetAlpha, coll: targetColl });
					// Body + shadow fade via animState.alpha (default 1; sprite path).
					try { if (e.animState) e.animState.alpha = targetAlpha; } catch (_) { /* ignore */ }
					// HP bar fade via the StatusBar hook's localAlpha (base ~0.7);
					// capture once and restore exactly when the fade lifts.
					try {
						if (e.statusGui && e.statusGui.hook) {
							const h = e.statusGui.hook;
							if (e._mpBaseHpAlpha === undefined) {
								e._mpBaseHpAlpha = (typeof h.localAlpha === 'number') ? h.localAlpha : 1;
							}
							h.localAlpha = fade ? 0.25 : e._mpBaseHpAlpha;
						}
					} catch (_) { /* ignore */ }
					try { if (e.coll) e.coll.type = targetColl; } catch (_) { /* ignore */ }
				}
			}
		} catch (_) { /* never break the frame */ }
	}

	/** Round 19 (Part 2): drop cached per-mirror fade/collision state (map change /
	 * disconnect / cutscene end — the next per-frame pass re-evaluates from
	 * scratch, so freshly-spawned mirrors start correct). */
	public resetMirrorFadeCache(): void {
		try { this._mpMirrorFadeCache.clear(); } catch (_) { /* ignore */ }
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
			try { if (e.coll) e.coll.type = (ig as any).COLLTYPE.IGNORE; } catch (_) { /* ignore */ }
			try {
				if (e.params && !e.params._mpIsDefeatedPatched) {
					e.params._mpIsDefeatedPatched = true;
					e.params.isDefeated = function () { return false; };
				}
			} catch (_) { /* ignore */ }
		} catch (_) { /* never break a spawn */ }
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
		if (!this._mpDead) {
			if (p.params.currentHp <= 0 && !p._killed) this.enterDeath(p);
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
		this._mpDeathPos = p.coll ? { x: p.coll.pos.x, y: p.coll.pos.y, z: p.coll.pos.z } : null;
		this._mpDeathMap = (ig.game as any).mapName || '';
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
		try { if (p.coll) p.coll.type = (this._mpDeathCollType != null) ? this._mpDeathCollType : (ig as any).COLLTYPE.VIRTUAL; } catch (_) { /* ignore */ }
		this._mpDeathCollType = null;
		// Stand back up next to a live PARTY teammate when one is present (a live
		// party mirror is by definition on our map). keepPos = a teleport is about
		// to place us; don't fight it.
		const mirror = keepPos ? null : this.firstLiveMirror();
		if (mirror && mirror.coll && p.coll) {
			try {
				p.coll.pos.x = mirror.coll.pos.x + 24;
				p.coll.pos.y = mirror.coll.pos.y;
				p.coll.pos.z = mirror.coll.pos.z;
			} catch (_) { /* ignore */ }
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
		try { if (p.setCurrentAnim) p.setCurrentAnim('idle', true, null, true); } catch (_) { /* ignore */ }
		console.log('[multiplayer] respawned (soft revive)' + (mirror ? ' next to teammate' : (keepPos ? ' (teleport)' : '')));
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
		try {
			const onMap: any = (this.main as any).playersOnThisMap;
			if (onMap && !onMap[player] && Object.keys(onMap).length > 0) return;
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
			}
			// Party HUD still shows the 0 HP so the death is visible in the corner.
			const dm: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[player];
			if (dm && dm.params) dm.params.currentHp = 0;
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
				if (!hasTgt || dx * dx + dy * dy > 120 * 120 || dz > 32) {
					// Snap: the mirror is lockEntity-locked, so write through the same
					// protected backing fields copyEntityPosition uses.
					this.main.copyEntityPosition(s.pos, ent.coll.pos);
				}
				ent._mpToX = s.pos.x; ent._mpToY = s.pos.y; ent._mpToZ = s.pos.z;
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
				this.spawnAttackFxForAnim(ent, s.anim, s.em, s.cl);
				// Fix 3: unsynced FX replay keyed off the anim string — the guard dome
				// and dash dust (both null-safe no-ops when their sheets aren't resident).
				this.syncGuardFx(ent, s.anim);
				this.syncDashFx(ent, s.anim);
			}
			// Fix 3: element-mode switch burst — checked on every remote block, not just
			// anim changes (the owner swaps elements without changing their anim).
			if (ent._mpLastEm !== undefined && ent._mpLastEm !== s.em) this.syncModeChangeFx(ent, s.em);
			ent._mpLastEm = s.em;
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
			if (fresh) (fresh as any)._mpCutscene = !!s.cs;
		}
		// Party HUD model (top-left HP/SP bars read the MODEL, not the mirror).
		const model: any = (sc as any).party && (sc as any).party.models && (sc as any).party.models[player];
		if (model && model.params) {
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

	private applyEntityState(map: string, list: IEnemySnap[], cb: boolean): void {
		if (this.main.host) return;                 // host is the authority; ignore echoes
		if (map !== this.mapName) return;           // block for a map we already left
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
		const seenUid: { [uid: number]: boolean } = Object.create(null);
		const seenMapId: { [mapId: number]: boolean } = Object.create(null);
		// Build a mapId -> live map-enemy index ONCE per block (not per puppet) so
		// ensurePuppet's adoption lookup is O(1) instead of re-scanning all ~550 entities
		// for every unadopted enemy in the block (that was the member-side frame hitch).
		let mapEnemyIdx: { [mapId: number]: any } | null = null;
		for (const s of list) {
			if (!s || typeof s.i !== 'number') continue;
			seenUid[s.i] = true;
			if (s.mi) seenMapId[s.mi] = true;
			// Lazily build the index only when some puppet actually needs adopting.
			if (!this.puppets[s.i] && s.mi && !mapEnemyIdx) mapEnemyIdx = this.buildMapEnemyIndex();
			const e = this.ensurePuppet(s, mapEnemyIdx);
			if (!e || !e.coll) continue;
			// Store the block position as the INTERPOLATION TARGET — tick()'s per-frame
			// lerp moves the puppet toward it, turning 15Hz updates into smooth 60fps
			// motion. (Direct per-block writes were the visible stutter.)
			if (e._mpToX !== s.x || e._mpToY !== s.y || e._mpToZ !== s.z) {
				e._mpToX = s.x; e._mpToY = s.y; e._mpToZ = s.z;
				if (e._mpSnapNext) { // fresh adopt/respawn: skip the glide from wherever we were
					e._mpSnapNext = false;
					const cp0: any = e.coll.pos;
					cp0.xProtected = s.x; cp0.yProtected = s.y; cp0.zProtected = s.z;
				}
			}
			if (e.face && (e.face.xProtected !== s.fx || e.face.yProtected !== s.fy)) {
				e.face.xProtected = s.fx; e.face.yProtected = s.fy;
			}
			// Host-authoritative aggro: the host enemy engaged (has a target) -> our
			// puppet engages the local player; the host enemy went idle -> drop the
			// puppet's local aggro. RE-ASSERTED EVERY BLOCK (not only on change):
			// puppets run the FULL local AI between blocks, and that AI's target-lose
			// logic can drop the host-assigned target for a moment — which was the
			// member-side HP bar flickering back to blue and combat mode dropping out
			// until the next tg *change* re-synced it. Host authority wins every block.
			const tgNow = !!s.tg;
			e._mpTg = tgNow;
			const pl: any = ig.game.playerEntity;
			try {
				// Round 19 (Part 4): while the LOCAL player is in a cutscene, puppets
				// must NOT re-aggro us (we can't defend mid-story). We still drop any
				// existing player-target; we just never acquire/re-acquire it.
				if (tgNow && !this.inCutscene) { if (pl && !e.target && !e._killed) e.setTarget(pl); }
				else if (pl && e.target === pl) e.setTarget(null);
			} catch (_) { /* ignore */ }
			// Round 14 (fix 5): a _mpDying puppet is mid-death-FX — never re-issue a live
			// anim onto it from the host block (it's already pinned to the damage anim).
			if (s.a && !e._mpDying && this.lastAnim[s.i] !== s.a) {
				this.lastAnim[s.i] = s.a;
				e.currentAnim = { protected: s.a };
				this.playAnim(e, s.a);
			}
			if (e.params) {
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
		}
		// Reap pass. On a member every live non-mirror enemy must be host-owned; anything
		// else is a divergent local ghost and is killed silently (kill(true): no loot/FX):
		//  - adopted puppet (has _mpUid) whose uid left the block -> died on the host;
		//  - unadopted map enemy (real mapId) the host doesn't report -> the host already
		//    killed it before we arrived (or our quest state differs) -> remove it;
		//  - mapId-0 enemy (a stray EnemySpawner product that beat the spawner inject)
		//    -> never host-owned -> remove it.
		const Enemy = (ig.ENTITY as any).Enemy;
		const entities = ig.game.entities;
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
				if (!seenUid[uid]) {
					// Round 16 (issue 7): fence the reap kill exactly like the predicted-kill
					// path — remember the uid as a member kill so ensurePuppet's fast path
					// can't re-adopt a FRESH live puppet alongside this frozen corpse if the
					// host block toggles the enemy's presence within the linger window (the
					// duplicate-puppet bug). Runs before playPuppetDeath stages the death.
					if (uid) this.noteMemberKill(uid);
					// Fix 1 (member): clear the target lock before kill so Combatant.onKill's
					// setTarget(null) isn't swallowed (see the predicted-kill site) — the puppet
					// must leave activeCombatants and re-evaluate the member's combat mode.
					e._mpTg = false;
					// Round 14 (fix 5): FX-first death instead of the instant silent kill — the
					// death anim + blink + boom play even for reaped puppets (host already killed
					// the real enemy; nothing else would show it).
					this.playPuppetDeath(e, false);
					delete this.puppets[uid]; delete this.lastAnim[uid];
				}
			} else if (e.mapId) {
				if (!seenMapId[e.mapId]) { e._mpTg = false; this.playPuppetDeath(e, false); }
			} else {
				e._mpTg = false;
				this.playPuppetDeath(e, false); // mapId-0 ghost
			}
		}
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

		// Bind the host's uid onto this entity so future blocks find it in O(1) and the
		// cull pass recognises it as host-owned.
		e._mpUid = s.i;
		if (!e._mpPuppet) {
			e._mpPuppet = true;
			e._mpSnapNext = true; // first block after adoption snaps instead of gliding
			try { this.main.lockEntity(e, { x: s.x, y: s.y, z: s.z }); } catch (_) { /* ignore */ }
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
	 * visuals are synced separately via the EffectSheet hook (applySkillFx). */
	private spawnAttackFxForAnim(ent: any, anim: string, elementMode?: number, clazz?: string): void {
		try {
			const sweeps: any = (sc as any).COMBAT_SWEEPS;
			if (!sweeps) return;
			const em = (typeof elementMode === 'number' && elementMode >= 0 && elementMode <= 4) ? elementMode : 0;
			let entry: any = null;
			let reversed = false;
			if (anim === 'attack' || anim === 'attackRev') {
				entry = (clazz && sweeps[clazz]) || sweeps.SPHEROMANCER;
				reversed = anim === 'attackRev';
			} else if (anim === 'attackFinisher') {
				entry = (clazz && sweeps[clazz + '_FINISHER']) || sweeps.SPHEROMANCER_FINISHER;
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
