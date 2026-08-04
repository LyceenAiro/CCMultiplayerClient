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
> 另外单独保留了一份 **CCLoader3** 构建,位于 `CCMultiplayerClient-ccloader3/` 目录,
> 以备该加载器日后可用 —— 但它目前仍在开发中、暂时无法使用。

---

## 目录

- [工作原理](#工作原理)
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
├─ loadScreenHook.ts           # 复用"读取存档"菜单作为服务器选择器
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
- **服务器选择器**复用了*读取存档*菜单(`sc.ButtonListBox` / `sc.SaveSlotButton`),
  通过一次性的原型钩子实现。结构应未变化,但值得做一次冒烟测试。
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
