import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewSetupRecipe, setupRecipeDigest, validateSetupRecipe } from '../src/core/setupRecipe';

const recipe = () => ({
  version: 1, taskId: '123456789abc', workspacePath: process.cwd(), port: 4312, database: 'task_recipe', service: 'recipe_service',
  environment: ['NODE_ENV', 'FEATURE_RECIPE'], commands: [{ executable: 'node', args: ['scripts/setup.cjs', '{{HYDRA_TASK_DATABASE}}'] }, { executable: 'npm.cmd', args: ['run', 'prepare'] }], timeoutMs: 120000
});

test('a validated setup recipe previews explicit reservations, environment names and command order', () => {
  const preview = previewSetupRecipe(recipe());
  assert.equal(preview.reservations.length, 3);
  assert.deepEqual(preview.reservations.map(entry => entry.key), ['port:4312', 'database:task_recipe', 'service:recipe_service']);
  assert.deepEqual(preview.environment, [{ name: 'NODE_ENV' }, { name: 'FEATURE_RECIPE' }]);
  assert.deepEqual(preview.commands.map(command => command.order), [1, 2]);
  assert.deepEqual(preview.commands.map(command => command.argumentCount), [2, 2]);
  assert.equal(preview.commands[0]?.timeoutMs, 120000);
  assert.equal(JSON.stringify(preview).includes('secret'), false);
});

test('preview never exposes literal command arguments that may contain secrets', () => {
  const value = recipe();
  value.commands[0]!.args.push('--password=private-value');
  const preview = previewSetupRecipe(value);
  assert.equal(JSON.stringify(preview).includes('private-value'), false);
  assert.equal(preview.commands[0]!.argumentCount, 3);
  assert.notEqual(preview.digest, setupRecipeDigest(recipe()));
});

test('digest is deterministic and changes when reviewed setup changes', () => {
  const first = setupRecipeDigest(recipe());
  assert.equal(first, setupRecipeDigest(structuredClone(recipe())));
  assert.notEqual(first, setupRecipeDigest({ ...recipe(), timeoutMs: 120001 }));
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('ambiguous resources, secret-bearing environment objects, unsafe paths, commands and timeout refuse', () => {
  for (const value of [
    { ...recipe(), database: 'same_name', service: 'same_name' },
    { ...recipe(), environment: ['NODE_ENV', 'NODE_ENV'] },
    { ...recipe(), environment: [{ name: 'TOKEN', value: 'secret' }] },
    { ...recipe(), environment: ['HYDRA_TASK_PORT'] },
    { ...recipe(), workspacePath: 'relative/worktree' },
    { ...recipe(), workspacePath: pathJoin(process.cwd(), '..') },
    { ...recipe(), commands: [{ executable: '', args: [] }] },
    { ...recipe(), commands: [{ executable: 'tool.cmd', args: ['a&b'] }] },
    { ...recipe(), timeoutMs: 999 }
  ]) assert.throws(() => validateSetupRecipe(value));
});

test('validation and preview have no setup side effects', () => {
  const input = recipe();
  const before = JSON.stringify(input);
  const validated = validateSetupRecipe(input);
  const preview = previewSetupRecipe(input);
  assert.equal(JSON.stringify(input), before);
  assert.notEqual(validated.commands, input.commands);
  assert.equal(preview.commands.length, 2);
});

function pathJoin(...parts: string[]): string { return parts.join(process.platform === 'win32' ? '\\' : '/'); }
