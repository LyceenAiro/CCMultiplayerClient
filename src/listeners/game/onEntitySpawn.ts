import { IBallInfo } from '../../ballInfo';
import { IMultiplayerEntity } from '../../mpEntity';
import { Multiplayer } from '../../multiplayer';

export class OnEntitySpawnListener {
	private unknownEntities: Array<string | typeof ig.Entity> = [];
	private recursiveEntities: Array<string | typeof ig.Entity> = [];
	/** Rate-limit for the null-enemyType spawn diagnostic (can be batchy). */
	private lastNullTypeLog = 0;
	private original!: <T extends ig.Entity>(type: string | (new(...args: any[]) => T),
											x: number,
											y: number,
											z: number,
											settings: any,
											showAppearEffects?: boolean) => T;

	constructor(
		private main: Multiplayer,
	) { }

	public register(): void {
		this.original = ig.game.spawnEntity;
		ig.game.spawnEntity = <T extends ig.Entity>(type: string | (new(...args: any[]) => T),
			x: number,
			y: number,
			z: number,
			settings: any,
			showAppearEffects?: boolean) => {
			const entity = (settings && settings.skipHook)
				? this.original.call(ig.game, type, x, y, z, settings, showAppearEffects) as T
				: this.onEntitySpawned(type as string | typeof ig.Entity, x, y, z, settings, showAppearEffects) as T;
			// Enemy.init leaves enemyType null when settings lack enemyInfo — such an
			// enemy is INVISIBLE and crashes in onKill. Repair when the type is
			// recoverable, otherwise log a stack so we can find the offending spawner.
			this.verifyEnemyType(type, entity, settings);
			return entity;
		};
	}

	private verifyEnemyType(type: string | (new(...args: any[]) => ig.Entity), entity: any, settings: any): void {
		try {
			// NOTE: the engine's EnemySpawner spawns with the CONSTRUCTOR
			// (ig.ENTITY.Enemy), not the string 'Enemy' — accept both forms.
			const isEnemy = type === 'Enemy' || type === (ig.ENTITY as any).Enemy;
			if (!isEnemy || !entity || entity.enemyType) return;
			const t = settings && settings.enemyInfo && settings.enemyInfo.type;
			if (t) {
				entity.enemyType = new sc.EnemyType(t);
				entity.enemyName = entity.enemyName || t;
				console.warn('[multiplayer] repaired NULL enemyType post-spawn (type=' + t + ')');
			} else {
				const now = Date.now();
				if (now - this.lastNullTypeLog > 2000) {
					this.lastNullTypeLog = now;
					console.warn('[multiplayer] Enemy spawned WITHOUT enemyInfo (invisible until killed; onKill guarded). stack: '
						+ ((new Error().stack || '').split('\n').slice(1, 6).join(' <- ')));
				}
			}
		} catch (_) { /* diagnostics must never break a spawn */ }
	}

	public onEntitySpawned(type: string | typeof ig.Entity,
		x: number,
		y: number,
		z: number,
		settings: any,
		showAppearEffects?: boolean): ig.Entity {
		// Static objects that never change or objects that should never be
		// synced. Entity classes in 1.4.x are distinct constructor types, so we
		// compare loosely (`unknown`) rather than against a shared ctor type.
		const blacklist: unknown[] = [
			'Marker',
			'HiddenBlock',
			ig.ENTITY.Player,
			ig.ENTITY.Crosshair,
			ig.ENTITY.CrosshairDot,
			ig.ENTITY.OffsetParticle,
			ig.ENTITY.RhombusParticle,
			ig.ENTITY.HiddenSkyBlock,
			ig.ENTITY.Effect,
			ig.ENTITY.Particle,
			ig.ENTITY.CopyParticle,
		];

		if (blacklist.indexOf(type) >= 0) {
			return this.original.call(ig.game, type, x, y, z, settings, showAppearEffects);
		}

		if (typeof type !== 'string' && (type as unknown) === (ig.ENTITY.Ball as unknown)) {
			const isLocalPlayerBall = settings.combatant === ig.game.playerEntity;
			// Only re-broadcast balls the LOCAL player threw. Remote-player mirrors
			// replay their own balls via onThrowBall, and enemy (NPC) balls are
			// simulated locally by the host — neither needs a lookup here. filterBall
			// only knows the player's proxies, so it can't resolve enemy ball types;
			// don't spam a warning for those.
			if (isLocalPlayerBall) {
				const ballSettings = this.filterBall(settings);
				if (ballSettings) {
					this.main.connection.throwBall(ballSettings);
				} else {
					console.warn('[multiplayer] Could not find type of ball (filterBall returned null). combatant=localPlayer');
				}
			}
			return this.original.call(ig.game, type, x, y, z, settings, showAppearEffects);
		}

		const entity = this.original.call(ig.game, type, x, y, z, settings, showAppearEffects) as IMultiplayerEntity;

		const realType = this.findEntityType(type);
		if (realType === undefined) {
			if (this.unknownEntities.indexOf(type) === -1) {
				console.log('Unknown entity type spawned');
				this.unknownEntities.push(type);

				for (const key in sc) {
					if ((sc as any)[key] === type) {
						console.log(`Unkown entity is of type sc.${key}`);
					}
				}
			}

			return entity;
		}

		if (entity && !entity.multiplayerId) {
			entity.settings = settings;

			// Under the new block sync the host does NOT register/broadcast enemies here —
			// it streams the whole map's enemy state (keyed by stable mapId) at ~15Hz and
			// members spawn their own puppets. Skip registration so entities stay
			// multiplayerId-free (which is exactly what netSync's sendEnemyBlock expects).
			if (this.main.host && !this.main.useNetSync) {
				const mid = this.main.registerEntity(entity);

				// TODO: improve this (Maybe with a white/blacklist?)
				let isRecursive = false;

				if (this.recursiveEntities.includes(type)) {
					isRecursive = true;
				} else {
					try {
						JSON.stringify(settings);
					} catch (e: any) {
						if (e.name === 'TypeError') {
							isRecursive = true;
							this.recursiveEntities.push(type);
							console.log('Added type to recursive blacklist: ', this.findEntityType(type), type);
						} else {
							throw e;
						}
					}
				}

				this.main.connection.registerEntity(mid,
					realType,
					{x, y, z},
					isRecursive ? {} : settings);
			}

			entity.lastPosition = {x, y, z};
		}

		return entity;
	}

