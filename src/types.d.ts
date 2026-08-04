/**
 * Shared minimal vector shapes.
 *
 * The game exposes vector types under `ig` (`ig.Vector2`, `ig.Vector3`), but
 * these are only used loosely across the network boundary (plain `{x, y, z}`
 * objects). Declaring tiny local interfaces keeps the protocol types decoupled
 * from whatever the concrete game types happen to be in a given version.
 */
declare global {
	interface Vec2 {
		x: number;
		y: number;
	}

	interface Vec3 {
		x: number;
		y: number;
		z: number;
	}
}

export {};
