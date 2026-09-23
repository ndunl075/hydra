import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/core/model';
import { claudeArguments } from '../src/core/claudeProtocol';
import { validateCodexThread, testedCodexVersion } from '../src/core/codexProtocol';
import {
  claudeInitMatches, claudePermissionArgument, claudePermissionModes, codexPermissionModes, codexSandboxPolicy,
  codexThreadMatches, codexThreadPolicy, defaultPermissionMode, parsePermissionMode, parseSubmittedPermissionMode,
  permissionModeLabel, permissionModeWrites, refusedPermissionModes, type TaskPermissionMode
} from '../src/core/permissionMode';

const id = '111111111111';
const claude = (mode: string) => ({ provider: 'claude', mode }) as TaskPermissionMode;
const codex = (mode: string) => ({ provider: 'codex', mode }) as TaskPermissionMode;

test('each provider exposes exactly its own three permission mode names', () => {
  assert.deepEqual([...claudePermissionModes], ['default', 'plan', 'auto']);
  assert.deepEqual([...codexPermissionModes], ['on-request/workspace-write', 'on-request/read-only', 'never/workspace-write']);
  assert.deepEqual(defaultPermissionMode('claude'), { provider: 'claude', mode: 'default' });
  assert.deepEqual(defaultPermissionMode('codex'), { provider: 'codex', mode: 'on-request/workspace-write' });
  // A mode name belongs to one provider; it cannot be saved onto the other.
  for (const mode of claudePermissionModes) assert.throws(() => parsePermissionMode({ provider: 'claude', mode }, 'codex'), /cannot take a claude permission mode/);
  for (const mode of codexPermissionModes) assert.throws(() => parsePermissionMode({ provider: 'codex', mode }, 'claude'), /cannot take a codex permission mode/);
  assert.throws(() => parsePermissionMode({ provider: 'claude', mode: 'on-request/read-only' }, 'claude'), /Unsupported claude permission mode/);
  assert.throws(() => parsePermissionMode({ provider: 'codex', mode: 'plan' }, 'codex'), /Unsupported codex permission mode/);
  for (const value of [null, undefined, 'plan', [], { provider: 'claude' }]) assert.throws(() => parseSubmittedPermissionMode(value));
});

test('containment-breaking and unmodelled provider modes are refused by name with a reason', () => {
  for (const [mode, reason] of refusedPermissionModes) {
    assert.match(reason, /\S/);
    for (const provider of ['claude', 'codex'] as const) {
      assert.throws(() => parsePermissionMode({ provider, mode }, provider), new RegExp(`Hydra does not run ${mode}`));
    }
  }
  // The two that remove worktree containment must never become selectable.
  for (const mode of ['bypassPermissions', 'danger-full-access']) assert.ok(refusedPermissionModes.has(mode));
  assert.ok(!([...claudePermissionModes] as string[]).includes('bypassPermissions'));
  assert.ok(!([...codexPermissionModes] as string[]).some(mode => mode.includes('danger-full-access')));
});

test('only the read-only modes are reported as producing no file changes', () => {
  assert.equal(permissionModeWrites(claude('plan')), false);
  assert.equal(permissionModeWrites(codex('on-request/read-only')), false);
  for (const mode of [claude('default'), claude('auto'), codex('on-request/workspace-write'), codex('never/workspace-write')]) assert.equal(permissionModeWrites(mode), true);
  assert.equal(permissionModeLabel(claude('plan')), 'plan');
  assert.equal(permissionModeLabel(codex('never/workspace-write')), 'never · workspace-write');
});

test('Claude launches with the requested mode and rejects an initialization that does not echo it', () => {
  for (const mode of claudePermissionModes) {
    const args = claudeArguments(undefined, undefined, claude(mode));
    assert.equal(args[args.indexOf('--permission-mode') + 1], mode);
    assert.equal(claudePermissionArgument(claude(mode)), mode);
    assert.equal(claudeInitMatches(claude(mode), mode), true);
  }
  // Omitting a mode keeps today's behaviour: default, with host prompts.
  const fallback = claudeArguments();
  assert.equal(fallback[fallback.indexOf('--permission-mode') + 1], 'default');
  assert.equal(fallback[fallback.indexOf('--permission-prompts') + 1], 'host');
  // `manual` is the host-prompt alias for default only; plan and auto must echo exactly,
  // so a silent escalation or downgrade of the request fails the launch.
  assert.equal(claudeInitMatches(claude('default'), 'manual'), true);
  assert.equal(claudeInitMatches(claude('plan'), 'manual'), false);
  assert.equal(claudeInitMatches(claude('auto'), 'manual'), false);
  assert.equal(claudeInitMatches(claude('plan'), 'default'), false);
  assert.equal(claudeInitMatches(claude('default'), 'bypassPermissions'), false);
  assert.equal(claudeInitMatches(claude('default'), 'plan'), false);
  assert.throws(() => claudePermissionArgument(codex('never/workspace-write')), /Claude cannot launch with a Codex permission mode/);
});

