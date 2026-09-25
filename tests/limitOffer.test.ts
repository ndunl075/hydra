import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOffer, buildOfferMessage, continuedHistoryReason, formatResetTime, laneOfferButtons, laneOfferMessage, laneSwitchCountdownSeconds, limitEventKey,
  LimitOfferTracker, offerButtons, otherStillLimited, shouldOfferHandoff,
} from '../src/core/limitOffer';
import type { LimitEvent } from '../src/core/limitEvents';

const at = (iso: string) => new Date(iso);
const chatEvent = (patch: Partial<LimitEvent> = {}): LimitEvent => ({ provider: 'claude', source: 'chat', at: '2026-09-24T10:00:00.000Z', sessionId: 'sess-1', ...patch });
const headEvent = (patch: Partial<LimitEvent> = {}): LimitEvent => ({ provider: 'claude', source: 'head', at: '2026-09-24T10:00:00.000Z', jobId: 'abc123abc123', ...patch });
const laneEvent = (patch: Partial<LimitEvent> = {}): LimitEvent => ({ provider: 'claude', source: 'lane', at: '2026-09-24T10:00:00.000Z', laneId: 'abcdef012345', ...patch });

test('limitEventKey identifies the same chat/head/lane, distinct otherwise', () => {
  assert.equal(limitEventKey(chatEvent()), limitEventKey(chatEvent({ at: '2026-09-24T10:05:00.000Z' })));
  assert.notEqual(limitEventKey(chatEvent()), limitEventKey(chatEvent({ sessionId: 'sess-2' })));
  assert.notEqual(limitEventKey(chatEvent()), limitEventKey(headEvent()));
  assert.notEqual(limitEventKey(chatEvent()), limitEventKey({ ...chatEvent(), provider: 'codex' }));
  assert.notEqual(limitEventKey(chatEvent()), limitEventKey(laneEvent()));
  assert.equal(limitEventKey(laneEvent()), limitEventKey(laneEvent({ at: '2026-09-24T10:05:00.000Z' })));
  assert.notEqual(limitEventKey(laneEvent()), limitEventKey(laneEvent({ laneId: '112233445566' })), 'two lanes of the same provider never collide');
});

test('laneOfferMessage/laneOfferButtons build the tile banner: only Wait when the other provider is also limited', () => {
  assert.equal(laneOfferMessage(laneEvent(), at('2026-09-24T10:00:00.000Z')), 'Claude Code hit its usage limit.');
  assert.match(laneOfferMessage(laneEvent({ resetsAt: '2026-09-24T15:45:00.000Z' }), at('2026-09-24T10:00:00.000Z')), /^Claude Code hit its usage limit \(resets \d{1,2}:\d{2}.*\)\.$/);
  assert.deepEqual(laneOfferButtons(false), ['continueOther', 'viewHandoff', 'wait']);
  assert.deepEqual(laneOfferButtons(true), ['wait']);
  assert.equal(laneSwitchCountdownSeconds, 10);
});

test('shouldOfferHandoff dedupes the same chat/head within the window, not after it or for a different one', () => {
  const first = chatEvent();
  assert.equal(shouldOfferHandoff(first, undefined, at('2026-09-24T10:00:00.000Z')), true);
  const repeat = chatEvent({ at: '2026-09-24T10:05:00.000Z' });
  assert.equal(shouldOfferHandoff(repeat, first, at('2026-09-24T10:05:00.000Z')), false, 'within 10 minutes: ignored');
  const later = chatEvent({ at: '2026-09-24T10:11:00.000Z' });
  assert.equal(shouldOfferHandoff(later, first, at('2026-09-24T10:11:00.000Z')), true, 'after 10 minutes: offered again');
  const otherSession = chatEvent({ sessionId: 'sess-2', at: '2026-09-24T10:01:00.000Z' });
  assert.equal(shouldOfferHandoff(otherSession, first, at('2026-09-24T10:01:00.000Z')), true, 'a different session is never a repeat');
});

test('otherStillLimited uses resetsAt when known, else a default window from "at"', () => {
  const withReset = chatEvent({ resetsAt: '2026-09-24T11:00:00.000Z' });
  assert.equal(otherStillLimited(withReset, at('2026-09-24T10:59:00.000Z')), true);
  assert.equal(otherStillLimited(withReset, at('2026-09-24T11:00:01.000Z')), false);
  const withoutReset = chatEvent({ at: '2026-09-24T10:00:00.000Z' });
  assert.equal(otherStillLimited(withoutReset, at('2026-09-24T10:30:00.000Z')), true, 'still within the default 1h window');
  assert.equal(otherStillLimited(withoutReset, at('2026-09-24T11:01:00.000Z')), false, 'past the default window');
  assert.equal(otherStillLimited(undefined, at('2026-09-24T10:00:00.000Z')), false);
});

test('formatResetTime renders a clock time, or nothing when unknown', () => {
  assert.equal(formatResetTime(undefined, at('2026-09-24T10:00:00.000Z')), undefined);
  assert.equal(formatResetTime('not a date', at('2026-09-24T10:00:00.000Z')), undefined);
  assert.match(formatResetTime('2026-09-24T15:45:00.000Z', at('2026-09-24T10:00:00.000Z'))!, /\d{1,2}:\d{2}/);
});

