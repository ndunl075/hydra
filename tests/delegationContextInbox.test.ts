import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationContextInbox, type ContextInboxRequest } from '../webview/DelegationContextInbox';

const binding = { parentId: '111111111111', runId: '222222222222', childKey: 'parser' };
const request = (state: ContextInboxRequest['state'] = 'pending'): ContextInboxRequest => ({ requestKey: 'c'.repeat(24), binding, state, requested: [{ id: 'parser-api', path: 'src/contracts/parser.ts', revision: 'a'.repeat(40), scope: 'src/contracts' }] });

test('context inbox limits records and explicit ingress actions to the selected parent/run/child', () => {
  const supplied: unknown[] = [];
  const html = renderToStaticMarkup(React.createElement(DelegationContextInbox, { binding, requests: [request(), { ...request('refused'), requestKey: 'd'.repeat(24), binding: { ...binding, runId: '333333333333' }, refusal: 'stale-source' }], onSupply: action => supplied.push(action) }));
  assert.match(html, /src\/contracts\/parser\.ts/);
  assert.doesNotMatch(html, /333333333333/);
  assert.match(html, /Supply selected context/);
  assert.deepEqual(supplied, []);
  assert.match(html, /aria-label="Context requests for parser in run 222222222222"/);
});

test('context inbox shows source state and never turns a journal-only request into fulfilled context after restart', () => {
  const html = renderToStaticMarkup(React.createElement(DelegationContextInbox, { binding, requests: [request(), { ...request('pending'), requestKey: 'e'.repeat(24), sourceAvailability: 'unavailable' }, { ...request('fulfilled'), requestKey: 'f'.repeat(24) }, { ...request('refused'), requestKey: '1'.repeat(24), refusal: 'stale-source' }] }));
  assert.match(html, /Pending/);
  assert.match(html, /source unavailable/);
  assert.doesNotMatch(html, />Fulfilled</);
  assert.match(html, /Refusal: stale-source/);
  assert.match(html, /disabled=""/);
});
