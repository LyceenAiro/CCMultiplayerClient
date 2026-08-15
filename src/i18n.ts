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
    accept: 'Accept',
    decline: 'Decline',
    commAccept: 'Accept Party',
    commDecline: 'Decline',
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

    // quickMenuInject.ts — quick-menu inspect boxes
    addFriend: 'Add Friend',
    friendReqSent: 'Friend request sent',
    levelLabel: 'Lv ',
    expLabel: 'EXP ',
    hpLabel: 'HP ',
    // ROUND 90 — SHIFT quick-menu OnlinePlayer inspect stats + actions
    atkLabel: 'ATK ',
    defLabel: 'DEF ',
    focLabel: 'FOC ',
    inviteParty: 'Invite to Party',
    kickParty: 'Kick from Party',
    leaveParty: 'Leave Party',
    partyInviteSent: 'Invite sent',

    // netBadge.ts — network-quality badge tooltips
    netPingLabel: 'Ping',
    netLossLabel: 'Loss',
    memberLevel: 'Lv.',
    // Round 27 (item 2): off-map teammate badge/portrait tooltip.
    notInSameRoom: 'Not in the same room',

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
    optHostTick: 'Host Tick Rate',
    optHostTickDesc: 'Enemy state sync rate when you are the host of a map (15/30/60). Takes effect the next time you become the host.',
    optPlayerStateRate: 'Position sync rate',
    optPlayerStateRateDesc: 'Your own position/state update rate (10/20/30/60 Hz). Applies immediately.',
    optNetDebug: 'Show Network Debug',
    optNetDebugDesc: 'Shows a bottom-right overlay with your upload/download data rates and packet loss while playing.',
    optNetDebugCum: 'Net Debug Totals',
    optNetDebugCumDesc: 'Extends the network debug overlay with cumulative upload/download totals.',
    optNetTool: 'Advanced Network Tool',
    optNetToolDesc: 'Shows a network-usage panel listing every sync type (enemy state, player state, projectiles, plant breaks, ...) with its upload/download rate, packet count and total size, refreshed every second.',
    netToolLoss: 'LOSS',
    netToolNoEvents: '(no network events yet)',
    netToolSum: 'Sum',
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
    // ROUND 86 — disconnect / server-updated system popups (same mpWin style)
    connLostTitle: 'Connection Lost',
    connLostMsg: 'The connection to the server has been lost. Return to the title screen and reconnect.',
    serverUpdatedTitle: 'Server Updated',
    serverUpdatedMsg: 'The server has been updated (server version: {v}). Please update the multiplayer mod and reconnect.',
    returnTitle: 'Return to Title',
    loginTitle: 'Multiplayer Login',
    loginUserPh: 'Username',
    loginSubmit: 'Submit',
    loginRequired: 'Please enter a username',
    loginRecent: 'Recent',
    deathAllDown: 'All party members down — loading last checkpoint…',
    deathCountdown: 'Respawning in {n}s',
    deathSoon: 'Respawning soon…',
    // Round 23: save-success toast (shown when the server confirms an upload).
    toastSaveDone: 'Save uploaded',

    // round 23 wave 3 — social overhaul (add-friend search flow)
    searchTitle: 'Search Players',
    searchPh: 'Player name',
    searchBtn: 'Search',
    searchRequired: 'Enter a player name to search',
    searching: 'Searching…',
    searchFailed: 'Search failed',
    searchNoResults: 'No matching players found',
    friendAddBtn: 'Send friend request',
    alreadyFriends: 'Already friends',
    requestPending: 'Request pending',
    botNotUnlocked: 'Not unlocked yet',
    friendCannotSelf: "You can't add yourself",
    friendRequestSentToast: 'Friend request sent',
    friendActionFailed: 'Action failed',
    // round 23 wave 3 — 申请管理 (Requests) tab
    requestsTab: 'Requests',
    reqAcceptTitle: 'Accept friend request',
    reqWithdraw: 'Withdraw request',
    reqWithdrawTitle: 'Withdraw request',
    // round 23 wave 3 — party-invite busy + friend-remove confirm
    partyInviteBusy: 'They have a pending invite',
    confirmRemoveFriendTitle: 'Remove Friend',
    confirmRemoveFriendMsg: 'Remove {name} from friends?',
    confirmOk: 'Confirm',
    confirmCancel: 'Cancel',
    // round 23 wave 3 — notifications (showMpToast)
    friendAddedToast: 'You and {name} are now friends',
    friendRequestReceivedToast: '{name} sent you a friend request',
    friendRequestWithdrawnToast: '{name} withdrew the friend request',
    friendRequestDeclinedToast: '{name} declined your friend request',
    partyMemberJoined: '{name} joined the party',
    partyMemberLeft: '{name} left the party',
    partyMemberKicked: '{name} was kicked from the party',
    partyMemberDisconnected: '{name} disconnected from the party',
    // round 23 wave 4 — party chat (chatBox.ts)
    chatPlaceholder: 'Type a message, Enter to send…',
    chatSend: 'Send',
    chatNotInParty: 'Not in a party — party chat unavailable',
    // round 24 — save-toast toggle + simplified party-invite popup
    optShowSaveToast: 'Show Save Toast',
    optShowSaveToastDesc: 'Shows a toast when your save has been uploaded to the server.',
    commInviteSimple: '{name} invites you to party',

    // round 27 — full-screen "downloading cloud save" block overlay (multiplayer.ts launchGame)
    saveDlTitle: 'Downloading Cloud Save',
    saveDlIndeterminate: 'Downloading cloud save…',
    saveDlProgress: 'Downloading cloud save… {pct}%',
    saveDlFailed: 'Cloud save download failed — starting without it',
    // round 27 (item 5) — exit-to-title save UPLOAD dialog (same overlay as the download)
    saveUpTitle: 'Uploading Save',
    saveUpIndeterminate: 'Uploading save before returning to title…',
    saveUpFailed: 'Save upload failed — returning to title anyway',

    // Round 64 — Minecraft-style server list (连接服务器 screen)
    serverListTitle: 'Multiplayer',
    serverJoin: 'Join Server',
    serverDirect: 'Direct Connect',
    serverAdd: 'Add Server',
    serverDelete: 'Delete Server',
    serverRefresh: 'Refresh',
    serverClose: 'Close',
    serverOnline: 'Online',
    serverOffline: 'Offline',
    serverChecking: 'Checking…',
    serverEmpty: 'No servers yet — add one below.',
    serverPing: '{n} ms',
    serverNameLabel: 'Server Name',
    serverHostLabel: 'Server Address',
    serverPortLabel: 'Port',
    serverSave: 'Save',
    serverCancel: 'Cancel',
    serverNamePh: 'Name (optional)',
    serverHostPh: 'Address (e.g. localhost)',
    serverDirectPh: 'Address (host:port)',
    serverRequiredHost: 'Please enter a server address',
    serverInvalidPort: 'Invalid port (1-65535)',
    serverDeleteTitle: 'Delete Server',
    serverDeleteConfirm: 'Delete server "{name}"?',
};

