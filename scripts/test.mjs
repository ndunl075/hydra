import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/core.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: '.test-build/core.test.cjs' });
const result = spawnSync(process.execPath, ['--test', '.test-build/core.test.cjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
