import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

// Build the in-game mod as a single classic script that CCLoader v2 loads via
// its `main` manifest entry. IIFE format (not ESM) because v2 executes `main`
// scripts as plain <script> tags, not as modules. socket.io-client is bundled
// in, so the mod no longer needs to fetch the client library from the server.
const buildOptions = {
	entryPoints: ['src/main.ts'],
	bundle: true,
	format: 'iife',
	platform: 'browser',
	target: 'es2019',
	outfile: 'dist/mod.js',
	sourcemap: true,
	logLevel: 'info',
};

// NOTE: we deliberately do NOT copy assets into dist/. CCLoader v2 discovers a
// mod's game assets by scanning `<modRoot>/assets/`, and this repo already keeps
// them in the right place (`assets/assets/data/...` -> game path
// `data/enemies/multiplayer.json`, and `assets/config/config.json` -> the
// runtime config the code reads at `<modRoot>/config/config.json`). Only the
// compiled JS belongs in dist/.

if (watch) {
	const ctx = await esbuild.context(buildOptions);
	await ctx.watch();
	console.log('[multiplayer] watching for changes...');
} else {
	await esbuild.build(buildOptions);
}
