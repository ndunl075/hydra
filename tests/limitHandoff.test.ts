import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildHandoff, defaultHandoffDeps, findCodexRollout, handoffFileName,
  parseClaudeTranscript, parseCodexRollout, type HandoffDeps,
} from '../src/core/limitHandoff';
import type { Job } from '../src/core/jobs';
import type { LimitEvent } from '../src/core/limitEvents';

const fixturesDir = path.resolve('tests/fixtures/handoff');
const claudeFixture = path.join(fixturesDir, 'claude-transcript.jsonl');
const codexFixture = path.join(fixturesDir, 'codex-rollout.jsonl');
const secret = 'sk-abcdef1234567890abcdef';

function fakeDeps(overrides: Partial<HandoffDeps> = {}): HandoffDeps {
  return { ...defaultHandoffDeps({}), now: () => new Date('2026-09-24T12:00:00.000Z'), git: async () => { throw new Error('git not configured for this test'); }, listCodexRollouts: async () => [], ...overrides };
}
function fakeGit(answers: Record<string, string>): HandoffDeps['git'] {
  return async (_cwd, args) => {
    const key = args.join(' ');
    if (key in answers) return answers[key]!;
    throw new Error(`unexpected git args: ${key}`);
  };
}
const okGit = fakeGit({
  'rev-parse --abbrev-ref HEAD': 'feature/retry-upload\n',
  'status --porcelain': ' M src/upload.ts\n?? src/retry.ts\n',
  'diff --stat': 'src/upload.ts | 4 ++--\n1 file changed, 2 insertions(+), 2 deletions(-)\n',
  'log --oneline -5': 'abc1234 Add retry scaffold\ndef5678 Start upload module\n',
});

function makeJob(overrides: Partial<Job> = {}): Job {
  const at = '2026-09-24T11:00:00.000Z';
  return {
    version: 1, id: 'abcdef123456', leadKey: 'lead-1', idempotencyKey: 'k1',
    title: 'Add retry with backoff', brief: 'Wrap the flaky upload call in a retry with exponential backoff.',
    writeScope: ['src/'], provider: 'claude', dependsOn: [], state: 'running',
    limits: { wallClockMs: 1_800_000, maxTurns: 60, maxBudgetUsd: 5 },
    attempts: 1, maxAttempts: 3, nudged: false, worktree: '/repo/.worktrees/abcdef123456', branch: 'agent/abcdef123456',
    replies: [{ at, message: 'Also cover the timeout case.' }],
    createdAt: at, updatedAt: at, startedAt: at, history: [{ at, from: null, to: 'queued' }],
    ...overrides,
  };
}

// ---- Pure transcript parsing ----

test('parseClaudeTranscript extracts the ask, files, commands, todos and last message; skips wrappers, tool results and malformed lines', async () => {
  const text = await (await import('node:fs/promises')).readFile(claudeFixture, 'utf8');
  const extracted = parseClaudeTranscript(text, '/repo');
  assert.equal(extracted.ask, 'Fix the login flow so expired tokens redirect to /login instead of crashing.');
  assert.deepEqual(extracted.recentUserMessages, [extracted.ask, 'Also handle the case where the refresh token itself is expired.']);
  assert.deepEqual(extracted.filesTouched, ['src/auth/session.ts', 'src/auth/redirect.ts']);
  assert.equal(extracted.commands.length, 2);
  assert.ok(extracted.commands[0]!.includes('npm test -- auth'));
  assert.ok(!extracted.commands.some(command => command.includes(secret)), 'the bearer token must be masked');
  assert.deepEqual(extracted.todoInProgress, ['Handle expired refresh token']);
  assert.deepEqual(extracted.todoPending, ['Add regression test']);
  assert.equal(extracted.lastAssistantText, 'I updated session.ts and added a redirect; the refresh-token case still fails one test.');
});

test('parseCodexRollout extracts the ask, apply_patch files, shell commands and last assistant message; skips developer/wrapper text', async () => {
  const text = await (await import('node:fs/promises')).readFile(codexFixture, 'utf8');
  const extracted = parseCodexRollout(text, '/repo');
  assert.equal(extracted.ask, 'Add a retry with backoff around the flaky upload call.');
  assert.deepEqual(extracted.recentUserMessages, [extracted.ask, 'Also add a unit test for the backoff timing.']);
  assert.deepEqual(extracted.filesTouched, ['src/upload.ts', 'src/retry.ts']);
  assert.equal(extracted.commands.length, 2);
  assert.ok(!extracted.commands.some(command => command.includes(secret)), 'the API token must be masked');
  assert.equal(extracted.lastAssistantText, 'Retry with backoff is in; the new unit test for timing still needs to be written.');
});

test('malformed and truncated JSON lines are skipped, not fatal', () => {
  const claude = parseClaudeTranscript('not json\n{"type":"user","message":{"role":"user","content":[{"type":"text","text":"still works"}]}}\n{"broken', '/repo');
  assert.equal(claude.ask, 'still works');
  const codex = parseCodexRollout('{{{not json\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"still works"}]}}', '/repo');
  assert.equal(codex.ask, 'still works');
});

