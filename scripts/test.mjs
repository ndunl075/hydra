import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
const names=(await readdir('tests')).filter(name=>name.endsWith('.test.ts')).sort();
await build({ entryPoints: names.map(name=>'tests/'+name), bundle: true, platform: 'node', format: 'cjs', outdir: '.test-build', outExtension: { '.js': '.cjs' } });
const result = spawnSync(process.execPath, ['--test', ...names.map(name=>'.test-build/'+name.replace(/\.ts$/,'.cjs')), 'tests/desktop.test.mjs'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;