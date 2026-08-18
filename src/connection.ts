import { IBallInfo } from './ballInfo';

export interface IConnection {
    load(): Promise<void>;

    open(hostname: string, port: number, type?: string): Promise<void>;
    isOpen(): boolean;
    /** True once the underlying socket exists (post-open). Callbacks (onX) touch
     * the socket, so they must only be registered when this returns true. */
    isReady(): boolean;

    /** Round 16: latest smoothed round-trip latency to the server in
     * milliseconds (-1 when unknown / disconnected). Filled by the connector's
     * 1/s mpPing probe; read by the options tab's 显示ping值 tag display. */
    readonly pingMs: number;

    /** Round 21: current network debug stats for the options HUD overlay (bits per
     * second up/down, packet loss % over the last 10 probes, and all-time totals).
     * Round 22 (EXTRA 2): `tickRate` = the observed entityState block rate (blocks
     * per second — whichever direction is active: host sends, member receives).
     * ROUND 81: `tickRateHostile`/`tickRateBase` = the MEASURED per-stream rates
     * (engaged H stream vs idle B stream, via the block's relayed `st` tag) — the
     * HUD shows the real tick instead of configured option values. OPTIONAL so
     * connectors that don't measure it need no implementation; the HUD
     * overlay guards the call with `conn.getNetStats?.()`. */
    getNetStats?(): { upBitsSec: number; downBitsSec: number; lossPct: number; upBitsTotal: number; downBitsTotal: number; tickRate: number; tickRateHostile?: number; tickRateBase?: number };
    /** ROUND 75 (net diagnostics): per-event upload breakdown since the LAST call
     * (bytes / count / cumulative total / bytes-per-sec per event name, rate-sorted).
     * OPTIONAL like getNetStats; the __mpNet() console command guards the call. */
    getUploadEventStats?(): { event: string; bytes: number; count: number; total: number; bytesPerSec: number }[];
    /** ROUND 76 (advanced network tool): per-event DOWNLOAD breakdown, same
     * window/reset semantics as getUploadEventStats. OPTIONAL. */
    getDownloadEventStats?(): { event: string; bytes: number; count: number; total: number; bytesPerSec: number }[];

    /** Round 25: send one network-quality probe `{t, seq}`. The server echoes it
     * back verbatim as `netPong` (auth-gated, ~4/s); the connector folds the echo
     * into a sliding window for getNetQuality(). Called by the connector's own 1/s
     * probe loop — exposed for completeness. */
    netPing(t: number, seq: number): void;
    /** Round 25: register the `netPong` echo handler. `t` and `seq` arrive exactly
     * as sent (both validated server-side), so a pong maps unambiguously to its
     * probe. */
    onNetPong(callback: (t: number, seq: number) => void): void;
    /** Round 25: current network quality for the HUD badges — median RTT of the
     * answered probes in the sliding netPing window + packet loss % (unanswered
     * after ~2s counts lost) + a derived tier. OPTIONAL like getNetStats; the
     * badges guard with `conn.getNetQuality?.()`. */
    getNetQuality?(): INetQuality;

    identify(username: string, mirrorMode?: boolean): Promise<IIdentifyResult>;
    /** Round 19: `isolated` is the PVP-duel isolation tri-state forwarded to the
     * server (true = pin routing to solo:<user>:<map>; false = clear; absent =
     * leave the override unchanged). The connector ALSO makes it sticky: an
     * ordinary teleport/reassert while main.isolated re-sends isolated:true. */
    changeMap(name: string, marker: string | null, areaPath: string, areaType: number, isolated?: boolean): Promise<IChangeMapResult>;

    updatePersition(position: Vec3): void;
    updateAnimation(face: Vec2, anim: string): void;
    updateTimer(timer: number): void;

