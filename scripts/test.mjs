import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/core.test.ts', 'tests/managed.test.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: '.test-build', outExtension: { '.js': '.cjs' } });
const result = spawnSync(process.execPath, ['--test', '.test-build/core.test.cjs', '.test-build/managed.test.cjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
