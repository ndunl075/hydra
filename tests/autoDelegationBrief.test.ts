import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAutoDelegationBriefFresh, dispatchAutoDelegationBrief, prepareAutoDelegationBrief, type AutoDelegationBriefAuthority, type AutoDelegationSourceReceipt } from '../src/core/autoDelegationBrief';
import { digest } from '../src/core/delegationContext';

const base = 'a'.repeat(40);
const validReceipt = 'host-signed:parser-source';
const hostAuthority: AutoDelegationBriefAuthority = {
  verifySourceReceipt(receipt: AutoDelegationSourceReceipt): boolean {
    return receipt.id === 'parser-source' && receipt.approvalReceipt === validReceipt;
  }
};
const input = () => ({
  child: {
    parentId: '123456789abc', runId: 'abcdef123456', key: 'parser', goal: 'Implement the parser contract', deliverable: 'A reviewed commit and evidence',
    baseCommit: base, writeScope: ['src/parser.ts'], dependencies: ['contract'], acceptance: ['Focused regression passes'], testCommands: ['npm.cmd test -- autoDelegationBrief'], provider: 'codex' as const
  },
  context: {
    userIntent: 'Preserve the active Editor work', qualityTarget: 'A reviewable parser change', constraints: ['Address Nico in every response.', 'Do not edit another owner\'s files.'],
    instructions: [{ id: 'agents', path: 'AGENTS.md', revision: base, content: 'Apply repository instructions.', reason: 'Repository constraints.' }],
    interfaces: [{ id: 'parser-contract', path: 'docs/parser.md', revision: base, content: 'Return a validated record.', reason: 'Agreed shared contract.' }],
    evidence: [
      { id: 'parser-source', path: 'src/parser.ts', revision: base, content: 'export function parse() {}', reason: 'Relevant implementation.' },
      { id: 'sibling-history', path: 'notes/sibling.md', revision: base, content: 'UNRELATED_SIBLING_TRANSCRIPT', reason: 'Not selected.' }
    ],
    maxTurns: 2, timeoutMs: 300000
  },
  selectedSources: [{ version: 1 as const, id: 'parser-source', path: 'src/parser.ts', revision: base, sha256: digest('export function parse() {}'), kind: 'repository-excerpt' as const, approvalReceipt: validReceipt }],
});

function current(brief: ReturnType<typeof prepareAutoDelegationBrief>) {
  return Object.fromEntries([...brief.manifest.instructions, ...brief.manifest.interfaces, ...brief.manifest.evidence].map(source => [source.id, { revision: source.revision, sha256: source.sha256 }]));
}

test('brief is deterministic, keeps required dispatch facts, and includes selected evidence only', () => {
  const first = prepareAutoDelegationBrief(input(), hostAuthority), second = prepareAutoDelegationBrief(input(), hostAuthority);
  assert.deepEqual(second, first);
  assert.deepEqual(first.display, { parentId: '123456789abc', runId: 'abcdef123456', childKey: 'parser', goal: 'Implement the parser contract', baseCommit: base, writeScope: ['src/parser.ts'], dependencies: ['contract'], acceptance: ['Focused regression passes'] });
  assert.ok(first.manifest.prompt.includes('Address Nico in every response.'));
  assert.ok(first.manifest.prompt.includes(base));
  assert.ok(first.manifest.prompt.includes('Focused regression passes'));
  assert.ok(!first.manifest.prompt.includes('UNRELATED_SIBLING_TRANSCRIPT'));
  assert.equal(dispatchAutoDelegationBrief(first, current(first), hostAuthority), first.manifest.prompt);
});

test('neutral transcript and secret-like evidence cannot bypass host-verified provenance', () => {
  const request = input(); request.context.evidence = [{ id: 'meeting-notes', path: 'notes/meeting.md', revision: base, content: 'q9Z1xM8r2K6f7L4p', reason: 'Model requested it.' }];
  request.selectedSources = [{ version: 1, id: 'meeting-notes', path: 'notes/meeting.md', revision: base, sha256: digest('q9Z1xM8r2K6f7L4p'), kind: 'repository-excerpt', approvalReceipt: 'model-claims-approved' }];
  assert.throws(() => prepareAutoDelegationBrief(request, hostAuthority), /not verified by host authority/);
  const mismatched = input(); mismatched.selectedSources[0]!.sha256 = 'b'.repeat(64);
  assert.throws(() => prepareAutoDelegationBrief(mismatched, hostAuthority), /does not match selected evidence/);
  const withTranscript = { ...input(), transcript: 'full parent transcript' } as unknown as Parameters<typeof prepareAutoDelegationBrief>[0];
  assert.deepEqual(prepareAutoDelegationBrief(withTranscript, hostAuthority), prepareAutoDelegationBrief(input(), hostAuthority));
});

test('a forged positive receipt cannot self-authorize without host verification', () => {
  const forged = input();
  forged.selectedSources[0]!.approvalReceipt = 'approved:true';
  assert.throws(() => prepareAutoDelegationBrief(forged, hostAuthority), /not verified by host authority/);
  const brief = prepareAutoDelegationBrief(input(), hostAuthority);
  const rejectingHost: AutoDelegationBriefAuthority = { verifySourceReceipt: () => false };
  assert.throws(() => dispatchAutoDelegationBrief(brief, current(brief), rejectingHost), /not verified by host authority/);
});

test('secret values and oversized mandatory content refuse instead of redacting or truncating requirements', () => {
  const secret = input(); secret.context.constraints = ['Authorization: Bearer secret-value-that-must-not-enter-a-child-brief'];
  assert.throws(() => prepareAutoDelegationBrief(secret, hostAuthority), /secret value/);
  const oversized = input(); oversized.context.constraints = ['x'.repeat(8000), 'y'.repeat(8000), 'z'.repeat(8000), 'q'.repeat(8000)];
  assert.throws(() => prepareAutoDelegationBrief(oversized, hostAuthority), /32,000/);
});

test('dispatch freshness refuses changed source revisions and mutated sealed briefs', () => {
  const brief = prepareAutoDelegationBrief(input(), hostAuthority), observed = current(brief);
  observed['parser-source']!.revision = 'b'.repeat(40);
  assert.throws(() => dispatchAutoDelegationBrief(brief, observed, hostAuthority), /changed or is unavailable/);
  const clean = prepareAutoDelegationBrief(input(), hostAuthority); clean.display.acceptance.push('mutated');
  assert.throws(() => assertAutoDelegationBriefFresh(clean, current(clean), hostAuthority), /brief changed/);
});
