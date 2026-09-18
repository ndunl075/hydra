import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationDrafts, receiveConversationDraft, type ConversationDraftState } from '../src/core/conversationDrafts';
import { parseMessage } from '../src/core/model';

const id = 'abcdef123456';
test('conversation drafts stay per task and a rejected submission keeps the prompt', () => {
  const drafts = new ConversationDrafts();
  drafts.update(id, { prompt: 'Continue this change', version: 'edit-1' });
  drafts.update('123456abcdef', { prompt: 'Other task', version: 'edit-2' });
  assert.throws(() => drafts.requireCurrent(id, 'Stale text', 'edit-1'), /changed/);
  assert.equal(drafts.get(id)?.prompt, 'Continue this change');
  assert.equal(drafts.get('123456abcdef')?.prompt, 'Other task');
  const copy = drafts.get(id)!; copy.prompt = 'Cannot mutate the host';
  assert.equal(drafts.get(id)?.prompt, 'Continue this change');
});

test('accepted queue receipt consumes only the submitted edit and blocks a replay', () => {
  const drafts = new ConversationDrafts();
  drafts.update(id, { prompt: 'Submit this', version: 'edit-1' });
  drafts.requireCurrent(id, 'Submit this', 'edit-1');
  drafts.accepted(id, 'Submit this', 'edit-1');
  assert.equal(drafts.get(id)?.prompt, '');
  assert.throws(() => drafts.requireCurrent(id, 'Submit this', 'edit-1'), /already submitted/);
  drafts.update(id, { prompt: 'New typing during submission', version: 'edit-2' });
  drafts.accepted(id, 'Submit this', 'edit-1');
  assert.equal(drafts.get(id)?.prompt, 'New typing during submission');
});

test('a coalesced snapshot cannot leave an optimistic editor draft permanently divergent', () => {
  const local = { prompt: 'Editor typing', version: 'editor-1' };
  let state: ConversationDraftState = { local, pendingVersion: local.version };
  const agents = { prompt: 'Newer Agents edit', version: 'agents-1', revision: 2 };
  state = receiveConversationDraft(state, agents);
  assert.equal(state.local.prompt, local.prompt, 'Keep optimistic typing until the receipt');
  state = receiveConversationDraft(state, { ...local, revision: 1 }, 'editor-1');
  assert.equal(state.pendingVersion, undefined);
  assert.equal(state.local.prompt, agents.prompt, 'Direct receipt adopts the newest canonical edit');
  state = receiveConversationDraft(state, { ...agents, prompt: '', revision: 3 });
  assert.equal(state.local.prompt, '');
});

test('old receipts and snapshots do not overwrite newer typing or accepted clears', () => {
  const first = { prompt: 'First', version: 'edit-1', revision: 1 };
  let state: ConversationDraftState = { local: { prompt: 'Second', version: 'edit-2' }, latest: first, pendingVersion: 'edit-2' };
  state = receiveConversationDraft(state, { ...first, prompt: '', revision: 2 }, 'edit-1');
  assert.equal(state.local.prompt, 'Second');
  assert.equal(state.pendingVersion, 'edit-2');
  state = receiveConversationDraft(state, { prompt: 'Second', version: 'edit-2', revision: 3 }, 'edit-2');
  state = receiveConversationDraft(state, { prompt: '', version: 'edit-2', revision: 4 });
  state = receiveConversationDraft(state, first, 'edit-1');
  assert.equal(state.local.prompt, '');
  assert.equal(state.latest?.revision, 4);
});

test('conversation protocol bounds edits and preserves unversioned follow-up callers', () => {
  assert.deepEqual(parseMessage({ type: 'followUp', id, prompt: 'Existing public caller' }), { type: 'followUp', id, prompt: 'Existing public caller' });
  assert.deepEqual(parseMessage({ type: 'conversationDraft', id, prompt: '', version: 'edit-1' }), { type: 'conversationDraft', id, prompt: '', version: 'edit-1' });
  assert.equal(parseMessage({ type: 'followUp', id, prompt: 'New UI caller', draftVersion: 'edit-1' }).type, 'followUp');
  assert.throws(() => parseMessage({ type: 'conversationDraft', id, prompt: 'x'.repeat(32001), version: 'edit-1' }), /Invalid prompt/);
  assert.throws(() => parseMessage({ type: 'conversationDraft', id: '../other', prompt: 'x', version: 'edit-1' }), /Invalid conversation/);
  assert.throws(() => parseMessage({ type: 'followUp', id, prompt: 'x', draftVersion: '' }), /Invalid draft version/);
});
