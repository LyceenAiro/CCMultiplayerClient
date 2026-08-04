/**
 * Type declarations for the subset of the Simplify companion library that this
 * mod uses. Simplify ships with CCLoader v2 (under `assets/mods/simplify`) and
 * exposes a global `simplify` object. The game's bundled typings do not cover
 * it, so we declare just the surface we rely on.
 */
declare const simplify: Simplify;

interface SimplifyMod {
	name: string;
	baseDirectory: string;
	[key: string]: unknown;
}

interface Simplify {
	/** Registers a callback fired once per game tick. */
	registerUpdate(handler: () => void): void;
	fireUpdate(): void;

	/** Loads an external <script> by URL; resolves when it has loaded. */
	loadScript(url: string): Promise<void>;

	/** Looks up an enabled mod by its (lowercase) manifest name. */
	getMod(name: string): SimplifyMod | undefined;

	resources: {
		/** Loads and JSON-parses a file, invoking the callback with the result. */
		loadJSON(path: string, callback: (data: any) => void, errorCallback?: (err: unknown) => void): void;
	};
}