    // ---- NEW sync system (whole-state broadcast) ----
    /** Stream our own full player state (pos/face/anim/hp/sp) each frame.
     * `dead`=1 while our player is dead: teammates despawn our mirror until respawn. */
    updatePlayerState(state: { pos: Vec3, face: Vec2, anim: string, dead?: number, hp?: number, maxHp?: number, sp?: number, maxSp?: number, cg?: number, em?: number, cl?: string, cs?: number, xa?: string, xf?: string }): void;
    /** Solo-instance optimization: a ~1Hz minimal position beacon (a playerState
     * carrying only {pos}) that keeps the server's memberPos cache fresh while we
     * are the only member of our instance — for late-joiner spawn placement and
     * party regroup — without re-enabling the full sync stream. */
    updatePlayerPosition(pos: Vec3): void;
    /** Host-only: broadcast the whole enemy state block for the current map.
     * `combat` = host's combat mode, so members enter/see the shared fight.
     * `full` = this block was force-full (f:1 on the wire) — the ~1s heartbeat that
     * tells members the host reported its FULL roster (so a missing map enemy is dead
     * on the host). Omitted (falsy) for normal delta blocks. ROUND 81: `stream` tags
     * the block 'base' (idle enemies, fixed 15Hz) or 'hostile' (engaged enemies,
     * option-driven 30/60Hz) so receivers can measure the real per-stream tick. */
    updateEntityStateBlock(map: string, entities: any[], combat?: boolean, full?: boolean, stream?: 'base' | 'hostile'): void;
    /** Round 19: a client's cutscene-spawned monsters (story enemies). The server
     * relays this to the instance as `cutsceneEntity` with the sender stamped as
     * `from`; receivers render them as csPuppets and reap them when the stream stops. */
    updateCutsceneEntityBlock(state: { map: string, list: any[] }): void;
    /** ROUND 82 (door transition visuals): the local player walked into a mapped
     * door (Door.collideWith) — broadcast the door's identity/position so other
     * clients on the same map open their matching door and see the enter/exit
     * walk instead of a remote player passing through a closed door. */
    doorTransition(info: { map: string; x: number; y: number; z: number; dir: string; targetMap: string; marker: string }): void;
    /** ROUND 82: a remote player opened a door on our map — replay the open. */
    onDoorTransition(callback: (info: { map: string; x: number; y: number; z: number; dir: string; targetMap: string; marker: string }) => void): void;
    /** Round 62: host-only stream of live enemy projectiles (Ball/Stone, party ENEMY)
     * so members can see enemy ranged attacks (弹幕). The server relays it as
     * `projectileState` (host-only like entityState); receivers spawn visual-only
     * copies and reap absent uids. */
    updateProjectileState(map: string, list: any[]): void;

    spawnEntity(type: string, x: number, y: number, z: number, settings?: object, showAppearEffects?: boolean): void;
    registerEntity(id: number, type: string, pos: Vec3, settings: object): void;
    killEntity(id: number): void;

