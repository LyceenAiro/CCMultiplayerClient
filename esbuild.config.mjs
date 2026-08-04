import * as esbuild from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

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

// Ship the runtime assets (enemy definition + default server config) next to
// the compiled module so CCLoader3 picks them up as mod assets. The repo keeps
// game assets under `assets/assets/` and the server config under
// `assets/config/`.
function copyAssets() {
	mkdirSync('dist', { recursive: true });
	cpSync('assets/assets/data', 'dist/data', { recursive: true });
	cpSync('assets/config', 'dist/config', { recursive: true });
}

copyAssets();

if (watch) {
	const ctx = await esbuild.context(buildOptions);
	await ctx.watch();
	console.log('[multiplayer] watching for changes...');
} else {
	await esbuild.build(buildOptions);
}
