import { build } from 'esbuild';
await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: true }),
  build({ entryPoints: ['webview/index.tsx'], bundle: true, platform: 'browser', format: 'iife', target: 'es2022', outfile: 'dist/webview.js', minify: true }),
  build({ entryPoints: ['tests/smoke.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/smoke.cjs' })
]);
