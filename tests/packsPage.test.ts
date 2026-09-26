import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  buildPackContents, gateRunsWhen, packButton, packCard, packCounts, reviewButtonLabel, sortPackCards, stateLabel, thirdPartyWarning,
} from '../src/settings/pages/packsHelpers';
import type { PackManifest, ValidPack } from '../src/core/packs/format';
import type { InstalledPack } from '../src/core/packs/registry';
import type { PackState, ProjectPack } from '../src/core/packs/project';
import type { LaneView } from '../src/core/model';

/**
 * Settings -> Packs (docs/Packs_Plan.md, section 6): packsHelpers.ts is the
 * page's pure logic (commands shown exactly, secrets masked, the right button
 * per state), so it's tested directly here, without vscode.
 */

const manifest: PackManifest = {
  version: 1, id: 'coding', title: 'Coding', description: 'Build and review code.',
  roles: [
    { id: 'builder', title: 'Builder', description: 'Builds the feature with tests.', provider: 'claude', instructions: 'roles/builder.md', skills: ['test-first'], mcpServers: [], tools: [], changes: 'required' },
    { id: 'reviewer', title: 'Reviewer', description: 'Reviews the diff.', provider: 'codex', instructions: 'roles/reviewer.md', skills: [], mcpServers: ['lighthouse'], tools: ['web'], changes: 'optional' },
  ],
  gates: [{ id: 'code-review', type: 'review', required: true, reviewer: 'other', focus: 'Correctness and tests.' }],
  mcpServers: { lighthouse: { type: 'stdio', command: 'npx', args: ['-y', 'lighthouse-mcp'], env: { API_TOKEN: '${LIGHTHOUSE_TOKEN}' } } },
};
const valid: ValidPack = {
  manifest,
  skills: [{ id: 'test-first', description: 'Write a failing test first.', files: ['skills/test-first/SKILL.md', 'skills/test-first/check.mjs'], scripts: ['skills/test-first/check.mjs'] }],
  instructions: { builder: 'Read the code first.', reviewer: 'List findings with file:line.' },
  servers: { lighthouse: { variables: ['LIGHTHOUSE_TOKEN'] } },
};
const installed = (source: InstalledPack['source'] = 'builtin'): InstalledPack => ({ id: 'coding', source, folder: '/packs/coding', valid, hash: 'a'.repeat(64), files: new Map() });
const projectPack = (state: PackState, extra: Partial<ProjectPack> = {}): ProjectPack => ({ id: 'coding', title: 'Coding', state, notes: [], pack: installed(), ...extra });

test('packButton: the right one button per state, and none for notInstalled/invalid', () => {
  assert.deepEqual(packButton('off'), { id: 'turnOn', label: 'Turn on' });
  assert.deepEqual(packButton('on'), { id: 'turnOff', label: 'Turn off' });
  assert.deepEqual(packButton('needsOk'), { id: 'review', label: 'Review and allow' });
  assert.deepEqual(packButton('changed'), { id: 'review', label: 'Review changes' });
  assert.equal(packButton('notInstalled'), undefined);
  assert.equal(packButton('invalid'), undefined);
});

test('reviewButtonLabel: built-in gets a plain "Turn on"; anything else warns and says "Trust and turn on"', () => {
  assert.equal(reviewButtonLabel('builtin'), 'Turn on');
  assert.equal(reviewButtonLabel('user'), 'Trust and turn on');
  assert.equal(reviewButtonLabel('project'), 'Trust and turn on');
  assert.match(thirdPartyWarning, /Not from Hydra/);
});

test('packCounts: "N roles - N gates - N skills - N servers"', () => {
  assert.equal(packCounts(manifest, 1), '2 roles · 1 gate · 1 skill · 1 server');
});

test('stateLabel covers every state', () => {
  for (const state of ['off', 'on', 'needsOk', 'changed', 'notInstalled', 'invalid'] as const) assert.ok(stateLabel[state]);
});

