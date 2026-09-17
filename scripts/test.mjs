import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({ entryPoints: ['tests/core.test.ts', 'tests/managed.test.ts', 'tests/codex.test.ts', 'tests/review.test.ts', 'tests/reviewCommit.test.ts', 'tests/import.test.ts', 'tests/contextUsage.test.ts', 'tests/modelSelection.test.ts'], bundle: true, platform: 'node', format: 'cjs', outdir: '.test-build', outExtension: { '.js': '.cjs' } });
const result = spawnSync(process.execPath, ['--test', '.test-build/core.test.cjs', '.test-build/managed.test.cjs', '.test-build/codex.test.cjs', '.test-build/review.test.cjs', '.test-build/reviewCommit.test.cjs', '.test-build/import.test.cjs', '.test-build/contextUsage.test.cjs', '.test-build/modelSelection.test.cjs', 'tests/desktop.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
