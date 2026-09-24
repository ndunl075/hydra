import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { autoDelegationAvailable, parseDelegationPreferences } from '../src/core/delegationPreferences';

const source = (file: string) => readFile(file, 'utf8');

test('Auto delegation is paused: a saved "auto" behaves as Solo and Solo turns carry no planner suffix', async () => {
  assert.equal(autoDelegationAvailable, false);
  // A saved value still parses (so settings never error), but the host overrides it.
  assert.equal(parseDelegationPreferences({ mode: 'auto' }).mode, 'auto');
  const extension = await source('src/extension.ts');
  assert.match(extension, /return autoDelegationAvailable \? preferences : \{ \.\.\.preferences, mode: 'solo' \};/);
  assert.match(extension, /if \(mode === 'auto' && !autoDelegationAvailable\) throw new Error\(autoDelegationPausedReason\);/);
  assert.match(extension, /const planner = task\.delegation \|\| preferences\.mode === 'solo' \? undefined : createDelegationPlannerRun\(/);
});

test('no surface offers Auto while it is paused', async () => {
  for (const file of ['webview/SessionThread.tsx', 'webview/EditorConversation.tsx', 'webview/ComposerPickers.tsx', 'webview/index.tsx']) {
    const text = await source(file);
    assert.doesNotMatch(text, /DelegationModePicker/, file);
    assert.doesNotMatch(text, /setDelegationMode', mode: 'auto'/, file);
  }
  const manifest = JSON.parse(await source('package.json'));
  assert.match(manifest.contributes.configuration.properties['hydra.delegationMode'].deprecationMessage, /paused/);
});
