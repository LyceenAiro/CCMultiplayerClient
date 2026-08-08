/**
 * Multiplayer mod i18n: a tiny two-dictionary t() helper.
 *
 * Language is detected from the game's own setting — (window as any).ig.currentLang
 * ("en_US", "zh_CN", ...). The mod loads after the language picker has run, so the
 * value is stable; it is still read LAZILY on the first t() call (and cached from
 * then on) in case this module gets imported before the game has set it up.
 * Anything starting with "en" gets the English dictionary; everything else keeps
 * the current Chinese behaviour (covers zh_CN and zh_TW).
 *
 * zh values below are the EXACT strings currently used in the codebase (copied
 * verbatim); en values are natural English equivalents. Unknown keys render as
 * {{key}} so a missing entry is visible in-game instead of silently blank.
 */

const enDict: { [key: string]: string } = {
    // socialOverlay.ts — friend-request toast + comm-call dialog + F8 command box
    friendRequestSuffix: ' sent you a friend request',
    accept: 'Accept',
    decline: 'Decline',
    commIncoming: 'INCOMING COMM',
    commFrom: 'Caller: ',
    commAccept: 'Accept Party',
    commDecline: 'Decline',
    commInviteMsg: ' invites you to team up — will you travel together?',
    cmdBoxTitle: 'Commands (Enter to run / F8 to close)',
    // Round 19: party invites / teleports auto-declined while in a cutscene.
    inviteBusy: 'In a cutscene — party invite declined automatically',
    teleportBusy: 'In a cutscene — teleporting unavailable',

    // socialMenuInject.ts — Social-menu chips, member options, info box, add-friend box
    onlineChip: 'Online ',
    optInvite: 'Invite',
    optContact: 'Contact',
    optKick: 'Kick',
    optLeaveParty: 'Leave Party',
    partyFull: 'Party Full',
    botLeaderOnly: 'Only the leader can invite bots',
    teleportToMate: 'Teleport to Teammate',
    removeFriend: 'Remove Friend',
    roomTab: 'Room Players',
    hostSuffix: ' (Host)',
    addFriendChip: 'Add Friend',
    infoBlockHost: 'Block Host',
    infoOnlinePlayer: 'Online Player',
    addFriendTitle: 'Add Friend',
    addFriendPh: 'Player name',
    addFriendSend: 'Send Request',

    // quickMenuInject.ts — quick-menu inspect boxes
    addFriend: 'Add Friend',
    friendReqSent: 'Friend request sent',
    levelLabel: 'Lv ',
    expLabel: 'EXP ',
    hpLabel: 'HP ',

    // mpOptions.ts — mod options tab
    optionsTab: 'Multiplayer',
    optShowNames: 'Show Player Names',
    optShowNamesDesc: 'Shows a name tag above each online player during gameplay.',
    optShowSelf: 'Show Own Name',
    optShowSelfDesc: 'Shows your account name above your own character.',
    optShowBots: 'Show Bot Names',
    optShowBotsDesc: 'Shows names above follower party bots.',
    optLeaderGold: 'Gold Leader Name',
    optLeaderGoldDesc: "Renders the party leader's name tag in gold.",
    optShowPing: 'Show Ping',
    optShowPingDesc: 'Shows your current network latency (ms) next to your name tag, updated every second.',
    optTagAlpha: 'Name Tag Opacity',
    optTagAlphaDesc: "Adjusts the opacity of the name tag's dark background.",
    optTagSize: 'Name Tag Size',
    optTagSizeDesc: 'Adjusts the font size of name tags.',
    sizeSmall: 'Small',
    sizeMedium: 'Medium',
    sizeLarge: 'Large',

    // Reserved keys for other agents (multiplayer.ts / netSync.ts) — defined now so
    // they never need to edit i18n.ts again.
    titleConnect: 'Connect',
    connLost: 'Connection to server lost',
    connFailed: 'Connect failed',
    loginTitle: 'Multiplayer Login',
    loginUserPh: 'Username',
    loginSubmit: 'Submit',
    loginRequired: 'Please enter a username',
    loginRecent: 'Recent',
    deathAllDown: 'All party members down — loading last checkpoint…',
    deathCountdown: 'Respawning in {n}s',
    deathSoon: 'Respawning soon…',
};

