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

    identify(username: string): Promise<IIdentifyResult>;
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
    updatePlayerState(state: { pos: Vec3, face: Vec2, anim: string, dead?: number, hp?: number, maxHp?: number, sp?: number, maxSp?: number, cg?: number, em?: number, cl?: string, cs?: number }): void;
    /** Host-only: broadcast the whole enemy state block for the current map.
     * `combat` = host's combat mode, so members enter/see the shared fight. */
    updateEntityStateBlock(map: string, entities: any[], combat?: boolean): void;
    /** Round 19: a client's cutscene-spawned monsters (story enemies). The server
     * relays this to the instance as `cutsceneEntity` with the sender stamped as
     * `from`; receivers render them as csPuppets and reap them when the stream stops. */
    updateCutsceneEntityBlock(state: { map: string, list: any[] }): void;

    spawnEntity(type: string, x: number, y: number, z: number, settings?: object, showAppearEffects?: boolean): void;
    registerEntity(id: number, type: string, pos: Vec3, settings: object): void;
    killEntity(id: number): void;

    throwBall(ballInfo: IBallInfo): void;
    /** Host -> all: an enemy hit a player's mirror; the named player's client should
     * apply the damage to their real player (mirrors' hp is owner-driven). ax/ay =
     * the attacking enemy's position (round 11, drives knockback direction).
     * attack = the attacker's attack stat (round 20, drives the owner's guard shield
     * damage reduction). */
    combatHit(hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number }): void;
    /** Member -> host: I dealt damage to your real enemy (uid); apply it so HP is shared. */
    enemyDamage(hit: { uid: number, damage: number, attacker: string }): void;
    /** Round 17: HOST -> all — one of my real enemies started an attack (fresh attack
     * anim edge at block cadence). Members replay it on their puppet toward the local
     * player (member puppets no longer run local AI). */
    enemyAttack(atk: { uid: number, anim: string }): void;

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
    /** Host -> all: the native party BOTS currently in the roster (round 11).
     * Members spawn local follower copies so they can SEE the host's bots. */
    partyBots(bots: string[]): void;
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
    saveUpload(slot: string, data: string): void;
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
        (hit: { player: string, damage: number, element?: number, critical?: boolean, ax?: number, ay?: number, attack?: number }) => void): void;
    onEnemyDamage(callback:
        (hit: { uid: number, damage: number, attacker: string }) => void): void;
    /** Round 17: the host's real enemy started an attack — replay it on our puppet
     * (uid) toward the local player with the given attack anim. */
    onEnemyAttack(callback: (uid: number, anim: string) => void): void;

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
    onEntityState(callback: (map: string, entities: any[], combat: boolean) => void): void;
    /** Round 19: a client's cutscene-spawned monsters arrived. `from` = the stream
     * owner's username (server-stamped); receivers ignore their own echo and reap
     * the owner's csPuppets when its stream stops. */
    onCutsceneEntity(callback: (from: string, data: { map: string, list: any[] }) => void): void;

    // ---- social callbacks ----
    onPresence(callback: (player: string, online: boolean) => void): void;
    onPartyUpdate(callback: (party: { partyId: string, leader: string, members: string[] } | null) => void): void;
    onPartyInvite(callback: (from: string, partyId: string) => void): void;
    onPartyMove(callback: (data: { leader?: string, map?: string, pos?: Vec3 }) => void): void;
    // Server nudge to re-assert our current instance (e.g. after someone joined
    // our party) so both ends spawn each other's mirror entity.
    onPartyReSync(callback: () => void): void;
    /** Host -> all: native party bots in the roster (round 11). */
    onPartyBots(callback: (bots: string[]) => void): void;
    /** Round 13: leader-streamed live bot state. `from` is the leader's username
     * (the sender never receives its own block, but the check is belt-and-braces). */
    onBotState(callback: (data: { map?: string, from?: string, bots: IBotStateEntry[] }) => void): void;
    /** Round 11: replay a remote player's skill effect on their mirror. */
    onSkillFx(callback: (player: string, fx: { sheet: string, key: string, f?: { x: number, y: number, z: number } | null, p?: any }) => void): void;
    onFriendList(callback: (friends: Array<{ name: string, online: boolean }>) => void): void;
    onFriendActionResult(callback: (result: any) => void): void;
    onFriendRequest(callback: (from: string) => void): void;
    onFriendRequests(callback: (requests: Array<{ name: string, online: boolean }>) => void): void;
    // ---- lobby query callbacks ----
    onRoomPlayers(callback: (players: string[], host?: string) => void): void;
    onOnlineCount(callback: (count: number) => void): void;
}

export interface IChangeMapResult {
    instanceId: string;
    isHost: boolean;
    members: Array<{ name: string, pos?: Vec3 }>;
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