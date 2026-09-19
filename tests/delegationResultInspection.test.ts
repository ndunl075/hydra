import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationResultInspection, resultInspectionState, type ResultInspectionIdentity } from '../webview/DelegationResultInspection';
import type { DelegationResultReceipt } from '../src/core/delegationResults';
import type { FocusedVerification } from '../src/core/focusedWorkspace';

const identity: ResultInspectionIdentity = { parentId: 'a'.repeat(12), runId: 'b'.repeat(12), childKey: 'api-contract' };
const result = (): DelegationResultReceipt => ({ version: 1, ...identity, dispatchKey: 'c'.repeat(24), baseCommit: 'd'.repeat(40), commit: 'e'.repeat(40), tree: 'f'.repeat(40), changedPaths: ['src/api.ts'], decisions: 'Kept the response contract stable.', summary: 'Added the bounded endpoint validation.', unresolved: ['Manual browser acceptance remains pending.'], validations: [{ command: 'npm.cmd test', status: 'passed', evidenceRefs: ['unit-log'] }], evidence: [{ id: 'unit-log', kind: 'log', label: 'Unit test output', path: 'delegation-evidence/private/raw.log', sha256: '1'.repeat(64) }], dependencies: [], sha256: '2'.repeat(64) });
const verification = (commit = 'e'.repeat(40), tree = 'f'.repeat(40)): FocusedVerification => ({ state: 'passed', required: 1, passed: 1, blockers: 0, attempts: [{ number: 1, checkedCommit: commit, checkedTree: tree, startedAt: '2026-09-19T00:00:00.000Z', finishedAt: '2026-09-19T00:01:00.000Z', checks: [] }] });

test('result inspection keeps multi-child identity and result stages distinct without opening raw evidence', () => {
  const html = renderToStaticMarkup(React.createElement(DelegationResultInspection, { identity, result: result(), verification: verification(), integration: 'review-pending' }));
  assert.match(html, /Execution complete/);
  assert.match(html, /Verified child result/);
  assert.match(html, /Integration review pending/);
  assert.match(html, /api-contract/);
  assert.match(html, /src\/api.ts/);
  assert.match(html, /Unit test output/);
  assert.doesNotMatch(html, /delegation-evidence\/private\/raw.log/);
  assert.doesNotMatch(html, /<button/);
});

test('result inspection blocks absent, stale, and other-child evidence', () => {
  assert.equal(resultInspectionState(result(), undefined, identity), 'blocked');
  assert.equal(resultInspectionState(result(), verification('0'.repeat(40)), identity), 'blocked');
  assert.equal(resultInspectionState({ ...result(), childKey: 'different-child' }, verification(), identity), 'missing');
  const html = renderToStaticMarkup(React.createElement(DelegationResultInspection, { identity, result: result(), verification: verification('0'.repeat(40)) }));
  assert.match(html, /Blocked — evidence is missing or stale/);
  assert.match(html, /Not accepted for integration/);
});