test('buildOfferMessage names the provider that hit its limit and asks about the other, or says both are limited', () => {
  const message = buildOfferMessage(chatEvent(), at('2026-09-24T10:00:00.000Z'), false);
  assert.match(message, /^Claude Code hit its usage limit\. Continue in Codex\?$/);
  const withReset = buildOfferMessage(chatEvent({ resetsAt: '2026-09-24T15:45:00.000Z' }), at('2026-09-24T10:00:00.000Z'), false);
  assert.match(withReset, /^Claude Code hit its usage limit, resets at \d{1,2}:\d{2}.*\. Continue in Codex\?$/);
  const both = buildOfferMessage(chatEvent(), at('2026-09-24T10:00:00.000Z'), true);
  assert.match(both, /Codex hit its usage limit too/);
  assert.doesNotMatch(both, /Continue in Codex\?/);
});

test('offerButtons: ready offers Continue, not-ready offers Set up, and both-limited offers only View handoff', () => {
  const ready = offerButtons(chatEvent(), false, true);
  assert.deepEqual(ready.map(b => b.id), ['continueOther', 'viewHandoff', 'wait']);
  assert.equal(ready[0]!.label, 'Continue in Codex');

  const notReady = offerButtons(chatEvent(), false, false);
  assert.deepEqual(notReady.map(b => b.id), ['setupOther', 'viewHandoff', 'wait']);
  assert.equal(notReady[0]!.label, 'Set up Codex');

  const bothLimited = offerButtons(chatEvent(), true, true);
  assert.deepEqual(bothLimited.map(b => b.id), ['viewHandoff']);
});

test('buildOffer combines the message and the buttons for one call', () => {
  const offer = buildOffer(headEvent(), at('2026-09-24T10:00:00.000Z'), false, true);
  assert.match(offer.message, /Claude Code hit its usage limit\. Continue in Codex\?/);
  assert.deepEqual(offer.buttons.map(b => b.id), ['continueOther', 'viewHandoff', 'wait']);
});

test('continuedHistoryReason matches the short form used in job history', () => {
  assert.equal(continuedHistoryReason('claude', 'codex'), "Continued in Codex after Claude's usage limit.");
  assert.equal(continuedHistoryReason('codex', 'claude'), "Continued in Claude after Codex's usage limit.");
});

test('LimitOfferTracker: dedupes repeats, tracks the other provider being limited, and forgets it once its window passes', () => {
  const tracker = new LimitOfferTracker();
  const first = tracker.consider(chatEvent(), at('2026-09-24T10:00:00.000Z'));
  assert.ok(first);
  assert.equal(first!.otherAlsoLimited, false);

  assert.equal(tracker.consider(chatEvent({ at: '2026-09-24T10:02:00.000Z' }), at('2026-09-24T10:02:00.000Z')), undefined, 'a repeat within 10 minutes is ignored');

  const codexLimited = tracker.consider(chatEvent({ provider: 'codex', sessionId: 'sess-codex', resetsAt: '2026-09-24T12:00:00.000Z', at: '2026-09-24T10:03:00.000Z' }), at('2026-09-24T10:03:00.000Z'));
  assert.ok(codexLimited);
  assert.equal(codexLimited!.otherAlsoLimited, true, "claude's own limit (no known reset) is still within its default window");

  const claudeAgainWhileCodexLimited = tracker.consider(chatEvent({ sessionId: 'sess-new', at: '2026-09-24T10:20:00.000Z' }), at('2026-09-24T10:20:00.000Z'));
  assert.ok(claudeAgainWhileCodexLimited);
  assert.equal(claudeAgainWhileCodexLimited!.otherAlsoLimited, true, 'codex is still within its reset window');

  const afterCodexResets = tracker.consider(chatEvent({ sessionId: 'sess-later', at: '2026-09-24T12:30:00.000Z' }), at('2026-09-24T12:30:00.000Z'));
  assert.ok(afterCodexResets);
  assert.equal(afterCodexResets!.otherAlsoLimited, false, 'codex has since reset');
});

test('LimitOfferTracker is shared across chats, heads and lanes: a Codex chat limit shows up for a Claude lane, and vice versa', () => {
  const tracker = new LimitOfferTracker();
  const codexChat = tracker.consider(chatEvent({ provider: 'codex', sessionId: 'codex-1', resetsAt: '2026-09-24T12:00:00.000Z', at: '2026-09-24T10:00:00.000Z' }), at('2026-09-24T10:00:00.000Z'));
  assert.equal(codexChat!.otherAlsoLimited, false);
  const claudeLane = tracker.consider(laneEvent({ at: '2026-09-24T10:05:00.000Z' }), at('2026-09-24T10:05:00.000Z'));
  assert.equal(claudeLane!.otherAlsoLimited, true, "Codex's own chat limit is seen by a Claude lane's offer too");
  const anotherClaudeLane = tracker.consider(laneEvent({ laneId: '112233445566', at: '2026-09-24T10:06:00.000Z' }), at('2026-09-24T10:06:00.000Z'));
  assert.equal(anotherClaudeLane!.otherAlsoLimited, true, 'a second lane of the same provider is not a dedupe repeat of the first');
});
