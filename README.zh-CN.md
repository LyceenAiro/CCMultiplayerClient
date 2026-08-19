# CCMultiplayerClient(中文)

> [English README](README.md) | 中文版本

[![Discord Server](<https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server>)](https://discord.gg/SJmMZKy)

一款 [CrossCode](https://www.cross-code.com/)(远星物语)的**在线多人联机模组**。
它让多名玩家共享同一个世界:每个人都能看见其他玩家的分身在世界中走动,
而**主机**一方的敌人、弹幕与战斗会通过一台中央中继服务器
([CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer))
同步给其余所有玩家。

> **当前状态:已复活 / 维护中。** 本模组最初面向 CrossCode **1.1.0** 与旧版
> **CCLoader v2** 编写。当前代码库**仍基于 CCLoader v2**(目前仍在活跃维护的加载器),
> 但已适配到 **CrossCode 1.4.2**(游戏最终版本)。代码可正常编译,
> 网络协议也已与服务器做了端到端验证。但游戏内的实际联机
> **尚未在真实的 1.4.2 环境上完整实测** —— 详见[已知限制](#已知限制与待实测项)。
>
> **开发说明:** 本项目采用 **vibe coding**(AI 辅助开发)方式开发。

---

## 目录

- [工作原理](#工作原理)
- [功能特性](#功能特性)
- [主城(共享城镇)机制](#主城共享城镇机制)
- [环境要求](#环境要求)
- [构建](#构建)
- [安装](#安装)
- [运行](#运行)
- [配置](#配置)
- [项目结构](#项目结构)
- [网络协议](#网络协议)
- [移植笔记(1.1.0 → 1.4.2,基于 CCLoader v2)](#移植笔记110--142基于-ccloader-v2)
- [已知限制与待实测项](#已知限制与待实测项)
- [常见问题排查](#常见问题排查)

---

## 工作原理

CrossCode 是一款单机游戏,因此这里的"多人"实质上是**状态镜像**:

- 在已连接的客户端中,会选出一个**主机(host)**。主机的世界是关于敌人的唯一权威来源。
- 当非主机客户端加载一张地图时,地图数据里的每个 `Enemy` / `EnemySpawner` 实体
  都会在关卡构建前被**剔除**,并用来自主机世界的、由网络驱动的**镜像实体**替代。
- 主机会持续广播实体的**位置、动画、状态、目标与生命值**;客户端把这些应用到本地镜像上。
  为了不让本地 AI / 物理与网络数据"打架",镜像实体的 `coll.pos`、`face`、
  `currentAnim`、`currentState` 会被替换成只读访问器,其数值只能由网络来改写。
- 每个远程玩家在本地会被渲染成一个特殊的 `multiplayer` 敌人
  (定义见 [`assets/assets/data/enemies/multiplayer.json`](assets/assets/data/enemies/multiplayer.json)),
  它的 `anims` 使用普通的玩家动画,再用本地玩家的 proxies 重新贴图,使其看起来像一名角色。
- 会话期间主机可以更换(**主机迁移**):若主机掉线,服务器会把另一个客户端提升为新主机,
  实体也会被"解锁"交回本地控制。

通信采用 socket.io 中继:客户端之间从不直接通信,所有数据都经由
`CCMultiplayerServer` 转发。

## 功能特性

**联机与匹配**
- **服务器列表界面**(Minecraft 风格):新增 / 删除服务器、**直接连接**(host:port)、
  实时**连通性指示器**(在线/离线 + 延迟),无需再手改配置文件。
- **版本校验** —— 服务器会拒绝版本不一致的客户端。
- **账号登录** —— 用户名即身份(LAN 信任);重复登录会被拒绝,并记住最近登录的用户名。
- **主城自动匹配** —— 见[主城(共享城镇)机制](#主城共享城镇机制)。

**世界与战斗同步**
- **全量状态块同步** —— 玩家、主机敌人与敌人弹幕以"全量状态块"广播
  (自愈式,不会因丢包而失同步)。
- **主机选举与迁移** —— 实例中第一个进入的客户端为主机;主机离开时服务器自动迁移。
- **玩家状态** —— 位置 / 朝向 / 动画 / HP / SP / 蓄力 / 过场 / 元素 / 战斗职业 / 防御时机。
- **敌人同步** —— 主机权威,双频率(15 Hz 基础流 + 选项驱动的敌对流),
  外加敌人音效 / 攻击 / 掉落。
- **地牢机关同步(1.71.0)** —— 地牢内的可推拉箱子、滑动方块、浮空踏板、
  开关、冰柱等谜题实体会通过紧凑的 `puzzleState` 中继 + 主机快照同步。
- **地牢箱子权威与平滑(1.71.2)** —— 推拉箱子同一时间只允许一名玩家抓住;
  抓住箱子的客户端是唯一的箱子位置权威,其他玩家的箱子按帧插值跟随。
- **地牢箱子进度为个人存档状态(1.71.3)** —— "箱子推上开关 / 台阶板下降半截"
  属于每名玩家自己的存档进度(`map.entity…_placed`):`PushPullDest` 台阶板不再
  跨玩家联网同步,自己存档中已放置的箱子既不发送也不接收位置,因此某人的
  已解谜状态不会覆盖(或弄消失)另一个尚未解谜玩家的箱子。
- **地牢浮空机关主机权威(1.71.4)** —— OL / Dynamic / Extract 浮空机关的位置
  只由地图实例主机发送;客机只应用主机位置、不再回传自己半途中的过渡位置,
  神庙密室1被攻击后升降的机关柱会正常到达最终高度,不再卡在约 80% 处来回回退。
- **地牢箱子回波隔离与一次性开关锁定(1.71.5)** —— 无人抓取的推拉箱子同样
  只由主机发布位置(正在抓取的玩家仍是唯一权威);开始抓取前若箱子被旧包
  拖到地面以下,会自动吸附回真实地面。永久型 `OneTimeSwitch`(神庙密室1的
  攻击开关)只要任一同伴报告为已触发就保持 ON,后进玩家"未触发"的旧状态
  不会再覆盖已解谜机关,也不会留下一个打不到的开关。
- **跟随箱垂直冻结(1.71.6)** —— 箱子位置由网络驱动时,本地会冻结其垂直
  物理;把被机关抬起的箱子拉出平台后,各客机视角会保持在真实地面上,
  不再掉进坑里。
- **任务击杀进度同步(1.71.7)** —— 多人模式下,怪物的真实死亡会推进玩家的
  任务"击败 N 只"进度:**未开启剧情同步**时,只有怪物在玩家当前所在的地图
  上被杀死才计数;**剧情同步中**任意队员击杀怪物都会自动同步给全队,
  不受地图限制。
- **箱子松手后交还真实重力(1.71.8)** —— 队员松开箱子时,地图实例主机的
  箱子不再保持网络冻结高度,而是立即恢复引擎重力;因此"神庙密室1"左上角
  需要从高台推下去的箱子会真正落到下层地面,不会再被旧高度拉回台子上。
- **1.71.9 修复与 QoL** —— 服务器列表端口字段可正常键盘输入;共享主城商店
  会清除残留战斗状态并自动重试被任务结算对话框挡住的柜台;队友释放技能时
  屏幕变暗反馈与队伍时停同步(单一效果,不叠加);轻锐/满编小队横幅不再出现
  空白长方体;队友网络徽章改为显示**你与队友之间的相对延迟**;剧情同步结束后
  不再回滚/剔除支线任务进度(已完成的玩家会看到临时"【同步】"任务入口,无奖励);
  主线同步会把超前队友临时钳制到队长进度并每帧维持;剧情中隐藏自己的名字;
  修复疯牛冲锋脚步声残留;同步开始音频音量提升;新增屏幕外队友箭头和
  区域/世界地图队友头像。
- **1.71.10 外部UI缩放** —— "多人"选项卡新增**外部UI缩放**设置
  (自动 / 50% / 75% / 100% / 125% / 150% / 200% / 300% / 400%),一次统一缩放
  模组所有 DOM 界面:面板、服务器列表、登录框、聊天、通知、悬浮提示、
  剧情横幅、保存遮罩和屏幕外队友箭头。自动档以游戏启动时的窗口大小为 100%,
  之后跟随窗口缩放;固定档为精确倍率;
  画布内的名字标签同步跟随该设置(自动档即游戏原生缩放)。
- **主机移交保留敌人状态(1.71.0)** —— 沉睡/被动怪物在实例主机迁移后
  继续保持沉睡,不再被立即唤醒进入战斗。
- **主机移交保留敌人生成设置(1.71.2)** —— 原始 `enemyInfo` 属性(`activeIf` 等)
  随敌人状态块下发并在重生时恢复,神庙矿井电梯区的机器人在剧情解锁前
  移交主机后依旧保持沉睡,不会被立刻唤醒。
- **剧情队长动作中继(1.71.0)** —— 剧情队长播放的外部动画(坐下、姿势等)
  会在所有队员的队长镜像上重放。
- **战斗反馈** —— 敌人受击、格挡与完美格挡、反击 / 破防特效、技能音效 / 特效重放、
  以及全队蓄力时间暂停。
- **死亡与复活** —— 倒地玩家进入观战;全队阵亡时一起读取最近存档点保持同步。

**社交与组队**
- **组队** —— 邀请 / 接受 / 拒绝 / 退出 / 踢出、队长转移、以及"传送到队友身边"归队。
- **好友** —— 申请 / 接受 / 拒绝 / 删除、申请管理、名字搜索;
  官方同伴可重新添加为好友(自动接受)。
- **队伍 bot** —— 队长的随从 bot 会镜像给队员;离线好友可作为 "mod bot" 跟随。
  在地牢中会按原版规则清除所有网络 bot(原版会隐藏地牢内的随从实体),
  离开地牢后自动恢复。
- **剧情锁定同伴(1.71.0)** —— 同伴只在游戏自身 `SET_MEMBER_LOCKED` 标志开启时
  不可踢出,与原版社交菜单逻辑一致;剧情事件解锁后即可正常踢出。
- **房间玩家** —— 查看当前地图实例中有谁,另有实时在线人数。
- **小队聊天** —— 回车打开聊天输入框,带历史记录与气泡渲染(仅限队伍)。

**HUD 与辅助**
- **名字标签** —— 显示名字 / 自己名字 / bot 名字、队长金色名字、ping 值显示、
  可调透明度与字号。
- **网络徽章** —— 队伍头像与元素指示器上的绿/黄/橙/红菱形(延迟/丢包),带悬停提示。
- **网络调试 HUD** —— 实时上行/下行速率、丢包率、累计流量。
- **模组设置页** —— 游戏菜单里新增的"多人"选项卡。
- **快速菜单(SHIFT)查看** —— 可查看在线玩家与队伍 bot,带添加/删除好友按钮。
- **直接保存+上传** —— 联机时背包菜单 / ESC 菜单的保存按钮会直接存档并上传。
- **命令框(F8)** —— 无需 DevTools 即可运行 `mp.*` 控制台命令。

**存档与持久化**
- **云端存档** —— 登录时从服务器流式下载并恢复存档;保存与退出前会分块限速上传。
- **存档镜像回溯(1.71.0)** —— 服务器为每名玩家保留最近 **5 份不重复的存档镜像**。
  登录界面的 **镜像回溯** 按钮会先登录并暂扣最新存档流,展示带时间戳的 5 份镜像,
  选择任意一份即可进入该镜像存档。
- **镜像选择器关闭(1.71.4)** —— 镜像选择框新增 **×** 关闭按钮:点击后立即登出、
  关闭连接并返回主界面,不会进入游戏。
- **防刷** —— 区域存档节流、登录时的上传抑制窗口。
- **本地持久化** —— 服务器列表、选项、登录历史、聊天历史在重启后保留(localStorage)。

## 主城(共享城镇)机制

六个大区域被设为**主城**(开放匹配的汇合点),玩家无需组队即可在此相遇:

- **新手港**(`rookie-harbor`, Rookie Harbor)
- **罗姆斯广场**(`rhombus-sqr`, Rhombus Square,含迎新桥)
- **俾尔根村**(`bergen`, Bergen Village)
- **巴基库姆**(`ba-ki-kum`, Ba'kii Kum)
- **巴辛堡**(`basin-keep`, Basin Keep)
- **家园**(`homestedt`, Homestedt)

行为规则:

- **按大区域划分实例。** 整个大区域算作一个主城实例 —— 只要处于该区域,
  无论站在哪张子地图,都会自动匹配进同一个实例(`town:<area>[#N]`),
  而不是按子地图各自分房。
- **主机同野外。** 与野外一致,第一个进入某条分线的玩家成为该分线主机,
  主机迁移逻辑不变。
- **无需组队。** 自动与已在主城中的玩家匹配。
- **每条分线最多 32 人。** 满员后新进入者自动进入新的 `town:<area>#N` 分线。
- **为多人大厅优化了网络。** 为了让 32 人房间保持轻量:
  - 玩家状态(HP / 经验 / SP 等)以 **1 Hz** 同步;
  - 位置以 **10 Hz** 同步;
  - **不发送**敌人 / 弹幕相关的同步包(主城没有敌人);
  - **不同步**队伍 bot —— bot 仅其队长自己可见;
  - 幽灵宝箱仍然**仅限组队**。

## 环境要求

| 组件                   | 版本                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| CrossCode              | **1.4.2**(最终版本,官方已不再更新)                                  |
| Mod 加载器             | **CCLoader v2**(当前仍在活跃维护的加载器)—— 它自带本模组所用的 `simplify` 库 |
| Node.js(构建 + 服务器) | ≥ 18                                                                     |
| 中继服务器             | [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer) |

## 构建

```bash
npm install
npm run build
```

构建会生成 `dist/` 目录:

```
dist/
├─ mod.js               # 模组本体,打包成单个传统脚本(由 CCLoader v2 的 `main` 阶段执行)
├─ mod.js.map
├─ data/enemies/multiplayer.json   # 游戏资源(镜像玩家用的敌人类型)
└─ config/config.json              # 默认服务器列表
```

常用脚本:

| 命令              | 作用                                               |
| ----------------- | -------------------------------------------------- |
| `npm run build` | 通过 esbuild 做一次生产环境打包                    |
| `npm run watch` | 监听文件变化并自动重新构建                         |
| `npm run check` | 仅做类型检查(`tsc --noEmit`),基于 1.4.0 类型定义 |

## 安装

1. 在你的 CrossCode 1.4.2 中安装 **CCLoader v2**
   (参见 [CCLoader 仓库](https://github.com/CCDirectLink/CCLoader))。
   它自带本模组所依赖的 `simplify` 库模组。
2. 把本模组文件夹复制到游戏的 `assets/mods/` 目录,使模组的 `package.json` / `ccmod.json`
   位于 `assets/mods/multiplayer/`,并把编译好的 `dist/` 放在它旁边。
3. 清单中的 `main` 已指向打包产物(`"main": "dist/mod.js"`),且 `ccmodDependencies`
   已声明 `simplify`,加载器会自动装配好一切。

## 运行

1. 启动一台中继服务器(见服务端仓库),例如:
   ```bash
   cd CCMultiplayerServer
   npm install
   npm start          # 监听 *:1423
   ```
2. 把服务器地址加入 `config/config.json`(或直接使用自带的默认配置)。
3. 通过 CCLoader v2 启动游戏。在**标题界面**,第二个菜单按钮会被改写成
   **Connect(连接)** —— 点击它,选择一台服务器,输入用户名,
   模组就会把你载入主机当前所在的地图。

## 配置

`config/config.json`(构建时会复制到 `dist/config/config.json`)列出了
游戏内服务器选择器中显示的服务器:

```json
{
	"servers": [
		{ "hostname": "localhost", "port": 1423, "type": "http" },
		{ "display": "公共服务器", "hostname": "example.com", "port": 1423, "type": "http" }
	]
}
```

- `hostname` / `port` / `type` —— socket.io 中继服务器的位置(`type` 为 URL 协议,`http` 或 `https`)。
- `display` —— 可选,在服务器选择器中显示的友好名称。

## 项目结构

```
src/
├─ main.ts                     # CCLoader v2 入口(`main` 阶段,等待 modsLoaded 事件)
├─ multiplayer.ts              # 总协调器:连接、界面劫持、实体注册表
├─ config.ts / configFile.ts   # 服务器列表配置加载(经由 simplify)
├─ connection.ts               # IConnection 接口(网络协议面)
├─ connectors/SocketIOConnector.ts  # IConnection 的 socket.io 实现
├─ simplify.d.ts               # CCLoader v2 自带 Simplify 库的类型声明
├─ loadScreenHook.ts           # 旧:复用"读取存档"菜单(现为 ui/serverList.ts)
├─ types.d.ts                  # 共享的 Vec2/Vec3 结构
├─ mpEntity.ts / player.ts / server.ts / ballInfo.ts / entityDefinition.ts
├─ listeners/
│  ├─ game/                    # 监听本地游戏状态 → 广播变更
│  │  ├─ entityListener.ts  playerListener.ts   # 每帧驱动的实体/玩家泵
│  │  ├─ onPlayerMove/Animation/HealthChange.ts # "我自己" → 服务器
│  │  ├─ onEntityMove/Animation/HealthChange/StateChange/TargetChange.ts
│  │  ├─ onEntitySpawn.ts onKill.ts             # 主机权威的生成/击杀
│  │  ├─ onMapEnter.ts onMapLoaded.ts onTeleport.ts
│  └─ connection/              # 把远端状态 → 应用到本地世界
│     ├─ onSetHost.ts onPlayerChangeMap.ts onRegisterEntity.ts onKillEntity.ts
│     ├─ onThrowBall.ts onUpdatePosition/Animation/AnimationTimer.ts
│     └─ onUpdateEntity{Position,Animation,State,Target,Health}.ts
└─ models/identifyResult.ts
```

## 网络协议

使用普通的 socket.io 事件。客户端→服务器与服务器→客户端使用相同的事件名;
由服务器转发给同地图的相关成员。握手流程:

```
客户端 → 服务器  "handshake"          { username, version, client }
服务器 → 客户端  "handshakeResponse"  { success, host, username, mapName }
```

随后按地图成员关系进行:

| 事件                                                                                   | 方向   | 数据                                        | 说明                                         |
| -------------------------------------------------------------------------------------- | ------ | ------------------------------------------- | -------------------------------------------- |
| `changeMap`                                                                          | 客→服 | `{name, marker}`                          | 服务器通过`onPlayerChangeMap` 转发成员变化 |
| `onPlayerChangeMap`                                                                  | 服→客 | `{player, enters, position, map, marker}` | 生成/移除远程玩家分身                        |
| `updatePosition` / `updateAnimation` / `updateAnimationTimer`                    | 双向   | pos /`{face,anim}` / timer                | "我自己"的分身状态                           |
| `registerEntity` / `killEntity`                                                    | 双向   | `{id,type,pos,settings}` / `{id}`       | 主机权威的实体                               |
| `updateEntityPosition` / `…Animation` / `…State` / `…Target` / `…Health` | 双向   | `{id, …}`                                | 镜像实体状态                                 |
| `throwBall`                                                                          | 双向   | `{ballInfo, combatant, dir, party}`       | 弹幕/投射物                                  |
| `puzzleState`                                                                        | C→S/S→C | `{map, entries}`                          | 1.71.0 地牢谜题实体快照;1.71.2 增加箱子抓取归属 `own`/`ot`;1.71.3 不再中继台阶板与已放置箱子的个人存档进度 |
| `questKill`                                                                          | C→S/S→C | `{enemy, map}`                            | 1.71.7 任务击杀进度:剧情同步时全队跨地图;否则仅同地图实例                 |
| `saveMirrorRestore`                                                                  | C→S   | `{index}`                                 | 1.71.0 恢复五份存档镜像之一                   |
| `setHost`                                                                            | 服→客 | `isHost`                                  | 主机迁移                                     |

## 移植笔记(1.1.0 → 1.4.2,基于 CCLoader v2)

这一节是"适配到最新版本"的实质内容。模组**仍基于 CCLoader v2**,并继续使用其自带的
**Simplify** 库,因此加载机制与大部分管线保持不变。真正的工作是
**让代码适配 1.1.0 → 1.4.2 的游戏变化**,并对构建做了现代化。

**加载机制(不变 —— CCLoader v2)**

- 仍是经清单的 `main` 阶段加载的传统脚本,依赖全局 `modsLoaded` DOM 事件启动,
  并用 `ccmod.json` 声明运行时依赖(`ccloader`、`crosscode`、`simplify`)。
  同时保留了一份与 npm 同步的 `package.json` 清单。

**构建工具(现代化)**

- webpack → **esbuild**,输出单个传统(IIFE)脚本 `dist/mod.js`,由 v2 直接执行。
  (socket.io-client **不再**内联 —— 在 v2 下,模组会在连接时通过 `simplify.loadScript`
  从服务器拉取与之匹配的客户端库,与原版行为一致。)
- 手写的 `src/@types/*` →
  [`ultimate-crosscode-typedefs`](https://github.com/CCDirectLink/ultimate-crosscode-typedefs)
  (CrossCode 1.4.0),vendor 在 `vendor/` 目录;另加了一份本地的
  `src/simplify.d.ts` 用于声明 Simplify 全局对象。

**1.1→1.4 的类型/API 收紧修复**

- `IMultiplayerEntity` 不再放宽 `Enemy.target`(1.4 中为 `sc.BasicCombatant`),改用交叉类型。
- `player.currentAnim` 现在可能是动画集合对象 → 归一化为动画名。
- `loadLevel`/`teleport` 改经具体的 `sc.CrossCode` 类型绑定。
- `MapData` → `sc.MapModel.Map`;地图实体的 `settings` 以宽松方式读取。
- 由网络驱动的 action/event-step 载荷(`SHOOT_PROXY`、`DO_ACTION`、`spawnEntity` 的 `skipHook`)
  采用类型断言,因为这些内部结构随版本漂移,且属于模组自有协议。

**顺带修复的 bug**

- `onEntityStateChange` 之前误存了浏览器全局 `window.status` 而非实体状态
  (`this.last = status`),导致实体状态更新每帧都触发。现已改为存储真实状态。

**服务端**

- 功能上未改动 —— 它是与游戏版本无关的 socket.io 中继。仅刷新了 `package.json` 元数据,
  并验证了 `socket.io@4.x` 与客户端 `socket.io-client@4.8.x` 的互通,含一次真实握手测试。

## 已知限制与待实测项

以下这些点**只能在真实的 1.4.2 + CCLoader v2 环境**里确认(无法靠编译验证):

- **标题界面按钮劫持。** `initializeGUI()` 按*固定下标*改写标题界面按钮
  (依平台为 `buttons[1]` 或 `[2]`)。若布局已变化,现在会告警而不是崩溃,
  但该下标仍需对照真实 1.4.2 标题界面确认。
- **服务器列表界面**现为独立的 DOM 覆盖层(新增 / 删除 / 直接连接 / 连通性 ping),
  由改写后的标题界面按钮打开;值得在真实 1.4.2 标题界面上做一次冒烟测试。
- **战斗正确性。** 镜像实体的属性锁定技巧(`coll.pos`、`face`、`currentAnim`、`currentState`)
  天然对版本敏感;1.4.2 的战斗很可能需要微调。
- **DLC / 二周目内容。** 模组早于 *A New Home* DLC;1.1.0 之后新增的敌人类型与地图
  走的是同一套通用同步机制,但从未测试过。
- `ig.game.teleport` / `spawnEntity` 是通过直接赋值来包裹的;若其他模组也这样做可能冲突。

如果你要在真实环境测试,浏览器控制台(`[multiplayer] …` 日志)是第一排查入口。

## 常见问题排查

- **"Could not locate the title-screen button to hijack"** —— 标题界面布局不同;
  调整 `multiplayer.ts` 中的 `buttonNumber` / `children[2]`。
- **服务器选择器里没有服务器** —— `config/config.json` 没有被复制;
  运行 `npm run build` 并重新安装模组文件夹。
- **"Could not login"** —— 该用户名已连接到服务器。
- **CCLoader v2 中本模组不显示 / 不加载** —— 确认清单的 `main` 指向 `dist/mod.js`、
  该文件已确实构建,且 `simplify` 模组已安装并启用(它列在 `ccmodDependencies` 里)。
- **"Could not find our own mod via simplify.getMod()"** —— 模组文件夹需被识别为
  `multiplayer`(即清单中的 `name`),这正是 Simplify 查找所用的名字。
