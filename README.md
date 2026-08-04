# CCMultiplayerClient

> English | [中文版本](README.zh-CN.md)

[![Discord Server](https://img.shields.io/discord/382339402338402315.svg?label=Discord%20Server)](https://discord.gg/SJmMZKy)

An online-multiplayer mod for [CrossCode](https://www.cross-code.com/). It lets
several players share the same world: each sees the other players' avatars
walking around, and the **host's** enemies, projectiles and combat are
synchronized to everyone else over a central relay server
([CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer)).

> **Status:** maintained / revived. The mod was written for CrossCode **1.1.0**
> and **CCLoader v2**. This tree keeps it on **CCLoader v2** (the current,
> actively-maintained loader) while updating it for **CrossCode 1.4.2** (the
> final game release). It builds cleanly and the network protocol has been
> verified end-to-end against the server. In-game multiplayer has **not yet
> been battle-tested on a live 1.4.2 install** — see
> [Known limitations](#known-limitations--to-verify-in-game).
>
> A **CCLoader3** build is available separately in the
> `CCMultiplayerClient-ccloader3/` folder for when that loader is ready — it is
> still under construction and not usable today.

---

## Table of contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Building](#building)
- [Installing](#installing)
- [Running](#running)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Network protocol](#network-protocol)
- [Porting notes (1.1.0 → 1.4.2, on CCLoader v2)](#porting-notes-110--142-on-ccloader-v2)
- [Known limitations & to verify in-game](#known-limitations--to-verify-in-game)
- [Troubleshooting](#troubleshooting)

---

## How it works

CrossCode is a single-player game, so "multiplayer" here is really
**state mirroring**:

- One connected client is elected the **host**. The host's world is the source
  of truth for enemies.
- When a non-host client loads a map, every `Enemy` / `EnemySpawner` entity is
  **stripped out of the map data** before the level builds, and replaced with
  network-driven **mirror entities** spawned from the host's world.
- The host continuously broadcasts entity **position, animation, state, target
  and health**; clients apply those to their mirrors. To stop the local AI /
  physics from fighting the network, a mirror's `coll.pos`, `face`,
  `currentAnim` and `currentState` are replaced with read-only accessors whose
  values only the network may change.
- Each remote player is rendered locally as a special `multiplayer` enemy
  (defined in [`assets/assets/data/enemies/multiplayer.json`](assets/assets/data/enemies/multiplayer.json))
  whose `anims` are the normal player animations, then re-textured with the
  local player's proxies so it looks like a person.
- The host can change over the session (**host migration**): if the host
  disconnects the server promotes another client and entities are "unlocked"
  back to local control.

Communication is a socket.io relay: clients never talk to each other directly,
everything goes through `CCMultiplayerServer`.

## Requirements

| Component | Version |
| --- | --- |
| CrossCode | **1.4.2** (final release; the game is no longer updated) |
| Mod loader | **CCLoader v2** (the current, actively-maintained loader) — it bundles the `simplify` library this mod uses |
| Node.js (build + server) | ≥ 18 |
| Relay server | [CCMultiplayerServer](https://github.com/CCDirectLink/CCMultiplayerServer) |

## Building

```bash
npm install
npm run build
```

This produces `dist/`:

```
dist/
├─ mod.js               # the mod, one bundled classic script (runs via CCLoader v2 `main`)
├─ mod.js.map
├─ data/enemies/multiplayer.json   # game asset (mirror-player enemy type)
└─ config/config.json              # default server list
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run build` | one-off production bundle via esbuild |
| `npm run watch` | rebuild on change |
| `npm run check` | type-check only (`tsc --noEmit`) against the 1.4.0 typedefs |

## Installing

1. Install **CCLoader v2** into your CrossCode 1.4.2 copy
   (see the [CCLoader repo](https://github.com/CCDirectLink/CCLoader)). It ships
   with the `simplify` library mod, which this mod depends on.
2. Copy this mod folder into the game's `assets/mods/` directory so that the
   mod's `package.json` / `ccmod.json` sits at `assets/mods/multiplayer/`, with
   the compiled `dist/` next to it.
3. The manifest's `main` already points at the bundle (`"main": "dist/mod.js"`),
   and `ccmodDependencies` declares `simplify`, so the loader wires everything up.

## Running

1. Start a relay server (see the server repo), e.g.:
   ```bash
   cd CCMultiplayerServer
   npm install
   npm start          # listens on *:1423
   ```
2. Add the server to `config/config.json` (or use the bundled default).
3. Launch the game with CCLoader v2. On the **title screen** the second menu
   button is relabelled to **Connect** — click it, pick a server, enter a
   username, and the mod loads you into the host's current map.

## Configuration

`config/config.json` (copied to `dist/config/config.json` at build time) lists
the servers shown in the in-game picker:

```json
{
	"servers": [
		{ "hostname": "localhost", "port": 1423, "type": "http" },
		{ "display": "Public server", "hostname": "example.com", "port": 1423, "type": "http" }
	]
}
```

- `hostname` / `port` / `type` — where the socket.io relay lives (`type` is the
  URL scheme, `http` or `https`).
- `display` — optional friendly name shown in the server picker.

## Project layout

```
src/
├─ main.ts                     # CCLoader v2 entry point (`main` stage, waits for modsLoaded)
├─ multiplayer.ts              # orchestrator: connect, GUI hijack, entity registry
├─ config.ts / configFile.ts   # server-list config loading (via simplify)
├─ connection.ts               # IConnection interface (the wire protocol surface)
├─ connectors/SocketIOConnector.ts  # socket.io implementation of IConnection
├─ simplify.d.ts               # typings for the Simplify library bundled with CCLoader v2
├─ loadScreenHook.ts           # reuses the Load-game menu as the server picker
├─ types.d.ts                  # shared Vec2/Vec3 shapes
├─ mpEntity.ts / player.ts / server.ts / ballInfo.ts / entityDefinition.ts
├─ listeners/
│  ├─ game/                    # watch LOCAL game state → broadcast changes
│  │  ├─ entityListener.ts  playerListener.ts   # per-frame entity/player pumps
│  │  ├─ onPlayerMove/Animation/HealthChange.ts # "me" → server
│  │  ├─ onEntityMove/Animation/HealthChange/StateChange/TargetChange.ts
│  │  ├─ onEntitySpawn.ts onKill.ts             # host authoritative spawn/kill
│  │  ├─ onMapEnter.ts onMapLoaded.ts onTeleport.ts
│  └─ connection/              # apply REMOTE state → local world
│     ├─ onSetHost.ts onPlayerChangeMap.ts onRegisterEntity.ts onKillEntity.ts
│     ├─ onThrowBall.ts onUpdatePosition/Animation/AnimationTimer.ts
│     └─ onUpdateEntity{Position,Animation,State,Target,Health}.ts
└─ models/identifyResult.ts
```

## Network protocol

Plain socket.io events. Client→server and server→client use the same event
names; the server relays to the relevant room members. The handshake:

```
client → server  "handshake"          { username, version, client }
server → client  "handshakeResponse"  { success, host, username, mapName }
```

Then, per map membership:

| Event | Direction | Payload | Notes |
| --- | --- | --- | --- |
| `changeMap` | C→S | `{name, marker}` | server relays membership via `onPlayerChangeMap` |
| `onPlayerChangeMap` | S→C | `{player, enters, position, map, marker}` | spawn/remove a remote avatar |
| `updatePosition` / `updateAnimation` / `updateAnimationTimer` | both | pos / `{face,anim}` / timer | "me" avatar state |
| `registerEntity` / `killEntity` | both | `{id,type,pos,settings}` / `{id}` | host-authoritative entities |
| `updateEntityPosition` / `…Animation` / `…State` / `…Target` / `…Health` | both | `{id, …}` | mirror entity state |
| `throwBall` | both | `{ballInfo, combatant, dir, party}` | projectiles |
| `setHost` | S→C | `isHost` | host migration |

## Porting notes (1.1.0 → 1.4.2, on CCLoader v2)

This is the substance of the "adaptation to the latest version". The mod stays
on **CCLoader v2** and keeps using the **Simplify** library that ships with it,
so the loading mechanism and most of the plumbing are unchanged. The real work
was **updating the code for the 1.1.0 → 1.4.2 game changes** and modernising
the build.

**Loading mechanism (unchanged — CCLoader v2)**
- Still a classic script loaded via the manifest's `main` stage, bootstrapped
  off the global `modsLoaded` DOM event, with `ccmod.json` declaring the
  runtime deps (`ccloader`, `crosscode`, `simplify`). A `package.json` manifest
  is also kept in sync for npm.

**Build tooling (modernised)**
- webpack → **esbuild**, emitting a single classic (IIFE) script `dist/mod.js`
  that v2 runs directly. (socket.io-client is *not* bundled — under v2 the mod
  fetches the matching client library from the server at connect time via
  `simplify.loadScript`, exactly as before.)
- Hand-maintained `src/@types/*` →
  [`ultimate-crosscode-typedefs`](https://github.com/CCDirectLink/ultimate-crosscode-typedefs)
  (CrossCode 1.4.0), vendored under `vendor/`, plus a small local
  `src/simplify.d.ts` for the Simplify global.

**1.1→1.4 type/API tightenings fixed**
- `IMultiplayerEntity` no longer widens `Enemy.target` (now `sc.BasicCombatant`);
  it's an intersection type instead.
- `player.currentAnim` may be an animation-set object now → normalised to a name.
- `loadLevel`/`teleport` re-bound through the concrete `sc.CrossCode` type.
- `MapData` → `sc.MapModel.Map`; map-entity `settings` read loosely.
- Network-driven action/event-step payloads (`SHOOT_PROXY`, `DO_ACTION`,
  `spawnEntity` `skipHook`) are cast, since those internal shapes drift per
  version and are part of the mod's own wire protocol.

**Bug fixed along the way**
- `onEntityStateChange` stored the browser global `window.status` instead of the
  entity state (`this.last = status`), so entity-state updates fired every
  frame. Now stores the real state.

**Server**
- Unchanged functionally — it is a game-agnostic socket.io relay. Refreshed
  `package.json` metadata and verified `socket.io@4.x` interop with the client's
  `socket.io-client@4.8.x`, including a live handshake test.

## Known limitations & to verify in-game

These are the spots that can only be confirmed on a **live 1.4.2 + CCLoader v2**
install (they cannot be validated by compiling):

- **Title-screen button hijack.** `initializeGUI()` relabels a title-screen
  button by a *fixed index* (`buttons[1]` or `[2]` depending on platform). It
  now warns instead of crashing if the layout changed, but the index should be
  confirmed against the real 1.4.2 title screen.
- **Server picker** reuses the *Load game* menu (`sc.ButtonListBox` /
  `sc.SaveSlotButton`) via a one-shot prototype hook. Structure should be
  unchanged, but worth a smoke test.
- **Combat correctness.** The mirror-entity property-locking trick
  (`coll.pos`, `face`, `currentAnim`, `currentState`) is inherently
  version-sensitive; expect to tune it for 1.4.2 combat.
- **DLC / New Game+ content.** The mod predates the *A New Home* DLC; enemy
  types and maps added after 1.1.0 are synced by the same generic mechanism but
  were never tested.
- `ig.game.teleport` / `spawnEntity` are wrapped by direct assignment; other
  mods doing the same could conflict.

If you test on a live install, the browser console (`[multiplayer] …` logs) is
the first place to look.

## Troubleshooting

- **"Could not locate the title-screen button to hijack"** — the title screen
  layout differs; adjust `buttonNumber`/`children[2]` in `multiplayer.ts`.
- **No servers in the picker** — `config/config.json` wasn't copied; run
  `npm run build` and reinstall the mod folder.
- **"Could not login"** — that username is already connected to the server.
- **Mod doesn't appear / doesn't load in CCLoader v2** — confirm the manifest's
  `main` points at `dist/mod.js`, that `dist/mod.js` was actually built, and
  that the `simplify` mod is installed and enabled (it's listed under
  `ccmodDependencies`).
- **"Could not find our own mod via simplify.getMod()"** — the mod folder must
  be named/detected as `multiplayer` (the manifest `name`), which is what
  Simplify looks up.
