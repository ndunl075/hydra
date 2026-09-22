import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
// The webview may only load resources from dist/, so the mark ships beside the bundle.
await mkdir('dist', { recursive: true });
await copyFile('hydra-logo.png', 'dist/hydra-logo.png');
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: true }),
  build({ entryPoints: ['webview/index.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/webview.js', minify: true }),
  build({ entryPoints: ['tests/smoke.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/smoke.cjs' })
]);