test('Codex maps each mode onto its own approval policy and sandbox, and verifies the echo', () => {
  assert.deepEqual(codexThreadPolicy(codex('on-request/workspace-write')), { approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.deepEqual(codexThreadPolicy(codex('on-request/read-only')), { approvalPolicy: 'on-request', sandbox: 'read-only' });
  assert.deepEqual(codexThreadPolicy(codex('never/workspace-write')), { approvalPolicy: 'never', sandbox: 'workspace-write' });
  // Read-only forbids network access too, so a planning turn cannot reach out.
  assert.deepEqual(codexSandboxPolicy(codex('on-request/read-only'), '/w'), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(codexSandboxPolicy(codex('never/workspace-write'), '/w'), { type: 'workspaceWrite', writableRoots: ['/w'], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true });
  // Codex echoes the sandbox as a camelCase policy type, not the request value.
  assert.equal(codexThreadMatches(codex('on-request/read-only'), 'readOnly', 'on-request'), true);
  assert.equal(codexThreadMatches(codex('on-request/read-only'), 'workspaceWrite', 'on-request'), false);
  assert.equal(codexThreadMatches(codex('never/workspace-write'), 'workspaceWrite', 'never'), true);
  assert.equal(codexThreadMatches(codex('never/workspace-write'), 'workspaceWrite', 'on-request'), false);
  assert.equal(codexThreadMatches(codex('on-request/workspace-write'), 'dangerFullAccess', 'on-request'), false);
  assert.throws(() => codexThreadPolicy(claude('plan')), /Codex cannot start a thread with a Claude permission mode/);
});

test('a Codex thread that widens the sandbox or drops approvals is refused', () => {
  const threadId = '11111111-2222-3333-4444-555555555555';
  const thread = (sandbox: string, approvalPolicy: string) => ({
    cwd: '/w', sandbox: { type: sandbox }, approvalPolicy, thread: { id: threadId, cwd: '/w', cliVersion: testedCodexVersion }
  });
  assert.equal(validateCodexThread(thread('readOnly', 'on-request'), '/w', undefined, codex('on-request/read-only')), threadId);
  assert.equal(validateCodexThread(thread('workspaceWrite', 'on-request'), '/w'), threadId);
  // A granted sandbox wider than the request, or approvals silently dropped.
  assert.throws(() => validateCodexThread(thread('dangerFullAccess', 'on-request'), '/w', undefined, codex('on-request/workspace-write')), /instead of the requested/);
  assert.throws(() => validateCodexThread(thread('workspaceWrite', 'never'), '/w', undefined, codex('on-request/workspace-write')), /instead of the requested/);
  assert.throws(() => validateCodexThread(thread('workspaceWrite', 'on-request'), '/w', undefined, codex('on-request/read-only')), /instead of the requested/);
});

test('permission modes are saved before launch, never passed as a launch-time field', () => {
  assert.deepEqual(parseMessage({ type: 'savePermissionMode', id, permissionMode: { provider: 'claude', mode: 'plan' } }), { type: 'savePermissionMode', id, permissionMode: { provider: 'claude', mode: 'plan' } });
  assert.deepEqual(parseMessage({ type: 'savePermissionMode', id, permissionMode: null }), { type: 'savePermissionMode', id, permissionMode: null });
  assert.throws(() => parseMessage({ type: 'savePermissionMode', id, permissionMode: { provider: 'claude', mode: 'bypassPermissions' } }), /Hydra does not run bypassPermissions/);
  assert.throws(() => parseMessage({ type: 'savePermissionMode', id: 'nope', permissionMode: null }), /Invalid task ID/);
  for (const type of ['create', 'draft', 'startManaged', 'followUp', 'saveBrief']) {
    for (const key of ['permissionMode', 'permission_mode', 'approvalPolicy', 'sandbox', 'sandboxPolicy']) {
      assert.throws(() => parseMessage({ type, id, [key]: 'plan' }), /Direct launch-time permission fields are unsupported/);
    }
  }
});