// ---- handoffFileName ----

test('handoffFileName is filesystem-safe and identifies provider/source', () => {
  const event: LimitEvent = { provider: 'codex', source: 'head', at: '2026-09-24T12:34:56.789Z' };
  const name = handoffFileName(event);
  assert.match(name, /^HANDOFF-codex-head-[0-9A-Za-z-]+\.md$/);
  assert.ok(!name.includes(':'));
});

// ---- buildHandoff: Claude chat ----

test('buildHandoff (Claude chat) renders a capped markdown handoff with masked secrets and git context', async () => {
  const event: LimitEvent = { provider: 'claude', source: 'chat', at: '2026-09-24T12:00:00.000Z', resetsAt: '2026-09-24T18:00:00.000Z', cwd: '/repo', transcriptPath: claudeFixture };
  const handoff = await buildHandoff({ event }, fakeDeps({ git: okGit }));
  assert.equal(handoff.cwd, '/repo');
  assert.equal(handoff.title, 'Fix the login flow so expired tokens redirect to /login instead of crashing.');
  assert.match(handoff.markdown, /^# Continue: Fix the login flow/);
  assert.match(handoff.markdown, /Handed off from Claude Code \(chat\) after it hit its usage limit, resets at 2026-09-24T18:00:00\.000Z\./);
  assert.match(handoff.markdown, /## The ask/);
  assert.match(handoff.markdown, /src\/auth\/session\.ts/);
  assert.match(handoff.markdown, /src\/auth\/redirect\.ts/);
  assert.match(handoff.markdown, /feature\/retry-upload/);
  assert.match(handoff.markdown, /In progress: Handle expired refresh token/);
  assert.match(handoff.markdown, /Pending: Add regression test/);
  assert.match(handoff.markdown, /Continue this task in `\/repo`/);
  assert.ok(!handoff.markdown.includes(secret), 'the raw secret must never reach the markdown');
});

test('buildHandoff (Claude chat) without a transcript path still produces a usable handoff', async () => {
  const event: LimitEvent = { provider: 'claude', source: 'chat', at: '2026-09-24T12:00:00.000Z', cwd: '/repo' };
  const handoff = await buildHandoff({ event }, fakeDeps({ git: okGit }));
  assert.match(handoff.markdown, /\*Not recorded\.\*/);
  assert.match(handoff.markdown, /Not recorded — check the ask against the diff\./);
});

// ---- buildHandoff: Codex chat + rollout selection ----

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'hydra-handoff-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('findCodexRollout picks the most recently modified rollout whose session cwd matches, within the last 24h', async () => {
  await withTempDir(async dir => {
    const makeRollout = async (name: string, cwd: string) => {
      const file = path.join(dir, name);
      await writeFile(file, `{"type":"session_meta","payload":{"cwd":${JSON.stringify(cwd)}}}\n{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}}\n`);
      return file;
    };
    const now = new Date('2026-09-24T12:00:00.000Z');
    const other = await makeRollout('rollout-other-cwd.jsonl', '/elsewhere');
    const older = await makeRollout('rollout-older-match.jsonl', '/repo');
    const newest = await makeRollout('rollout-newest-match.jsonl', '/repo');
    const stale = await makeRollout('rollout-stale-match.jsonl', '/repo');
    await utimes(other, now, new Date(now.getTime() - 1_000)); // newest mtime, wrong cwd
    await utimes(older, now, new Date(now.getTime() - 3600_000));
    await utimes(newest, now, new Date(now.getTime() - 60_000));
    await utimes(stale, now, new Date(now.getTime() - 30 * 3600_000)); // > 24h old, excluded even though cwd matches

    const { readdir, stat } = await import('node:fs/promises');
    const deps = fakeDeps({
      now: () => now,
      listCodexRollouts: async () => Promise.all((await readdir(dir)).map(async name => {
        const file = path.join(dir, name);
        return { path: file, mtimeMs: (await stat(file)).mtimeMs };
      })),
    });

    const found = await findCodexRollout(deps, '/unused-codex-home', '/repo');
    assert.equal(found, newest);
  });
});

