import test from 'node:test';
import assert from 'node:assert/strict';
import { boundDelegationGraphEventHistory, parseDelegationGraphEvent, parseDelegationGraphEvents } from '../src/core/delegationGraphEvents';

const parentId = '111111111111', runId = '222222222222', childId = '333333333333';
const event = (id: string, sequence: number, kind: any = 'assignment') => {
  const routes: Record<string, any> = {
    assignment: { from: { kind: 'task', taskId: parentId }, to: { kind: 'task', taskId: childId }, producer: 'host' },
    dispatch: { from: { kind: 'scheduler' }, to: { kind: 'task', taskId: childId }, producer: 'scheduler' },
    'result-delivery': { from: { kind: 'task', taskId: childId }, to: { kind: 'task', taskId: parentId }, producer: 'host' },
    validation: { from: { kind: 'verification' }, to: { kind: 'task', taskId: childId }, producer: 'verification' },
    'approval-pause': { from: { kind: 'host' }, to: { kind: 'task', taskId: childId }, producer: 'host' },
    interruption: { from: { kind: 'scheduler' }, to: { kind: 'task', taskId: childId }, producer: 'scheduler' },
    acceptance: { from: { kind: 'integration' }, to: { kind: 'task', taskId: parentId }, producer: 'integration' }
  };
  const route = routes[kind];
  return { version: 1, id, sequence, occurredAt: '2026-09-18T00:00:00.000Z', kind, parentId, runId, from: route.from, to: route.to, provenance: { producer: route.producer, recordId: 'f'.repeat(24) } };
};

test('events replay in deterministic sequence order and suppress exact duplicate records', () => {
  const one = event('a'.repeat(24), 1), two = event('b'.repeat(24), 2, 'result-delivery');
  assert.deepEqual(parseDelegationGraphEvents([two, one, structuredClone(one)]).map(item => item.id), [one.id, two.id]);
  assert.throws(() => parseDelegationGraphEvents([{ ...one, sequence: 2 }, two]), /ambiguous/);
  assert.throws(() => parseDelegationGraphEvents([one, { ...one, occurredAt: '2026-09-18T00:00:09.000Z' }]), /Conflicting duplicate/);
  assert.throws(() => parseDelegationGraphEvents([one, { ...one, id: 'c'.repeat(24), sequence: 2, runId: '444444444444' }]), /one parent run/);
  assert.throws(() => boundDelegationGraphEventHistory([one, { ...one, id: 'c'.repeat(24), sequence: 2, parentId: '444444444444', from: { kind: 'task', taskId: '444444444444' } }]), /one parent run/);
});

test('every lifecycle route carries explicit, compatible provenance and never infers traffic', () => {
  for (const [index, kind] of ['assignment', 'dispatch', 'result-delivery', 'validation', 'approval-pause', 'interruption', 'acceptance'].entries()) assert.equal(parseDelegationGraphEvent(event((index + 1).toString(16).padStart(24, '0'), index + 1, kind)).kind, kind);
  const missingRoute = event('a'.repeat(24), 1); delete (missingRoute as any).from;
  assert.throws(() => parseDelegationGraphEvent(missingRoute), /Invalid delegation graph event/);
  const fabricated = event('a'.repeat(24), 1); fabricated.provenance.producer = 'scheduler';
  assert.throws(() => parseDelegationGraphEvent(fabricated), /provenance/);
  const wrongParent = event('a'.repeat(24), 1); wrongParent.from.taskId = childId;
  assert.throws(() => parseDelegationGraphEvent(wrongParent), /distinct recorded child/);
  const selfAssignment = event('a'.repeat(24), 1); selfAssignment.to.taskId = parentId;
  assert.throws(() => parseDelegationGraphEvent(selfAssignment), /distinct recorded child/);
  const selfResult = event('a'.repeat(24), 1, 'result-delivery'); selfResult.from.taskId = parentId;
  assert.throws(() => parseDelegationGraphEvent(selfResult), /distinct recorded child/);
});

test('schema version and bounded retention fail closed while preserving replay order', () => {
  const one = event('a'.repeat(24), 1), two = event('b'.repeat(24), 2), three = event('c'.repeat(24), 3);
  assert.deepEqual(boundDelegationGraphEventHistory([three, one, two], 2), { events: [two, three], evicted: [one.id] });
  assert.throws(() => parseDelegationGraphEvent({ ...one, version: 0 }), /Unsupported/);
  assert.throws(() => parseDelegationGraphEvent({ ...one, version: 2 }), /Unsupported/);
  const unversioned = { ...one }; delete (unversioned as any).version;
  assert.throws(() => parseDelegationGraphEvent(unversioned), /Unsupported/);
  assert.throws(() => boundDelegationGraphEventHistory([one], 513), /limit/);
  assert.throws(() => parseDelegationGraphEvents(Array.from({ length: 513 }, (_, index) => event(index.toString(16).padStart(24, '0'), index + 1))), /bounded/);
});
