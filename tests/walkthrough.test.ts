import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

/**
 * The "Work with Hydra" walkthrough (docs/Lanes_And_Planner_Plan.md, "A
 * walkthrough"): its package.json contribution, media files, and the
 * commands its steps link to, all checked statically so a broken media path
 * or a renamed command fails a fast test instead of a blank walkthrough step.
 */
test('the hydra.workWithHydra walkthrough has five steps, each with existing media and only known commands', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const commandIds = new Set((manifest.contributes.commands as { command: string }[]).map(command => command.command));
  const walkthrough = (manifest.contributes.walkthroughs as { id: string; title: string; steps: unknown[] }[]).find(item => item.id === 'hydra.workWithHydra');
  assert.ok(walkthrough, 'hydra.workWithHydra is contributed');
  assert.match(walkthrough!.title, /Work with Hydra/);
  assert.equal(walkthrough!.steps.length, 5);
  const stepIds = (walkthrough!.steps as { id: string }[]).map(step => step.id);
  assert.deepEqual(stepIds, ['heads', 'lanes', 'plans', 'gates', 'whichToUse']);
  for (const step of walkthrough!.steps as { title: string; description: string; media: { image: Record<string, string> } }[]) {
    assert.ok(step.title);
    assert.ok(step.description);
    for (const file of Object.values(step.media.image)) await access(file);
    // Every command: (command:...) link in a step's description names a contributed command.
    for (const match of step.description.matchAll(/\(command:([a-zA-Z0-9_.]+)/g)) assert.ok(commandIds.has(match[1]!), `${match[1]} is contributed`);
  }
  const gatesStep = (walkthrough!.steps as { id: string; description: string }[]).find(step => step.id === 'gates')!;
  assert.match(gatesStep.description, /command:hydra\.openSettings\?%5B%22gates%22%5D/, 'Set up gates opens the gates settings page');
  assert.ok(commandIds.has('hydra.learn'), 'hydra.learn is contributed');
  const viewsWelcome = manifest.contributes.viewsWelcome[0].contents as string;
  assert.match(viewsWelcome, /\[Learn how\]\(command:hydra\.learn\)/);
});

test('hydra.learn opens the walkthrough by the extension\'s own publisher and name', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  const extension = await readFile('src/extension.ts', 'utf8');
  assert.match(extension, /workbench\.action\.openWalkthrough.*hydra\.workWithHydra/);
  assert.equal(manifest.publisher, 'nico-dunlap');
  assert.equal(manifest.name, 'hydra-agent-manager');
});
