/**
 * An enemy entity that is driven by the network rather than by its own AI.
 *
 * The CCLoader v2 build declared this as `interface IMultiplayerEntity
 * extends ig.ENTITY.Enemy`, redeclaring `target` as the broader `ig.Entity`.
 * CrossCode 1.4.x narrows `Enemy.target` to `sc.BasicCombatant`, which made
 * the widening illegal under `strict`. We now keep the game's narrower type
 * and use an intersection to bolt on the multiplayer bookkeeping fields.
 */
export type IMultiplayerEntity = ig.ENTITY.Enemy & {
	multiplayerId: number;
	lastTarget: ig.Entity | null;
	lastPosition: Vec3 | null;
	proxies?: {[name: string]: sc.ProxySpawnerBase} | null;
	settings?: any;
};