import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// docs/Official_Extensions_Plan.md, Phase 7: the marker-line delegation pipeline is gone.

test('no source file carries the retired pipeline or its marker', async () => {
  const files = [...(await readdir('src/core')).map(name => `src/core/${name}`), ...(await readdir('src')).filter(name => name.endsWith('.ts')).map(name => `src/${name}`), ...(await readdir('webview')).map(name => `webview/${name}`)];
  assert.ok(!files.some(file => /\/(delegation|autoDelegation)[A-Z][A-Za-z]*\.tsx?$/.test(file)), files.filter(file => /delegation/i.test(file)).join(', '));
  for (const file of files.filter(name => /\.(ts|tsx)$/.test(name))) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /HYDRA_DELEGATION_V1/, file);
    assert.doesNotMatch(text, /setDelegationMode|DelegationModePicker|delegationPreferences\(/, file);
  }
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['hydra.delegationMode'], undefined);
  assert.ok(!manifest.contributes.commands.some((item: { command: string }) => /Delegation/.test(item.command)));
});