    throwBall(ballInfo: IBallInfo): void;
    /** Host -> all: an enemy hit a player's mirror; the named player's client should
     * apply the damage to their real player (mirrors' hp is owner-driven). ax/ay =
     * the attacking enemy's position (round 11, drives knockback direction).
     * attack = the attacker's attack stat (round 20, drives the owner's guard shield
     * damage reduction). ROUND 27 (item 4, host-authoritative monster damage):
     * `monster` marks a host-RECOMPUTED monster hit (recomputeHostMonsterHit) that
     * the member applies VERBATIM — `perfect` = a perfect guard (0 damage + counter
     * window), `regular` = a regular guard (chip damage + guard-bar), `knockback` =
     * whether the engine knockback fires. PvP hits (mirror-to-mirror) omit these. */
    combatHit(hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number, monster?: boolean, perfect?: boolean, regular?: boolean, knockback?: boolean, attackType?: number, shieldDmg?: number, full?: number }): void;
    /** Member -> host: I dealt damage to your real enemy (uid); apply it so HP is shared.
     * ROUND 32 (item 3c): type/ball/charged/knockback carry the REAL attack's
     * interrupt/knockback strength so the host rebuilds the genuine reaction (weak
     * uncharged ball vs strong melee / charged ball / knockback skill) instead of a
     * fixed MEDIUM. */
    enemyDamage(hit: { uid: number, damage: number, attacker: string, type?: number, ball?: boolean, charged?: boolean, knockback?: number, attackElement?: number, critical?: boolean, shield?: number, weak?: boolean, off?: number, def?: number }): void;
    /** ROUND 45 (Gap A, host origin): the HOST applied a member's forwarded hit to a real
     * enemy. The server self-drops enemyDamage back to that member, so any OTHER member
     * spectating heard nothing. The host relays a cosmetic-only notice (no damage) so
     * every other member replays the enemy's hurt sound/FX on its own puppet. */
    emitEnemyHurt(hit: { uid: number, type?: number, attackElement?: number, critical?: boolean, damage?: number, shield?: number, weak?: boolean, off?: number, def?: number }): void;
    /** Round 21: member -> host — a monster hit our real player LOCALLY (native damage
     * pipeline: guard/i-frames/knockback). Bookkeeping only: the member's HP already
     * streams via playerState, so the host must NOT re-apply any damage from this. */
    emitCombatResult(hit: { uid: number, damage: number, guarded: boolean }): void;
    /** Round 26: a counter/guard-break dramatic effect just played on a SHARED enemy
     * (a real host enemy or a member puppet — uid spaces match, puppets mirror host
     * enemy uids). Relay it to the instance so everyone else replays the head popup +
     * speedlines on the same entity; the server excludes the sender and rate-limits
     * ~20/s. kind = 'counter' | 'break'. */
    emitCombatFx(uid: number, kind: string): void;
    /** Round 17: HOST -> all — one of my real enemies started an attack (fresh attack
     * anim edge at block cadence). Members replay it on their puppet toward the local
     * player (member puppets no longer run local AI). Round 22 (RC1): `t` is the
     * username of the member the enemy is actually attacking (null for host-targeted /
     * bot / unknown) — only that member schedules the local hit. */
    enemyAttack(atk: { uid: number, anim: string, t: string | null }): void;
    /** Round 23: HOST -> all — a host real enemy just died and its death chain
     * granted credits to the HOST's player. Members grant the SAME credits to their
     * own players. Round 24 (loot fairness): the host no longer rolls item drops
     * with its own stats (they were wrong for members) — it relays the enemy's RAW
     * drop table (`drops`) + its `boosterState` instead, and every member rolls the
     * table with ITS OWN stats (identical distribution to the engine's
     * resolveItemDrops). uid = the dead enemy's uid; credit = the granted credits
     * (0 when none); boosterState = the enemy's booster state (number, default 0). */
    emitLoot(loot: { uid: number, credit: number, boosterState: number, drops: ILootDrop[] }): void;
    /** 1.71.7 (quest kill-progress sync): the map-instance HOST just completed a REAL
     * enemy death chain (`sc.combat.notifyCombatantDefeated` ran locally, so the
     * killer's own quest KILL progress is already native). The server routes this:
     *  - story-sync party  -> every other ONLINE party member, regardless of map
     *    (cross-map party relay like storySyncState);
     *  - any other mode    -> the sender's instance only, i.e. kills count only for
     *    players currently on the same map as the killed enemy.
     * `enemy` = the engine's `enemyName` (the quest KILL subtask key); `map` = the
     * map the enemy died on (receivers compare it against their own map as a second
     * fence in non-sync mode). */
    questKill(kill: { enemy: string, map: string }): void;
    /** Round 33 (item 2b): HOST -> all — one of the host's real enemies played a sound
     * (any action step). Member puppets run NO local AI, so without this relay they are
     * completely silent. The host relays the sound's path + playback params; each member
     * replays it locally positioned on their same-uid puppet. `global` = a non-positional
     * sound; `radius` = the 3D falloff radius. Server relays via broadcastHostState. */
    emitEnemySound(s: { uid: number, path: string, volume?: number, variance?: number, loop?: boolean, global?: boolean, radius?: number, speed?: number }): void;
    /** ROUND 34 (item 3): any client -> its instance — the LOCAL player's own attack
     * sound (melee swing / ball throw) fired on an Effect entity. The enemySound relay is
     * host-only + Enemy-gated, so it never carries player attack sounds; this fills the
     * gap. Every OTHER same-instance client replays it positioned on the attacker's mirror. */
    emitPlayerSound(s: { path: string, volume?: number, variance?: number, loop?: boolean, radius?: number, speed?: number }): void;
    /** ROUND 43 (skill-release sound): any client -> its instance — the local player FIRED
     * a skill whose launch sound we silenced locally (the playAtEntity enemy/ball observer
     * kills skill-projectile sounds and, before this round, sent nothing). `player` = the
     * caster's name; every other client replays it positioned on the caster's mirror. This
     * fills the 回旋斩 / charged-shot gap the playerSound path couldn't reach. */
    emitSkillSound(s: { player: string, path: string, volume?: number, variance?: number, radius?: number, speed?: number }): void;
    /** ROUND 39 (item 1): any client -> its instance — the local player RELEASED a
     * sustained (loop:true) sound (the skill charge-up). Every other same-instance client
     * cuts the looped handle it started for that player (applySoundStop). */
    emitSoundStop(): void;
    /** ROUND 74 (plant destruct sync): any client -> its instance — the local player just
     * destroyed a map destructible (plant/bush/stone, ig.ENTITY.ItemDestruct). `map` = the
     * map it belonged to, `mapId` = the entity's stable mapId — identical map data on every
     * client, so it unambiguously identifies the same plant for everyone. The server relays
     * it to the other same-instance members (sender excluded). */
    plantBreak(data: { map: string, mapId: number }): void;
    /** 1.71.0 (dungeon puzzles): any client -> its instance — compact state of
     * dungeon puzzle entities (boxes/platforms/switches/ice pillars) that changed
     * locally. The server relays it to the other same-instance members.
     * 1.71.2: `own`/`ot` carry push/pull box grip ownership, `pl`/`dl` carry the
     * PushPullDest plate state. */
    puzzleState(map: string, entries: Array<{ mi: number, p?: [number, number, number], on?: number, hits?: number, st?: number, anim?: string, ph?: number, act?: number, mv?: number, hd?: number, gone?: number, own?: string, ot?: number, pl?: number, dl?: number }>): void;
    /** 1.71.0: a same-instance client relayed dungeon puzzle state — apply it to
     * our matching local entities by mapId. */
    onPuzzleState(callback: (data: { map: string, entries: Array<any> }) => void): void;

    updateEntityPosition(id: number, pos: Vec3): void;
    updateEntityAnimation(id: number, face: Vec2, anim: string): void;
    updateEntityHealth(id: number | null, health: number, maxHp?: number): void;
    updateEntityState(id: number, state: string): void;
    updateEntityTarget(id: number, target: string | number | null): void;
    // Real player profile (level/stats/equip) shown in the Social info box.
    updatePlayerProfile(profile: IPlayerProfile): void;
    // Frequent live combat stats (currentHp/currentSp) for the in-game party HUD.
    updatePlayerStats(stats: { hp?: number, maxHp?: number, sp?: number, maxSp?: number }): void;

    // ---- social (lobby architecture) ----
    friendAdd(name: string): void;
    friendAccept(name: string): void;
    friendDecline(name: string): void;
    friendRemove(name: string): void;
    /** Round 23 wave 3: search known players by name (search-first add-friend flow).
     * The server replies to the requester only with `searchPlayersResult`. */
    searchPlayers(query: string): void;
    /** Round 23 wave 3: withdraw an outgoing friend request (requester-side decline). */
    friendRequestWithdraw(name: string): void;
    friendList(): void;
    friendRequests(): void;
    partyInvite(name: string): void;
    partyAccept(partyId: string): void;
    partyDecline(partyId: string): void;
    partyLeave(): void;
    /** Leader-only: remove `target` from the party. The kicked player receives
     * partyUpdate null; the server validates leader status. */
    partyKick(target: string): void;
    /** Ask the server for a teammate's location (manual regroup). `target` = the
     * clicked teammate's username; without it the leader is used. */
    partyRegroup(target?: string): void;
    // ---- 1.70.61 剧情同步模式 (story sync mode) ----
    /** Leader-only: ask the server to run the party-wide eligibility handshake for
     * a quest (all online members must be active or solved, leader active). */
    storySyncRequest(quest: string): void;
    /** Reply to the server's `storySyncCheck` for the party-wide start handshake. */
    storySyncCheckResult(reqId: string, quest: string, available: boolean, active: boolean, solved: boolean): void;
    /** Reply to the server's `storySyncJoinCheck` — joining a party whose story
     * sync is already active requires the same quest to be accepted or solved. */
    storySyncJoinCheckResult(reqId: string, quest: string, available: boolean, active: boolean, solved: boolean): void;
    /** Leader -> everyone: this client's authoritative quest progress (locks all
     * members onto the same task state). */
    storySyncState(quest: string, state: any, map?: string): void;
    /** Leader -> everyone: the story event just started on the leader (members
     * replay the same local engine event; key = entity mapId string). */
    storySyncEvent(quest: string, map: string, key: string, kind: 'trigger' | 'location' | 'npc', type: number): void;
    /** Any member clicked a story NPC — ask the whole party to raise the NPC
     * gather banner (the event itself starts later via storySyncEvent). */
    storySyncNpcRequest(quest: string, map: string, key: string): void;
    /** Leader-only: the authoritative engine event finished — invalidate any
     * open skip vote so nobody's no-timeout vote modal strands forever. */
    storySyncEventEnd(seq: number): void;
    /** Leader-only: end the mode for the whole party; members restore their own
     * quest state. */
    storySyncCancel(quest: string): void;
    /** Leader-only: the locked quest reached its final node — hand the final state
     * out so unfinished members commit the completion and claim the reward once. */
    storySyncComplete(quest: string, state: any): void;
    /** Ask the party to vote on skipping the current synced animation. */
    storySyncSkipVote(seq: number): void;
    /** Vote yes/no on someone's skip request. */
    storySyncSkipAnswer(seq: number, yes: boolean): void;
    /** Urge specific absent teammates to come to the waiting story trigger. */
    storySyncNudge(quest: string, to: string[]): void;
    /** Any member -> party: advance the CURRENT synced story dialogue on every
     * client (each side runs its own local message model). */
    storySyncDialogNext(): void;
    /** ROUND 93 (chat channels): send a chat message. `channel` is 'world'
     * (global), 'party' (team) or 'private' (direct message to `target`). The
     * server relays it and never echoes to the sender. */
    chat(text: string, channel: 'world' | 'party' | 'private', target?: string): void;
    /** ROUND 93 (chat channels): an incoming chat message. `channel` tells the
     * UI which tab it belongs to ('world' / 'party' / 'private'). */
    onChat(cb: (msg: { from: string, text: string, channel?: string, target?: string }) => void): void;
    /** ROUND 93: the server rejected an outgoing chat message. Reasons: 'rate',
     * 'notInParty', 'invalidTarget', 'offline'. `target` names the private-chat
     * recipient when relevant. */
    onChatError(cb: (err: { reason?: string, channel?: string, target?: string }) => void): void;
    /** Host -> all: the native party BOTS currently in the roster (round 11).
     * Members spawn local follower copies so they can SEE the host's bots.
     * Round 27 (item 2): `maps` carries the HOST's map for each BOT so the party
     * HUD can hide a bot's HP/SP/EXP bars + grey its net diamond while the bot
     * (its owner) is off our map. Optional — older hosts/servers omit it. */
    partyBots(bots: string[], maps?: { [botName: string]: string }): void;
    /** Round 13: the party LEADER streams live bot state (pos/anim/hp/level) so
     * members can render the leader's follower bots as host-driven puppets. */
    botState(state: { map: string, bots: IBotStateEntry[] }): void;
    /** Round 20: GHOST CHESTS — tell the party which chests on the current map WE
     * have opened (map name + the globally-unique chest mapId). The server adds us
     * to the party's opened-chest set per key and relays `chestOpenedBy` to the
     * instance. Connector gates it on party size > 1 (solo spam guard). */
    emitChestOpened(list: Array<{ map: string, id: number }>): void;
    /** Round 20: a party teammate opened a chest (server-relayed). `chestKey` =
     * "<mapName>:<mapId>", `by` = their username. Feeds the ghost-chest state. */
    onChestOpenedBy(cb: (chestKey: string, by: string) => void): void;
    /** Round 20: the party's opened-chest snapshot for a map we just joined
     * (`chestState`, filtered to the joined map's prefix to keep payloads small). */
    onChestState(cb: (opened: { [chestKey: string]: string[] }) => void): void;
    /** Round 11: a player CAST a special skill — replay its effect sheet on the
     * sender's mirror (f = fixed world pos for spawnFixed effects). */
    skillFx(fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }): void;
    /** Round 27 (item 2): publish OUR current map to the party so teammates' HUDs
     * can hide our HP/SP/EXP bars + grey our net diamond while we're off their map. */
    memberMap?(map: string): void;
    /** Round 27 (item 2): a party member relayed their current map. */
    onMemberMap?(cb: (name: string, map: string) => void): void;
    saveUpload(slot: string, data: string): void;
    /** Round 23: one part of a chunked, rate-limited save UPLOAD. The client splits
     * the save into 8192-char parts and paces them (~512 kb/s) through the
     * saveUploadQueue; the server reassembles them in order and confirms with
     * saveSaved once the last part lands. `gen` is bumped on every submit so a
     * stale (aborted) stream is discarded server-side. */
    saveChunk(chunk: { gen: number, slot: string, total: number, seq: number, part: string, reason: string }): void;
    /** Round 23: the server confirmed a save upload finished persisting (the client
     * shows the save-succeeded toast). `bytes` = the reassembled payload length. */
    onSaveSaved(callback: (slot: string, bytes: number) => void): void;
    /** 1.71.0: ask the server to stream one of the five save mirrors (newest first,
     * -1 = fall back to the current latest save). */
    saveMirrorRestore(index: number): void;
    /** 1.71.0: the server accepted/rejected a saveMirrorRestore request. */
    onSaveMirrorRestoreResult(callback: (result: { ok: boolean, reason?: string, index?: number }) => void): void;
    /** Round 27 (item 5): the server rejected/dropped a save upload (rate-limited,
     * corrupt stream, or area-change storm suppression). The exit-to-title upload
     * dialog resolves FAILURE on this so the player exits instead of waiting for the
     * full timeout. */
    onSaveFailed?(callback: (slot: string, reason: string) => void): void;
    /** Round 23: the server STREAMS the player's save as paced saveDownload parts
     * right after the handshake (it is no longer embedded in handshakeResponse).
     * The connector reassembles the parts and fires this callback ONCE — with the
     * full save string when the stream completes, or null when the server signals
     * "no save" (saveDownload {slot, total:0}). */
    onSaveDownload(callback: (result: { slot: string, data: string } | null) => void): void;
    /** Round 24: the connector reports EVERY valid save-download part it appends
     * while reassembling (before the stream completes), so the multiplayer layer can
     * run an ACTIVITY-based restore watchdog — "give up only after 15s with NO new
     * parts arriving" — instead of a flat timer from game start (a large-but-valid
     * save that streams slower than the old window used to be abandoned mid-stream).
     * Round 27: the callback also carries download progress — `received`/`total` =
     * parts received / total parts, `bytes` = chars reassembled so far (≈ bytes for
     * the ASCII-encrypted save string) — so the blocking download overlay can render
     * a real progress bar. */
    onSaveDownloadProgress(callback: (progress: { received: number, total: number, bytes: number }) => void): void;
    /** Round 27: true once the save-download stream has completed (or the server
     * signaled "no save" via total:0). Lets launchGame skip its blocking overlay
     * entirely when the download already settled during login. OPTIONAL so a
     * connector without the streamed download needs no implementation. */
    readonly saveDownloadSettled?: boolean;
    logout(): void;
    // ---- lobby queries ----
    roomPlayers(): void;
    onlineCount(): void;

    onSetHost(callback:
        (isHost: boolean, map?: string) => void): void;

    onPlayerChangeMap(callback:
        (player: string, enters: boolean, position: Vec3, map: string, marker: string | null) => void): void;
    onUpdatePostion(callback:
        (player: string, pos: Vec3) => void): void;
    onUpdateAnimation(callback:
        (player: string, face: Vec2, anim: string) => void): void;
    onUpdateAnimationTimer(callback:
        (player: string, timer: number) => void): void;

    onThrowBall(callback:
        (ballInfo: IBallInfo) => void): void;
    onCombatHit(callback:
        (hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number, monster?: boolean, perfect?: boolean, regular?: boolean, knockback?: boolean, attackType?: number }) => void): void;
    onEnemyDamage(callback:
        (hit: { uid: number, damage: number, attacker: string, attackElement?: number, critical?: boolean, type?: number, shield?: number, weak?: boolean, off?: number, def?: number }) => void): void;
    /** ROUND 45 (Gap A, host origin): the host relayed that a member's hit landed on a
     * real enemy — replay the hurt FX on our same-uid puppet (cosmetic only, no damage). */
    onEnemyHurt(callback: (hit: { uid: number, type?: number, attackElement?: number, critical?: boolean, damage?: number, shield?: number, weak?: boolean, off?: number, def?: number }) => void): void;
    /** Round 17: the host's real enemy started an attack — replay it on our puppet
     * (uid) toward the local player with the given attack anim. Round 22 (RC1): `t`
     * is the targeted member's username (null when the host/bot/unknown was targeted). */
    onEnemyAttack(callback: (uid: number, anim: string, t: string | null) => void): void;
    /** Round 21: a member reported a monster hit it detected locally (native damage
     * pipeline). Bookkeeping for the host; see emitCombatResult. */
    onCombatResult(callback: (hit: { uid: number, damage: number, guarded: boolean }) => void): void;
    /** Round 26: a shared enemy (uid) had a counter/guard-break FX elsewhere (server-
     * relayed, sender excluded). Replay it locally on the same-uid entity. kind =
     * 'counter' | 'break'. */
    onCombatFx(callback: (uid: number, kind: string) => void): void;
    /** Round 23: the host killed a real enemy — grant the relayed credits to our own
     * player and roll the RAW drop table with OUR stats (applyLoot). Server-relayed
     * via broadcastHostState. */
    onLoot(callback: (loot: { uid: number, credit: number, boosterState: number, drops: ILootDrop[] }) => void): void;
    /** 1.71.7: a same-instance player (non-sync mode) or any story-sync party member
     * relayed a real enemy defeat for quest KILL progress. Server-stamped/validated;
     * `map` is the map the enemy died on. */
    onQuestKill(callback: (kill: { enemy: string, map: string }) => void): void;
    /** Round 33 (item 2b): the host relayed an enemy sound (see emitEnemySound). Replay
     * it locally positioned on the same-uid puppet (or globally when `global`). */
    onEnemySound(callback: (s: { uid: number, path: string, volume?: number, variance?: number, loop?: boolean, global?: boolean, radius?: number, speed?: number }) => void): void;
    /** ROUND 34 (item 3): a same-instance player's attack sound (see emitPlayerSound).
     * Replay it locally positioned on that player's mirror. */
    onPlayerSound(callback: (s: { player: string, path: string, volume?: number, variance?: number, loop?: boolean, radius?: number, speed?: number }) => void): void;
    /** ROUND 43 (skill-release sound): a same-instance player fired a skill's launch
     * sound — replay it on that player's mirror (see NetSync.applySkillSound). */
    onSkillSound(callback: (s: { player: string, path: string, volume?: number, variance?: number, radius?: number, speed?: number }) => void): void;
    /** ROUND 39 (item 1): a same-instance player released a sustained sound (see
     * emitSoundStop) — cut the looped handle we started for them. */
    onSoundStop(callback: (player: string) => void): void;
    /** ROUND 95: the local player used a consumable — tell the instance so every
     * other player can show the item icon above our head (itemUse indicator). */
    itemUse(item: string | number): void;
    /** ROUND 95: a same-instance player used an item (server-relayed, sender
     * excluded). Show the item icon above that player's head. */
    onItemUse(callback: (player: string, item: string | number) => void): void;
    /** ROUND 99: the local player healed — relay the amount so other players can
     * spawn the same green +N jump-number above our mirror. */
    playerHeal(amount: number): void;
    /** ROUND 99: a same-instance player healed — show the green +N jump-number. */
    onPlayerHeal(callback: (player: string, amount: number) => void): void;
    /** ROUND 74 (plant destruct sync): a same-instance player destroyed a plant (see
     * plantBreak) — destroy OUR copy at the same mapId if it is still intact (vanilla
     * chain: dropped anim + FX + our own drop rolls + propsDestroyed count + respawn
     * var). Idempotent: an already-dropped/absent plant is a no-op. */
    onPlantBreak(callback: (data: { map: string, mapId: number }) => void): void;

    onRegisterEntity(callback:
        (id: number, type: string, pos: Vec3, settings: object) => void): void;
    onKillEntity(callback:
        (id: number) => void): void;
    onUpdateEntityPosition(callback:
        (id: number, pos: Vec3) => void): void;
    onUpdateEntityAnimation(callback:
        (id: number, face: Vec2, anim: string) => void): void;
    onUpdateEntityState(callback:
        (id: number, state: string) => void): void;
    onUpdateEntityTarget(callback:
        (id: number, target: string | number | null) => void): void;
    onUpdateEntityHealth(callback:
        (id: number | string, health: number, maxHp?: number) => void): void;
    onPlayerProfile(callback:
        (player: string, profile: IPlayerProfile) => void): void;
    onPlayerStats(callback:
        (player: string, stats: { hp?: number, maxHp?: number, sp?: number, maxSp?: number }) => void): void;
    /** Round 17: a player in our instance reported its own RTT (ms, ~1/s cadence,
     * server-relayed). Shown on name tags when 显示ping值 is on. Round 20: the relay
     * also carries `isHost` (true when that player is the map-instance host). */
    onPlayerPing(callback: (name: string, ping: number, isHost?: boolean) => void): void;
    // ---- NEW sync system callbacks ----
    onPlayerState(callback: (player: string, state: any) => void): void;
    onEntityState(callback: (map: string, entities: any[], combat: boolean, full: boolean, stream?: 'base' | 'hostile') => void): void;
    /** Round 19: a client's cutscene-spawned monsters arrived. `from` = the stream
     * owner's username (server-stamped); receivers ignore their own echo and reap
     * the owner's csPuppets when its stream stops. */
    onCutsceneEntity(callback: (from: string, data: { map: string, list: any[] }) => void): void;
    /** Round 62: the host's enemy-projectile stream arrived (host-only). `list` = the
     * projectile snaps (uid/kind/source/proxy-name/pos/vel); receivers spawn/update
     * visual-only copies and reap absent uids. */
    onProjectileState(callback: (map: string, list: any[]) => void): void;

    // ---- social callbacks ----
    onPresence(callback: (player: string, online: boolean) => void): void;
    /** Round 23 wave 3: `lastLeft` (optional, additive) rides the roster broadcast —
     * `{name, reason}` with reason 'left'|'kicked'|'disconnected' — so a departed
     * member's removal can be toasted with the correct manner. Absent -> 'left'. */
    onPartyUpdate(callback: (party: { partyId: string, leader: string, members: string[], lastLeft?: { name: string, reason: string } } | null) => void): void;
    /** ROUND 95: a party member departed via a DISBAND path (2-person party), which
     * partyUpdate null alone cannot express. `{name, reason}` matches lastLeft
     * ('left' | 'kicked' | 'disconnected'); toast it like a normal roster change. */
    onPartyMemberLeft(callback: (info: { name: string, reason?: string }) => void): void;
    /** ROUND 96: the SERVER tells US about our own party transition — join / leave /
     * kicked. The roster-diff toast path only announces OTHER members. */
    onPartySelfEvent(callback: (event: 'join' | 'leave' | 'kicked') => void): void;
    onPartyInvite(callback: (from: string, partyId: string) => void): void;
    onPartyMove(callback: (data: { leader?: string, map?: string, pos?: Vec3 }) => void): void;
    // Server nudge to re-assert our current instance (e.g. after someone joined
    // our party) so both ends spawn each other's mirror entity.
    onPartyReSync(callback: () => void): void;
    /** Host -> all: native party bots in the roster (round 11). Round 27 (item 2):
     * `maps` carries the host's map per bot for the off-map HUD hide/grey. */
    onPartyBots(callback: (bots: string[], maps?: { [botName: string]: string }) => void): void;
    /** Round 13: leader-streamed live bot state. `from` is the leader's username
     * (the sender never receives its own block, but the check is belt-and-braces). */
    onBotState(callback: (data: { map?: string, from?: string, bots: IBotStateEntry[] }) => void): void;
    /** Round 11: replay a remote player's skill effect on their mirror. */
    onSkillFx(callback: (player: string, fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }) => void): void;
    onFriendList(callback: (friends: Array<{ name: string, online: boolean }>) => void): void;
    onFriendActionResult(callback: (result: any) => void): void;
    onFriendRequest(callback: (from: string) => void): void;
    /** Round 23 wave 3: the requests payload now carries BOTH directions
     * ({incoming, outgoing}) so the 申请管理 tab can render each section. */
    onFriendRequests(callback: (requests: {
        incoming: Array<{ name: string, online: boolean }>,
        outgoing: Array<{ name: string, online: boolean }>,
    }) => void): void;
    /** Round 23 wave 3: search-first add-friend flow — server replies to the
     * requester only, capped at 8 matches, exact first. level may be absent
     * (not persisted; omitted when the target has never uploaded a profile). */
    onSearchPlayersResult(callback: (result: { query: string, players: Array<{ name: string, online: boolean, level?: number }> }) => void): void;
    /** Round 23 wave 3: friendship established (accept OR mutual auto-accept) —
     * `name` is the OTHER user. */
    onFriendAdded(callback: (name: string) => void): void;
    /** Round 23 wave 3: an outgoing request I sent was withdrawn by the other side. */
    onFriendRequestWithdrawn(callback: (name: string) => void): void;
    /** Round 23 wave 3: my outgoing request was declined by the target. */
    onFriendRequestDeclined(callback: (name: string) => void): void;
    /** Round 23 wave 3: party action outcomes (invite accepted/declined/busy/full) —
     * consumed for the invite busy-check + button re-enable. */
    onPartyActionResult(callback: (result: any) => void): void;
    // ---- 1.70.61 story-sync callbacks ----
    /** Server asks US whether `quest` is accepted/solved (party-wide handshake). */
    onStorySyncCheck(cb: (reqId: string, quest: string) => void): void;
    /** Server asks US whether `quest` is accepted/solved before it lets the accept
     * into a story-syncing party through. */
    onStorySyncJoinCheck(cb: (reqId: string, quest: string) => void): void;
    /** The mode envelope: quest + leader + the exact members that started it. */
    onStorySyncStart(cb: (data: { quest: string, leader: string, members: string[] }) => void): void;
    /** The start handshake failed — `reason` is one of 'notLeader','busy',
     * 'offline','timeout','partyGone','partyChanged','membersNotReady',
     * 'leaderNotActive','mismatch'. */
    onStorySyncStartFailed(cb: (data: { reqId: string, quest: string, reason: string, names: string[] }) => void): void;
    /** Leader's quest state (server-stamped sender for the echo check). */
    onStorySyncState(cb: (data: { from: string, quest: string, state: any, map?: string }) => void): void;
    /** Leader started a story event — members replay it locally. */
    onStorySyncEvent(cb: (data: { from: string, quest: string, map: string, key: string, kind: 'trigger' | 'location' | 'npc', type: number, seq: number }) => void): void;
    /** A teammate clicked a story NPC — raise the gather banner on our side. */
    onStorySyncNpcRequest(cb: (data: { from: string, quest: string, map: string, key: string }) => void): void;
    /** The mode ended. reason = 'complete' | 'cancel' | 'leave' | 'leaderLeft' |
     * 'partyEnd'. 'complete' carries the final `state`. */
    onStorySyncEnd(cb: (data: { quest: string, reason: string, state?: any, by?: string, leader?: string }) => void): void;
    /** Someone asked to skip the current synced animation (everyone votes).
     * `answers` = authoritative map of YES votes so far (requester included). */
    onStorySyncSkipVote(cb: (data: { seq: number, from: string, answers?: { [name: string]: boolean } }) => void): void;
    /** A YES arrived for the open skip vote — `answers` is the full YES map. */
    onStorySyncSkipVoteUpdate(cb: (data: { seq: number, answers?: { [name: string]: boolean } }) => void): void;
    /** Unanimous yes -> everyone fast-forwards locally; any no/abort -> cancel. */
    onStorySyncSkipResult(cb: (data: { seq: number, pass: boolean, reason?: string, from?: string }) => void): void;
    /** A teammate at the trigger urged us to come. */
    onStorySyncNudge(cb: (data: { from: string, quest: string, to: string[] }) => void): void;
    /** A teammate advanced the synced story dialogue — advance ours too. */
    onStorySyncDialogNext(cb: (data: { from: string, quest: string }) => void): void;
    /** Server asks the leader to re-broadcast the current quest state (a fresh
     * member just joined mid-sync). */
    onStorySyncResend(cb: (data: { quest: string }) => void): void;
    // ---- lobby query callbacks ----
    onRoomPlayers(callback: (players: string[], host?: string) => void): void;
    onOnlineCount(callback: (count: number) => void): void;
}

