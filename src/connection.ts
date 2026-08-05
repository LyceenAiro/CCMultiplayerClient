import { IBallInfo } from './ballInfo';

export interface IConnection {
    load(): Promise<void>;

    open(hostname: string, port: number, type?: string): Promise<void>;
    isOpen(): boolean;

    identify(username: string): Promise<IIdentifyResult>;
    changeMap(name: string, marker: string | null, areaPath: string, areaType: number): Promise<IChangeMapResult>;

    updatePersition(position: Vec3): void;
    updateAnimation(face: Vec2, anim: string): void;
    updateTimer(timer: number): void;

    spawnEntity(type: string, x: number, y: number, z: number, settings?: object, showAppearEffects?: boolean): void;
    registerEntity(id: number, type: string, pos: Vec3, settings: object): void;
    killEntity(id: number): void;

    throwBall(ballInfo: IBallInfo): void;

    updateEntityPosition(id: number, pos: Vec3): void;
    updateEntityAnimation(id: number, face: Vec2, anim: string): void;
    updateEntityHealth(id: number | null, health: number): void;
    updateEntityState(id: number, state: string): void;
    updateEntityTarget(id: number, target: string | number | null): void;
    // Real player profile (level/stats/equip) shown in the Social info box.
    updatePlayerProfile(profile: IPlayerProfile): void;

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
        (id: number | string, health: number) => void): void;
    onPlayerProfile(callback:
        (player: string, profile: IPlayerProfile) => void): void;

    // ---- social callbacks ----
    onPresence(callback: (player: string, online: boolean) => void): void;
    onPartyUpdate(callback: (party: { partyId: string, leader: string, members: string[] } | null) => void): void;
    onPartyInvite(callback: (from: string, partyId: string) => void): void;
    onFriendList(callback: (friends: Array<{ name: string, online: boolean }>) => void): void;
    onFriendActionResult(callback: (result: any) => void): void;
    onFriendRequest(callback: (from: string) => void): void;
    onFriendRequests(callback: (requests: Array<{ name: string, online: boolean }>) => void): void;
    // ---- lobby query callbacks ----
    onRoomPlayers(callback: (players: string[]) => void): void;
    onOnlineCount(callback: (count: number) => void): void;
}

export interface IChangeMapResult {
    instanceId: string;
    isHost: boolean;
    members: Array<{ name: string, pos?: Vec3 }>;
}

/** A remote player's real profile, shown in the Social menu info box. All fields
 * optional — we only display what the sender actually provided. */
export interface IPlayerProfile {
    level?: number;
    hp?: number;
    attack?: number;
    defense?: number;
    focus?: number;
    equip?: { head?: number, leftArm?: number, rightArm?: number, torso?: number, feet?: number };
}