test('buildHandoff (Codex chat) finds the rollout by cwd and renders it; falls back cleanly when none matches', async () => {
  await withTempDir(async dir => {
    const rolloutPath = path.join(dir, 'rollout-match.jsonl');
    const fixtureText = await (await import('node:fs/promises')).readFile(codexFixture, 'utf8');
    await writeFile(rolloutPath, fixtureText);
    const now = new Date('2026-09-24T12:00:00.000Z');
    const { stat } = await import('node:fs/promises');
    const deps = fakeDeps({ now: () => now, git: okGit, listCodexRollouts: async () => [{ path: rolloutPath, mtimeMs: (await stat(rolloutPath)).mtimeMs }] });
    const event: LimitEvent = { provider: 'codex', source: 'chat', at: '2026-09-24T12:00:00.000Z', cwd: '/repo' };
    const handoff = await buildHandoff({ event }, deps);
    assert.match(handoff.markdown, /Handed off from Codex \(chat\)/);
    assert.match(handoff.markdown, /Add a retry with backoff/);
    assert.match(handoff.markdown, /src\/upload\.ts/);
    assert.ok(!handoff.markdown.includes(secret));

    const missEvent: LimitEvent = { provider: 'codex', source: 'chat', at: '2026-09-24T12:00:00.000Z', cwd: '/nowhere-matching' };
    const missHandoff = await buildHandoff({ event: missEvent }, { ...deps, git: fakeDeps().git });
    assert.match(missHandoff.markdown, /# Continue: the interrupted task/);
  });
});

// ---- buildHandoff: head ----

test('buildHandoff (head) uses the job brief, progress, question and result; never asks a model', async () => {
  const job = makeJob({ progress: 'Retry wrapper is in for upload; still need the backoff unit test.', question: 'Should the backoff cap at 30s or 60s?' });
  const event: LimitEvent = { provider: 'claude', source: 'head', at: '2026-09-24T12:00:00.000Z', jobId: job.id };
  const handoff = await buildHandoff({ event, job }, fakeDeps({ git: okGit }));
  assert.equal(handoff.title, job.title);
  assert.match(handoff.markdown, /Handed off from Claude Code \(head\)/);
  assert.match(handoff.markdown, /Wrap the flaky upload call in a retry with exponential backoff\./);
  assert.match(handoff.markdown, /Retry wrapper is in for upload/);
  assert.match(handoff.markdown, /Should the backoff cap at 30s or 60s\?/);
  assert.match(handoff.markdown, /Continue this task in `\/repo\/\.worktrees\/abcdef123456`/);
});

test('buildHandoff (head, done) shows the result summary and changed files as "where it stopped" / "what\'s done"', async () => {
  const job = makeJob({ state: 'done', progress: undefined, question: undefined, result: { summary: 'Retry with backoff shipped; unit test still pending.', commit: 'a'.repeat(40), changedFiles: ['src/upload.ts', 'src/retry.ts'], checks: [] } });
  const event: LimitEvent = { provider: 'claude', source: 'head', at: '2026-09-24T12:00:00.000Z', jobId: job.id };
  const handoff = await buildHandoff({ event, job }, fakeDeps({ git: okGit }));
  assert.match(handoff.markdown, /Retry with backoff shipped; unit test still pending\./);
  assert.match(handoff.markdown, /src\/upload\.ts/);
  assert.match(handoff.markdown, /Not recorded — check the ask against the diff\./);
});

// ---- git failure never fails the whole handoff ----

test('a git failure omits the git section instead of failing the handoff', async () => {
  const job = makeJob();
  const event: LimitEvent = { provider: 'claude', source: 'head', at: '2026-09-24T12:00:00.000Z', jobId: job.id };
  const handoff = await buildHandoff({ event, job }, fakeDeps({ git: async () => { throw new Error('git not found'); } }));
  assert.match(handoff.markdown, /\*Git status unavailable\.\*/);
});

// ---- size cap ----

test('a huge transcript is capped to roughly 12 KB with a truncation note', async () => {
  await withTempDir(async dir => {
    const hugeText = 'x'.repeat(60_000);
    const file = path.join(dir, 'huge.jsonl');
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Fix the huge thing.' }] } })
      + '\n' + JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: hugeText }] } }) + '\n';
    await writeFile(file, line);
    const event: LimitEvent = { provider: 'claude', source: 'chat', at: '2026-09-24T12:00:00.000Z', cwd: '/repo', transcriptPath: file };
    const handoff = await buildHandoff({ event }, fakeDeps());
    assert.ok(handoff.markdown.length <= 12 * 1024, `expected <= 12KB, got ${handoff.markdown.length}`);
    assert.match(handoff.markdown, /truncated/);
  });
});

// ---- secret masking across both providers, end to end ----

test('secrets never appear in the rendered markdown for either provider', async () => {
  const claudeEvent: LimitEvent = { provider: 'claude', source: 'chat', at: '2026-09-24T12:00:00.000Z', cwd: '/repo', transcriptPath: claudeFixture };
  const claudeHandoff = await buildHandoff({ event: claudeEvent }, fakeDeps({ git: okGit }));
  assert.ok(!claudeHandoff.markdown.includes(secret));

  await withTempDir(async dir => {
    const rolloutPath = path.join(dir, 'rollout.jsonl');
    await writeFile(rolloutPath, await (await import('node:fs/promises')).readFile(codexFixture, 'utf8'));
    const { stat } = await import('node:fs/promises');
    const codexEvent: LimitEvent = { provider: 'codex', source: 'chat', at: '2026-09-24T12:00:00.000Z', cwd: '/repo' };
    const codexHandoff = await buildHandoff({ event: codexEvent }, fakeDeps({ git: okGit, listCodexRollouts: async () => [{ path: rolloutPath, mtimeMs: (await stat(rolloutPath)).mtimeMs }] }));
    assert.ok(!codexHandoff.markdown.includes(secret));
  });
});