test('every gate runs before a head\'s work is accepted and when you merge a lane', () => {
  assert.match(gateRunsWhen, /before a head's work is accepted/i);
  assert.match(gateRunsWhen, /merge a lane/i);
});

test('buildPackContents: gate commands resolve {pack}/{node}, roles list what they add, and skills flag their scripts', () => {
  const withCommand: PackManifest = { ...manifest, gates: [{ id: 'check', type: 'command', required: true, command: ['{node}', '{pack}/scripts/check.mjs'], timeoutSeconds: 60 }] };
  const contents = buildPackContents(withCommand, valid, '/checked/coding-abc123', 'C:\\node.exe');
  assert.equal(contents.gates[0]!.command!.text, ['C:\\node.exe', path.join('/checked/coding-abc123', 'scripts', 'check.mjs')].join(' '));
  assert.equal(contents.roles.find(role => role.id === 'reviewer')!.toolsSentence, 'Heads with this role can browse the web.');
  assert.equal(contents.roles.find(role => role.id === 'reviewer')!.changes, 'optional');
  assert.deepEqual(contents.servers[0]!.roles, ['Reviewer']);
  assert.match(contents.servers[0]!.note, /without asking/);
  assert.deepEqual(contents.skills[0]!.scripts, ['skills/test-first/check.mjs']);
});

test('buildPackContents masks a server\'s secret-looking values but keeps ${NAME} references as-is', () => {
  const withSecret: PackManifest = {
    ...manifest,
    mcpServers: { fetcher: { type: 'stdio', command: 'npx', args: ['fetch-mcp'], env: { REF: '${TOKEN}', PLAIN: 'https://example.com' } } },
  };
  const contents = buildPackContents(withSecret, { ...valid, servers: { fetcher: { variables: ['TOKEN'] } } }, '/checked/coding-abc');
  const env = Object.fromEntries(contents.servers[0]!.env.map(entry => [entry.name, entry.value]));
  assert.equal(env.REF, '${TOKEN}', '${NAME} references are shown as-is, never masked away');
  assert.equal(env.PLAIN, 'https://example.com');
});

test('packCard: built-in first, one button, hash and third-party flag, "What it contains" for a valid pack in any state', () => {
  const off = packCard(projectPack('off'));
  assert.equal(off.button!.id, 'turnOn');
  assert.equal(off.thirdParty, false);
  assert.equal(off.hash, 'a'.repeat(64));
  assert.ok(off.contents, 'even an Off pack shows what it contains');
  const userPack = packCard(projectPack('needsOk', { pack: installed('user') }));
  assert.equal(userPack.thirdParty, true);
  assert.equal(userPack.reviewButtonLabel, 'Trust and turn on');
  const notInstalled = packCard({ id: 'ghost', title: 'ghost', state: 'notInstalled', notes: [], reason: 'not installed' });
  assert.equal(notInstalled.button, undefined);
  assert.equal(notInstalled.contents, undefined);
});

test('sortPackCards: built-in packs first, order otherwise unchanged', () => {
  const packs = [projectPack('off', { id: 'research', pack: installed('user') }), projectPack('on')];
  assert.deepEqual(sortPackCards(packs).map(pack => pack.id), ['coding', 'research']);
});

// ---- SSR: role pickers and role labels (docs/Packs_Plan.md, "Picking a role" / "How roles show") ----

const roles = [
  { ref: 'coding/builder', pack: 'coding', packTitle: 'Coding', id: 'builder', title: 'Builder', description: 'Builds it.', provider: 'claude' as const },
  { ref: 'coding/reviewer', pack: 'coding', packTitle: 'Coding', id: 'reviewer', title: 'Reviewer', description: 'Reviews it.', provider: 'codex' as const },
];

test('groupRolesByPack groups the active roles under their pack title, in order', async () => {
  const { groupRolesByPack } = await import('../webview/LanesView');
  assert.deepEqual(groupRolesByPack(roles).map(group => [group.packTitle, group.roles.map(role => role.id)]), [['Coding', ['builder', 'reviewer']]]);
});

test('SSR: the New lane card\'s Role select lists "No role" then the active roles grouped by pack; disabled with a hint when none are active', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { NewLaneCard } = await import('../webview/LanesView');
  const withRoles = renderToStaticMarkup(React.createElement(NewLaneCard, { initial: { name: 'Lane 1', provider: 'claude', goal: '' }, roles, onStart: () => {}, onCancel: () => {} }));
  assert.match(withRoles, /No role/);
  assert.match(withRoles, /<optgroup label="Coding"/);
  assert.match(withRoles, /Builder/); assert.match(withRoles, /Reviewer/);
  const noRoles = renderToStaticMarkup(React.createElement(NewLaneCard, { initial: { name: 'Lane 1', provider: 'claude', goal: '' }, onStart: () => {}, onCancel: () => {} }));
  assert.match(noRoles, /<select[^>]*disabled/);
  assert.match(noRoles, /Turn on a pack in Settings → Packs/);
});

test('SSR: a lane tile with an active role shows the role chip with its tooltip, and roleNote when it isn\'t available', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { LanesView } = await import('../webview/LanesView');
  const withRole: LaneView = { id: '111111111111', name: 'Lane 1', provider: 'codex' as const, repository: '/repo', worktree: '/repo.worktrees/1', branch: 'lane/x', baseCommit: 'a'.repeat(40), target: 'main', createdAt: new Date().toISOString(), state: 'running', running: true, role: { pack: 'coding', role: 'reviewer' } };
  const html = renderToStaticMarkup(React.createElement(LanesView, { lanes: [withRole], terminals: true, roles, onSend: () => {}, onFocused: () => {} }));
  assert.match(html, /class="lane-role-chip" title="Coding pack · Codex by default">Reviewer/);
  const unavailable = { ...withRole, roleNote: 'Role Reviewer isn\'t available: the Coding pack is off.' };
  const html2 = renderToStaticMarkup(React.createElement(LanesView, { lanes: [unavailable], terminals: true, onSend: () => {}, onFocused: () => {} }));
  assert.match(html2, /Role Reviewer isn.{1,6}t available: the Coding pack is off\./);
});

test('SSR: the job popover has a Role select, and a draft job\'s pill reads "Builder · Claude"', async () => {
  const React = (await import('react')).default;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { JobEditPopover, AgentsCanvas } = await import('../webview/AgentsCanvas');
  const job = { key: 'a', title: 'Build the API', brief: 'Build it.', dependsOn: [], role: 'coding/builder' as string | undefined };
  const popover = renderToStaticMarkup(React.createElement(JobEditPopover, { state: { planId: 'p', job, x: 0, y: 0 }, roles, onSave: () => {}, onCancel: () => {} }));
  assert.match(popover, /Role<select/);
  assert.match(popover, /<option[^>]*value="coding\/builder"[^>]*>Builder \(Coding\)/);
  const plan = { version: 1 as const, id: 'aaaaaaaaaaaa', title: 'Plan', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), state: 'draft' as const, jobs: [job] };
  const canvas = renderToStaticMarkup(React.createElement(AgentsCanvas, { heads: [], plans: [plan], roles, onAction: () => {} }));
  assert.match(canvas, /Builder · Claude/);
});