const zhDict: { [key: string]: string } = {
    // socialOverlay.ts — friend-request toast + comm-call dialog + F8 command box
    accept: '接受',
    decline: '拒绝',
    commAccept: '接受组队',
    commDecline: '拒绝',
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

    // quickMenuInject.ts — quick-menu inspect boxes
    addFriend: '加好友',
    friendReqSent: '已发送好友请求',
    levelLabel: '等级 ',
    expLabel: '经验 ',
    hpLabel: 'HP ',
    // ROUND 90 — SHIFT快捷菜单玩家查询的属性和动作
    atkLabel: '攻击 ',
    defLabel: '防御 ',
    focLabel: '专注 ',
    inviteParty: '邀请组队',
    kickParty: '踢出队伍',
    leaveParty: '退出队伍',
    partyInviteSent: '已发送邀请',

    // netBadge.ts — network-quality badge tooltips
    netPingLabel: '延迟',
    netLossLabel: '丢包',
    memberLevel: '等级',
    // Round 27 (item 2): off-map teammate badge/portrait tooltip.
    notInSameRoom: '不在同一房间',

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
    optHostTick: '主机同步频率',
    optHostTickDesc: '作为地图主机时敌人状态同步频率(15/30/60)，下一次作为主机时生效',
    optPlayerStateRate: '位置同步频率',
    optPlayerStateRateDesc: '自身位置/状态同步频率(10/20/30/60Hz)，调整后立即生效',
    optNetDebug: '显示网络调试',
    optNetDebugDesc: '开启后，游玩时屏幕右下角显示每秒上传/下载数据量与丢包率',
    optNetDebugCum: '网络调试累计量',
    optNetDebugCumDesc: '开启后，在网络调试基础上额外显示累计上传/下载数据量',
    optNetTool: '高级网络工具',
    optNetToolDesc: '开启后显示各类型数据的实时网络用量面板（敌人状态、玩家状态、弹幕、植物破坏等），每秒刷新，含上传/下载速率、包数与累计大小',
    netToolLoss: '丢包',
    netToolNoEvents: '（暂无网络事件）',
    netToolSum: '合计',
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
    // ROUND 86 — 断线 / 服务器更新系统弹窗（与其它 mpWin 弹窗同一风格）
    connLostTitle: '连接已断开',
    connLostMsg: '与服务器的连接已断开，请返回主界面后重新连接。',
    serverUpdatedTitle: '服务器已更新',
    serverUpdatedMsg: '服务器已更新（服务器版本：{v}），请更新多人模组后重新连接。',
    returnTitle: '返回主界面',
    loginTitle: '多人联机登录',
    loginUserPh: '用户名',
    loginSubmit: '登录',
    loginRequired: '请输入用户名',
    loginRecent: '最近登录',
    deathAllDown: '全队阵亡 — 正在读取最近存档点…',
    deathCountdown: '复活倒计时：{n} 秒',
    deathSoon: '即将复活…',
    // Round 23: save-success toast (shown when the server confirms an upload).
    toastSaveDone: '存档已保存并上传',

    // round 23 wave 3 — social overhaul (add-friend search flow)
    searchTitle: '搜索玩家',
    searchPh: '玩家名',
    searchBtn: '搜索',
    searchRequired: '请输入要搜索的玩家名',
    searching: '搜索中…',
    searchFailed: '搜索失败',
    searchNoResults: '没有找到相关玩家',
    friendAddBtn: '发送好友申请',
    alreadyFriends: '已是好友',
    requestPending: '申请已发送，等待对方处理',
    botNotUnlocked: '剧情尚未解锁',
    friendCannotSelf: '不能添加自己',
    friendRequestSentToast: '申请已发送',
    friendActionFailed: '操作失败',
    // round 23 wave 3 — 申请管理 (Requests) tab
    requestsTab: '申请管理',
    reqAcceptTitle: '接受好友申请',
    reqWithdraw: '撤回申请',
    reqWithdrawTitle: '撤回好友申请',
    // round 23 wave 3 — party-invite busy + friend-remove confirm
    partyInviteBusy: '对方正在处理其他邀请',
    confirmRemoveFriendTitle: '删除好友',
    confirmRemoveFriendMsg: '确定要删除好友 {name} 吗？',
    confirmOk: '确认',
    confirmCancel: '取消',
    // round 23 wave 3 — notifications (showMpToast)
    friendAddedToast: '你与 {name} 成为了好友',
    friendRequestReceivedToast: '{name} 向你发送了好友申请',
    friendRequestWithdrawnToast: '{name} 撤回了好友申请',
    friendRequestDeclinedToast: '{name} 拒绝了你的好友申请',
    partyMemberJoined: '{name} 加入了队伍',
    partyMemberLeft: '{name} 离开了队伍',
    partyMemberKicked: '{name} 被踢出了队伍',
    partyMemberDisconnected: '{name} 断线离开了队伍',
    // round 23 wave 4 — party chat (chatBox.ts)
    chatPlaceholder: '输入消息，回车发送…',
    chatSend: '发送',
    chatNotInParty: '你不在队伍中，无法发送小队消息',
    // round 24 — 保存提示开关 + 简化版组队邀请弹窗
    optShowSaveToast: '显示保存提示',
    optShowSaveToastDesc: '存档成功上传到服务器后显示提示通知',
    commInviteSimple: '{name} 邀请你组队',

    // round 27 — 下载云端存档时的全屏等待提示 (multiplayer.ts launchGame)
    saveDlTitle: '正在下载云端存档',
    saveDlIndeterminate: '正在下载云端存档…',
    saveDlProgress: '正在下载云端存档… {pct}%',
    saveDlFailed: '云端存档下载失败，将以本地存档开始游戏',
    // round 27 (item 5) — 返回标题前的存档上传弹窗（与下载共用同一覆盖层）
    saveUpTitle: '正在上传存档',
    saveUpIndeterminate: '正在上传存档，完成后将返回标题…',
    saveUpFailed: '存档上传失败，仍将返回标题',

    // Round 64 — Minecraft 风格服务器列表（连接服务器界面）
    serverListTitle: '多人联机',
    serverJoin: '加入服务器',
    serverDirect: '直接连接',
    serverAdd: '新增服务器',
    serverDelete: '删除服务器',
    serverRefresh: '刷新',
    serverClose: '关闭',
    serverOnline: '在线',
    serverOffline: '离线',
    serverChecking: '检测中…',
    serverEmpty: '暂无服务器，请先新增',
    serverPing: '{n} ms',
    serverNameLabel: '服务器名称',
    serverHostLabel: '服务器地址',
    serverPortLabel: '端口',
    serverSave: '保存',
    serverCancel: '取消',
    serverNamePh: '名称（可选）',
    serverHostPh: '地址（如 localhost）',
    serverDirectPh: '地址（主机:端口）',
    serverRequiredHost: '请输入服务器地址',
    serverInvalidPort: '端口无效（1-65535）',
    serverDeleteTitle: '删除服务器',
    serverDeleteConfirm: '确定要删除服务器"{name}"吗？',
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
