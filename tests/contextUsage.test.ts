import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildTaskPrompt, canEditBrief, emptyBrief, emptyHandoffSummary, lockTaskContext, parseBrief, renderTaskHandoff, taskPromptPreview } from '../src/core/taskContext';
import { TaskScheduler } from '../src/core/scheduler';
import { parseMessage, type SessionView, type Task, type Turn } from '../src/core/model';
import { LocalStore } from '../src/core/store';
import { SessionStore } from '../src/core/sessionStore';
import { summarizeUsage, usageSnapshot } from '../src/core/usage';
import { CodexTurn } from '../src/core/codexProtocol';

const id = '111111111111', sessionId = '12345678-1234-7234-9234-123456789abc', turnId = 'aaaaaaaa-aaaa-7aaa-9aaa-aaaaaaaaaaaa';
const task = (): Task => ({ id, title: 'Focused fix', prompt: 'legacy prompt', repository: path.resolve('.test-build/repo'), worktree: path.resolve('.test-build/worktree'), branch: 'agent/fix', baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', state: 'idle', interface: 'interactive-cli', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const turn = (index = 1): Turn => ({ id: index.toString(16).padStart(12, '0'), provider: 'codex', prompt: 'explicit', text: 'response', status: 'completed', createdAt: new Date().toISOString() });
const session = (turns: Turn[]): SessionView => ({ version: 1, turns });
async function fixture() { const base = path.resolve('.test-build/context-fixtures'); await mkdir(base, { recursive: true }); return mkdtemp(path.join(base, 'context-')); }
async function clean(root: string) { assert.ok(root.startsWith(path.resolve('.test-build/context-fixtures') + path.sep)); await rm(root, { recursive: true, force: true }); }

test('brief parsing bounds context and builds only explicit fields, including literal shell syntax', () => {
  const brief = { ...emptyBrief(), goal: 'Fix $(literal) `text`', relevantPaths: 'src/one.ts', testCommands: 'npm test' };
  const prompt = buildTaskPrompt(brief);
  assert.equal(prompt, '## Goal\nFix $(literal) `text`\n\n## Relevant paths and symbols\nsrc/one.ts\n\n## Suggested test commands (not run by Hydra)\nnpm test');
  const parsed = parseMessage({ type: 'create', title: 'Fix', prompt, repository: task().repository, provider: 'codex', brief });
  assert.equal(parsed.type, 'create');
  assert.throws(() => parseMessage({ type: 'create', title: 'Fix', prompt, repository: task().repository, provider: 'codex', model: 'gpt-6-astra', effort: 'high', brief }), /cannot confirm an Astra High preset/);
  assert.throws(() => parseMessage({ type: 'create', title: 'Fix', prompt: 'wrong preview', repository: task().repository, provider: 'codex', brief }), /preview does not match/);
  assert.deepEqual(parseMessage({ type: 'saveBrief', id, brief }), { type: 'saveBrief', id, brief });
  for (const bad of [null, [], { ...brief, goal: 42 }, { ...brief, goal: 'bad\0text' }, { ...brief, goal: 'x'.repeat(16001) }, { ...brief, goal: 'x'.repeat(16000), constraints: 'x'.repeat(16000) }]) {
    assert.throws(() => parseMessage({ type: 'saveBrief', id, brief: bad }));
  }
  assert.throws(() => parseMessage({ type: 'saveBrief', id, brief: emptyBrief() }), /goal/);
  assert.throws(() => parseMessage({ type: 'saveHandoffSummary', id, handoffSummary: { ...emptyHandoffSummary(), validation: [] } }));
  assert.ok(canEditBrief(task()));
  for (const changed of [{ contextLockedAt: new Date().toISOString() }, { sessionId }, { state: 'external' as const }, { state: 'running' as const }, { interface: 'official-extension' as const }]) assert.equal(canEditBrief({ ...task(), ...changed }), false);
  assert.equal(canEditBrief(task(), session([turn()])), false);
});

test('task brief and local handoff survive store reload; mismatched prompts are refused', async () => {
  const root = await fixture();
  try {
    const current = task(), store = new LocalStore(root), evidence = new SessionStore(path.join(root, 'sessions'));
    current.brief = { ...emptyBrief(), goal: 'Fix the bug', acceptance: 'Keyboard selects the active item.' };
    current.prompt = buildTaskPrompt(current.brief);
    current.handoffSummary = { ...emptyHandoffSummary(), summary: 'Fixed focus', validation: 'npm test passed (see tests.log)', evidenceRefs: 'src/one.ts\ntests.log', unresolved: 'Native acceptance pending' };
    await store.save([current]); assert.deepEqual((await store.load())[0], current);
    const content = renderTaskHandoff(current, evidence.historyPath(id), [{ id: turn().id, status: 'error', evidencePath: evidence.rawPath(id, turn().id) }]);
    const filename = await evidence.saveHandoff(id, content);
    assert.equal(await readFile(filename, 'utf8'), content);
    const blockedId = '222222222222';
    await mkdir(path.join(evidence.directory(blockedId), 'handoff.md'), { recursive: true });
    await assert.rejects(evidence.saveHandoff(blockedId, 'cannot replace a directory'));
    await evidence.log(blockedId, turn().id, { type: 'still-recording' });
    assert.match(await readFile(evidence.rawPath(blockedId, turn().id), 'utf8'), /still-recording/, 'A failed optional export does not disable provider evidence recording');
    assert.match(content, /No reviewed commit/); assert.match(content, /Native acceptance pending/); assert.match(content, /111111111111|000000000001/);
    assert.match(content, /Notes are not proof/); assert.ok(!content.includes('response'));
    current.reviewedCommit = { commit: 'b'.repeat(40), tree: 'c'.repeat(40), baseCommit: current.baseCommit, reviewedAt: new Date().toISOString() };
    assert.match(renderTaskHandoff(current, evidence.historyPath(id), []), /receipt may predate later edits/);
    await store.save([{ ...current, prompt: 'tampered' }]); await assert.rejects(store.load(), /disagree/);
  } finally { await clean(root); }
});

test('legacy preview preserves saved plain text and unsaved changes are explicitly drafts', () => {
  const current = task(), legacy = { ...emptyBrief(), goal: current.prompt };
  assert.deepEqual(taskPromptPreview(current, legacy), { prompt: 'legacy prompt', draft: false });
  const changed = { ...legacy, acceptance: 'Explicit new criterion' };
  assert.deepEqual(taskPromptPreview(current, changed), { prompt: buildTaskPrompt(changed), draft: true });
  current.brief = changed; current.prompt = buildTaskPrompt(changed);
  assert.deepEqual(taskPromptPreview(current, changed), { prompt: current.prompt, draft: false });
});

test('saved briefs require a goal while draft messages may remain empty', async () => {
  const root = await fixture();
  try {
    for (const goal of ['', ' \t\n ']) {
      const brief = { ...emptyBrief(), goal, constraints: 'A goal is still required' };
      assert.throws(() => parseBrief(brief), /task goal/);
      assert.throws(() => parseMessage({ type: 'saveBrief', id, brief }), /task goal/);
      const current = { ...task(), brief, prompt: buildTaskPrompt(brief) }, store = new LocalStore(root);
      await store.save([current]); await assert.rejects(store.load(), /task goal/);
    }
    assert.equal(parseMessage({ type: 'draft', title: '', prompt: '', provider: 'codex', brief: emptyBrief() }).type, 'draft');
  } finally { await clean(root); }
});

test('brief lock is durable before queue submission, survives cancellation/reload, and failed lock saves cannot enqueue', async () => {
  const root = await fixture();
  try {
    const current = task(), store = new LocalStore(root); let launches = 0;
    current.brief = { ...emptyBrief(), goal: 'Pinned queued goal', testCommands: 'advisory command only' };
    current.prompt = buildTaskPrompt(current.brief);
    const scheduler = new TaskScheduler({ tasks: () => [current], capacity: () => 1, liveCount: () => 1, enabled: () => true,
      persist: () => store.save([current]), prepare: async item => ({ commit: item.baseCommit, artifacts: [] }), launch: async () => { launches++; }
    });
    await lockTaskContext(current, () => store.save([current]));
    const locked = (await store.load())[0]!;
    assert.ok(locked.contextLockedAt); assert.equal(locked.schedule, undefined, 'Lock must be saved before launch intent enters the queue');
    await scheduler.enqueue(current, { type: 'startManaged' });
    const queued = (await store.load())[0]!;
    assert.equal(queued.schedule?.state, 'queued'); assert.equal(canEditBrief(queued), false); assert.equal(queued.prompt, current.prompt);
    assert.equal(launches, 0, 'Capacity hold and suggested test text make no provider call');
    await scheduler.cancel(current);
    assert.equal(canEditBrief((await store.load())[0]!), false, 'Cancellation does not undo the durable context lock');
    const failed = task(); let enqueued = false;
    await assert.rejects((async () => {
      await lockTaskContext(failed, async () => { throw new Error('Disk full'); });
      enqueued = true;
    })(), /Disk full/);
    assert.equal(enqueued, false); assert.equal(canEditBrief(failed), false);
    for (const schedule of [
      { state: 'queued' as const, dependencies: [], artifacts: [], request: { type: 'launch' as const } },
      { state: 'finished' as const, dependencies: [], artifacts: [], actualStartingCommit: 'a'.repeat(40) },
      { state: 'interrupted' as const, dependencies: [], artifacts: [], uncertain: true }
    ]) assert.equal(canEditBrief({ ...task(), schedule }), false, 'Legacy queue metadata also protects the brief without a context lock');
  } finally { await clean(root); }
});

test('Codex usage replaces cumulative observations and never sums latest-response snapshots', async () => {
  const root = await fixture();
  try {
    const current = turn(), protocol = new CodexTurn(sessionId, current), store = new SessionStore(root);
    protocol.started({ id: turnId, status: 'inProgress' });
    const emit = (input: number, threadId = sessionId, latest = 12) => protocol.notification('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: latest, outputTokens: 4, cachedInputTokens: 3, cacheWriteInputTokens: 2 }, total: { inputTokens: input, outputTokens: 8, cachedInputTokens: 6, cacheWriteInputTokens: 4 } } });
    emit(20); emit(40); emit(40); assert.equal(emit(999, turnId), false);
    assert.equal(current.usage?.input, 12); assert.equal(current.usageSource, 'codex-last-request'); assert.equal(current.threadUsage?.input, 40);
    const resumed = { ...turn(2), threadUsage: { ...current.threadUsage!, input: 60, output: 12 } };
    const history = session([current, resumed]);
    const before = summarizeUsage([{ taskId: id, session: history }, { taskId: id, session: history }]);
    assert.equal(before.codex?.input, 60); assert.equal(before.recordedTurns, 2); assert.equal(before.unmeasuredTurns, 0);
    await store.save(id, history);
    assert.deepEqual(summarizeUsage([{ taskId: id, session: await store.load(id) }]), before);
    const newer = { ...resumed, createdAt: '2026-09-17T23:00:00.000Z' }, older = { ...current, createdAt: '2026-09-17T22:00:00.000Z' };
    assert.equal(summarizeUsage([{ taskId: id, session: session([newer]) }, { taskId: '222222222222', session: session([older]) }]).codex?.input, 60, 'Shared thread snapshots are selected by recorded time, not task iteration order');
    assert.equal(summarizeUsage([{ taskId: id, session: session([older, { ...newer, threadUsage: { ...newer.threadUsage, input: 1 } }]) }]).codex?.input, 1, 'Cumulative resets replace snapshots without fabricated deltas');
    // Legacy latest-response observations are not reconstructed into invented full-turn totals.
    assert.equal(summarizeUsage([{ taskId: id, session: session([{ ...turn(), usage: current.usage }]) }]).codex, undefined);
    const malformed = { ...history, turns: [{ ...current, threadUsage: { ...current.threadUsage!, input: -1 } }] };
    await writeFile(store.historyPath(id), JSON.stringify(malformed)); await assert.rejects(store.load(id), /Invalid managed session/);
  } finally { await clean(root); }
});

test('usage aggregates full project history and keeps missing cache, money, and providers distinct', () => {
  const claude: Turn[] = Array.from({ length: 15 }, (_, index) => ({ ...turn(index + 1), provider: 'claude', usageSource: 'claude-result', usage: { input: 10, output: 3, cacheRead: 5, estimatedUsd: 0.01 } }));
  const codex = { ...turn(), threadUsage: { sessionId, input: 100, output: 30, cacheRead: 50, cacheCreated: 2 } };
  const tasks = [task(), { ...task(), id: '222222222222', provider: 'claude' as const }, { ...task(), id: '333333333333' }];
  const snapshots = usageSnapshot(tasks, taskId => taskId === id ? session([codex]) : taskId === '222222222222' ? session(claude) : undefined);
  const project = snapshots.projects[task().repository]!;
  assert.equal(project.claude?.input, 150); assert.equal(project.codex?.input, 100); assert.equal(project.recordedTurns, 16);
  assert.equal(project.tasksWithoutHistory, 1); assert.equal(project.claude?.cacheCreated, undefined); assert.equal(project.codex?.estimatedUsd, undefined);
  assert.equal(snapshots.tasks['222222222222']?.recordedTurns, 15);
  const missing = summarizeUsage([{ taskId: id, session: session([...claude, { ...turn(16), provider: 'claude', usageSource: 'claude-result', usage: { input: 1, output: 1 } }]) }]);
  assert.equal(missing.claude?.estimatedUsd, undefined); assert.equal(missing.claude?.cacheRead, undefined);
});