/** Round 25: network-quality tier for the HUD badges (green..red). */
export type NetTier = 'green' | 'yellow' | 'orange' | 'red';

/** Round 25: current network quality, read by the HUD badges. `ping` = median RTT
 * of the answered probes in the sliding window (-1 when none resolved yet),
 * `lossPct` = unanswered / resolved probes (0..100), `tier` = the derived color
 * tier (green good ... red terrible), `known` = false until at least one probe has
 * resolved — badges hide until then. */
export interface INetQuality {
    ping: number;
    lossPct: number;
    tier: NetTier;
    known: boolean;
}

export interface IChangeMapResult {
    instanceId: string;
    isHost: boolean;
    members: Array<{ name: string, pos?: Vec3, map?: string }>;
    /** Round 20: the username of the NEW instance's block host (changeMapResponse.host). */
    host?: string;
}

/** A remote player's real profile, shown in the Social menu info box. All fields
 * optional — we only display what the sender actually provided. */
export interface IPlayerProfile {
    level?: number;
    /** Current EXP within the level (drives the Social info box's EXP bar). */
    exp?: number;
    hp?: number;
    attack?: number;
    defense?: number;
    focus?: number;
    /** Live combat values so the remote party HUD's HP/SP bars stay fresh. */
    currentHp?: number;
    currentSp?: number;
    maxSp?: number;
    /** ROUND 91: the four non-neutral element factors (HEAT/COLD/SHOCK/WAVE) shown
     * in the SHIFT quick-menu inspect box exactly like an enemy's resistances. */
    elemFactor?: number[];
    equip?: { head?: number, leftArm?: number, rightArm?: number, torso?: number, feet?: number };
}

/** A single party-bot snapshot streamed by the party leader (round 13). */
export interface IBotStateEntry {
    n: string;
    x: number; y: number; z: number;
    fx: number; fy: number;
    a: string;
    hp: number; mh: number;
    lv: number; ex: number;
}

/** Round 24 (loot fairness): one RAW entry of an enemy's drop table, relayed from
 * the host's death chain. Members roll the table with THEIR OWN stats — the host
 * no longer resolves items (its stats don't match the member's odds). Mirrors the
 * fields the engine's EnemyType.resolveItemDrops reads: item (item id, string),
 * prob (drop probability 0..1), min/max (amount range), rank (combat-rank gate,
 * '' when none), boosted (only drops when the enemy was BOOSTED). */
export interface ILootDrop {
    item: string;
    prob: number;
    min: number;
    max: number;
    rank: string;
    boosted: boolean;
}
