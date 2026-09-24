import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalStore } from '../src/core/store';

// docs/Official_Extensions_Plan.md, Phase 7: the marker-line delegation pipeline is gone.

test('no source file carries the retired pipeline or its marker, except the legacy transcript filter', async () => {
  const files = [...(await readdir('src/core')).map(name => `src/core/${name}`), ...(await readdir('src')).filter(name => name.endsWith('.ts')).map(name => `src/${name}`), ...(await readdir('webview')).map(name => `webview/${name}`)];
  assert.ok(!files.some(file => /\/(delegation|autoDelegation)[A-Z][A-Za-z]*\.tsx?$/.test(file)), files.filter(file => /delegation/i.test(file)).join(', '));
  for (const file of files.filter(name => /\.(ts|tsx)$/.test(name))) {
    const text = await readFile(file, 'utf8');
    if (file !== 'src/core/plannerSuffix.ts') assert.doesNotMatch(text, /HYDRA_DELEGATION_V1/, file);
    assert.doesNotMatch(text, /setDelegationMode|DelegationModePicker|delegationPreferences\(/, file);
  }
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['hydra.delegationMode'], undefined);
  assert.ok(!manifest.contributes.commands.some((item: { command: string }) => /Delegation/.test(item.command)));
});

test('tasks saved by the retired pipeline load without its fields, and a waiting parent is interrupted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-retired-'));
  try {
    const base = { title: 'T', prompt: 'P', repository: path.resolve('retired-repo'), worktree: path.resolve('retired-wt'), branch: 'agent/t', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'claude', interface: 'managed-cli', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
    const parent = { ...base, id: 'aaaaaaaaaaaa', state: 'idle', sessionId: '12345678-1234-1234-1234-123456789abc', sessionProvider: 'claude', delegationPlanner: { version: 1, state: 'accepted' }, schedule: { state: 'waiting-for-children', dependencies: [], artifacts: [], wakeupKey: 'b'.repeat(64) } };
    const child = { ...base, id: 'cccccccccccc', state: 'idle', delegation: { parentId: 'aaaaaaaaaaaa', runId: 'dddddddddddd', childKey: 'x', dispatchKey: 'e'.repeat(24), dependencies: [] }, delegationExecution: { status: 'stopped' }, verificationEvidence: { version: 1, attempts: [] } };
    await writeFile(path.join(directory, 'tasks.json'), JSON.stringify({ version: 1, tasks: [parent, child] }));
    const [loadedParent, loadedChild] = await new LocalStore(directory).load();
    for (const key of ['delegationPlanner', 'delegation', 'delegationExecution', 'verificationEvidence']) { assert.equal(key in loadedParent!, false, key); assert.equal(key in loadedChild!, false, key); }
    assert.equal(loadedParent!.schedule?.state, 'interrupted');
    assert.match(loadedParent!.schedule?.reason || '', /retired/);
    assert.equal('wakeupKey' in loadedParent!.schedule!, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