const zhDict: { [key: string]: string } = {
    // socialOverlay.ts — friend-request toast + comm-call dialog + F8 command box
    friendRequestSuffix: ' 请求添加你为好友',
    accept: '接受',
    decline: '拒绝',
    commIncoming: '正在接入通讯 · INCOMING COMM',
    commFrom: '呼叫方：',
    commAccept: '接受组队',
    commDecline: '拒绝',
    commInviteMsg: ' 向你发起组队请求——是否接受与 TA 结伴同行？',
    cmdBoxTitle: '命令 (回车执行 / F8 关闭)',
    // Round 19: party invites / teleports auto-declined while in a cutscene.
    inviteBusy: '过场动画中，已自动拒绝组队邀请',
    teleportBusy: '过场动画中，无法传送到队友身边',

    // socialMenuInject.ts — Social-menu chips, member options, info box, add-friend box
    onlineChip: '在线 ',
    optInvite: '邀请',
    optContact: '联系',
    optKick: '踢出',
    optLeaveParty: '离开队伍',
    partyFull: '队伍已满',
    botLeaderOnly: '只有队长可邀请bot',
    teleportToMate: '传送到队友身边',
    removeFriend: '删除好友',
    roomTab: '房间玩家',
    hostSuffix: '（主机）',
    addFriendChip: '加好友',
    infoBlockHost: '当前区块主机',
    infoOnlinePlayer: '在线玩家',
    addFriendTitle: '加好友',
    addFriendPh: '玩家名',
    addFriendSend: '发送请求',

    // quickMenuInject.ts — quick-menu inspect boxes
    addFriend: '加好友',
    friendReqSent: '已发送好友请求',
    levelLabel: '等级 ',
    expLabel: '经验 ',
    hpLabel: 'HP ',

    // mpOptions.ts — mod options tab
    optionsTab: '多人',
    optShowNames: '显示玩家名称',
    optShowNamesDesc: '开启后，游玩时在线玩家头上常驻显示名字',
    optShowSelf: '显示自己名称',
    optShowSelfDesc: '开启后，自己角色的头上也常驻显示账号名',
    optShowBots: '显示bot名称',
    optShowBotsDesc: '开启后，跟随的队员(bot)头上也显示名字',
    optLeaderGold: '队长名字金色',
    optLeaderGoldDesc: '开启后，队伍队长的名字以金色显示',
    optShowPing: '显示ping值',
    optShowPingDesc: '开启后，自己名字标签旁显示当前网络延迟(毫秒)，每秒更新一次',
    optTagAlpha: '名字背景透明度',
    optTagAlphaDesc: '调整名字标签深色背景的透明度',
    optTagSize: '名字字体大小',
    optTagSizeDesc: '调整名字标签的字体大小',
    sizeSmall: '小',
    sizeMedium: '中',
    sizeLarge: '大',

    // Reserved keys for other agents (multiplayer.ts / netSync.ts) — defined now so
    // they never need to edit i18n.ts again.
    titleConnect: '连接',
    connLost: '与服务器断开连接 (Connection to server lost)',
    connFailed: '连接失败',
    loginTitle: '多人联机登录',
    loginUserPh: '用户名',
    loginSubmit: '登录',
    loginRequired: '请输入用户名',
    loginRecent: '最近登录',
    deathAllDown: '全队阵亡 — 正在读取最近存档点…',
    deathCountdown: '复活倒计时：{n} 秒',
    deathSoon: '即将复活…',
};

let cached: { [key: string]: string } | null = null;

function dict(): { [key: string]: string } {
    if (!cached) {
        const g: any = (window as any).ig;
        const lang: string = (g && g.currentLang) || '';
        // Anything starting with "en" -> English; everything else keeps the current
        // Chinese behaviour (covers zh_CN and zh_TW).
        cached = lang.indexOf('en') === 0 ? enDict : zhDict;
    }
    return cached;
}

/** Look up a localized string. Missing keys render as {{key}} for visibility. */
export function t(key: string): string {
    return dict()[key] ?? ('{{' + key + '}}');
}