	private filterBall(settings: {
		ballInfo: any
		combatant: ig.Entity,
		dir: Vec2,
		party: number,
	}): IBallInfo | null {
		const player = ig.game.playerEntity;
		const proxies = player.proxies;

		for (const name in proxies) {
			if (Object.prototype.hasOwnProperty.call(proxies, name)) {
				// `data` is an internal field on proxy spawners that the type
				// definitions do not expose; access it loosely.
				const proxy = proxies[name] as any;
				if (proxy !== undefined && proxy.data === settings.ballInfo) {
					return {
						ballInfo: name,
						combatant:
							settings.combatant === null
								? null
								: (settings.combatant as IMultiplayerEntity).multiplayerId,
						dir: settings.dir,
						party: settings.party,
					};
				}
			}
		}

		// 1.72.0 (assault fix): equipment with the 强袭/ASSAULT modifier fires extra
		// projectiles from the engine's shared per-element templates
		// (sc.ASSAULT_PROJECTILES[element]) — never one of the player's proxies, so
		// the loop above missed them and EVERY swing logged "Could not find type of
		// ball". Identify by template identity and relay as 'assault:<elementKey>';
		// the receiver spawns the same template (see onThrowBall).
		const assault: any = (sc as any).ASSAULT_PROJECTILES;
		if (assault && settings.ballInfo) {
			for (const el in assault) {
				if (Object.prototype.hasOwnProperty.call(assault, el) && assault[el] === settings.ballInfo) {
					return {
						ballInfo: 'assault:' + el,
						combatant:
							settings.combatant === null
								? null
								: (settings.combatant as IMultiplayerEntity).multiplayerId,
						dir: settings.dir,
						party: settings.party,
					};
				}
			}
		}

		// 1.72.0 (dungeon-key fix): standing on an active KeyPanel swaps the
		// charged shot for the panel's key BallInfo via playerEntity.overrideBall
		// (the 'DUNGEON_KEY'/'DUNGEON_MASTER_KEY' hinted ball — the mine/temple
		// key throw). It is never a player proxy, so every key throw logged
		// 'filterBall returned null' and teammates saw nothing. Match the live
		// override by identity; the receiver resolves a local KeyPanel's
		// spawner (onThrowBall 'key:' branch) so the relayed key keeps its real
		// visuals AND its panel/wall-unlock behaviour.
		const playerEnt: any = ig.game.playerEntity;
		const overrideBall: any = playerEnt && playerEnt.overrideBall;
		if (overrideBall && overrideBall.data === settings.ballInfo) {
			let kind = 'regular';
			try {
				const hints: any = settings.ballInfo.attack && settings.ballInfo.attack.hints;
				if (hints && hints.indexOf('DUNGEON_MASTER_KEY') !== -1) kind = 'master';
			} catch (_) { /* default to regular */ }
			return {
				ballInfo: 'key:' + kind,
				combatant:
					settings.combatant === null
						? null
						: (settings.combatant as IMultiplayerEntity).multiplayerId,
				dir: settings.dir,
				party: settings.party,
			};
		}

		// 1.72.0 (future-proofing): any OTHER unrecognized local ball (inline
		// event proxies, modded spawners, future override types) must never hit
		// this log-and-drop path again. Relay it as 'generic:<defaultProxyName>'
		// — the receiver replays the thrower's default neutral ball as a visual
		// stand-in (remote balls deal no local damage anyway; combat flows via
		// the combatHit relay), so the throw is always visible and the warning
		// below stays reserved for a genuinely broken state (no default proxy).
		const fallback = this.defaultProxyName(player);
		if (fallback) {
			return {
				ballInfo: 'generic:' + fallback,
				combatant:
					settings.combatant === null
						? null
						: (settings.combatant as IMultiplayerEntity).multiplayerId,
				dir: settings.dir,
				party: settings.party,
			};
		}

		return null;
	}

	/** The proxy name of the player's DEFAULT neutral ball — used as the wire
	 * stand-in for ball types we cannot identify (see filterBall's generic
	 * fallback). */
	private defaultProxyName(player: any): string | null {
		try {
			const cfg: any = (sc as any).PlayerConfig;
			if (!cfg || typeof cfg.getElementBall !== 'function') return null;
			const root: any = player && player.getCombatantRoot ? player.getCombatantRoot() : player;
			const def: any = cfg.getElementBall(root, (sc as any).ELEMENT.NEUTRAL, false);
			if (!def) return null;
			const proxies = player.proxies;
			for (const name in proxies) {
				if (Object.prototype.hasOwnProperty.call(proxies, name) && proxies[name] === def) return name;
			}
		} catch (_) { /* ignore */ }
		return null;
	}

	private findEntityType(type: string | typeof ig.Entity): string | undefined {
		if (typeof type === 'string') {
			return type;
		}

		for (const t in ig.ENTITY) {
			if ((ig.ENTITY as any)[t] === type) {
				return t;
			}
		}
	}
}