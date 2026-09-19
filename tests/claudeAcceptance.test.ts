import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hydra-claude-acceptance-'));
  const cli = path.join(directory, 'fixture.cjs');
  await writeFile(cli, `const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(directory, 'calls.jsonl'))},JSON.stringify(args)+'\\n');if(args[0]==='--version'){console.log('2.1.270 (Claude Code)');process.exit(0)}process.exit(17);`);
  return { directory, cli };
}
test('fixture acceptance uses only the documented version probe and never submits a turn', async () => {
  const f = await fixture(); const evidence = path.join(f.directory, 'evidence.json');
  try {
    const wrapper = path.join(f.directory, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    if (process.platform === 'win32') await writeFile(wrapper, `@echo off\r\n"${process.execPath}" "${f.cli}" %*\r\n`);
    else await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${f.cli.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    await execute(process.execPath, [path.join(root, 'scripts', 'claude-acceptance.mjs'), '--fixture', '--executable', wrapper, '--evidence', evidence, '--cancel-after-version'], { cwd: f.directory, windowsHide: true });
    const record = JSON.parse(await readFile(evidence, 'utf8'));
    assert.deepEqual(record.commands.map((item: { action: string }) => item.action), ['version']);
    assert.deepEqual(record.commands.map((item: { args: string[] }) => item.args), [['--version']]);
    assert.equal(record.cancellation, 'cancelled-before-any-managed-turn');
    assert.equal(record.turn, 'not-submitted-fixture');
    assert.deepEqual(record.account, { status: 'not-probed', authentication: 'unverified', acceptance: 'human-operated-provider-integration-required' });
    assert.ok(record.checks.every((item: { status: string }) => item.status === 'fixture-covered'));
    const calls = (await readFile(path.join(f.directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(calls, [['--version']]);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
test('runner refuses live-looking turn arguments, undocumented account status, and evidence replacement', async () => {
  const f = await fixture(); const evidence = path.join(f.directory, 'evidence.json');
  try {
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts', 'claude-acceptance.mjs'), '--fixture', '--evidence', evidence, '--prompt', 'real turn']), /Unsupported argument/);
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts', 'claude-acceptance.mjs'), '--fixture', '--evidence', evidence, '--overwrite']), /Unsupported argument/);
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts', 'claude-acceptance.mjs'), '--fixture', '--evidence', evidence, '--cancel-after-status']), /Unsupported argument/);
    await writeFile(evidence, '{}');
    await assert.rejects(execute(process.execPath, [path.join(root, 'scripts', 'claude-acceptance.mjs'), '--fixture', '--evidence', evidence]), /EEXIST/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
