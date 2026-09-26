import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { laneHasConversation, maxCodexFilesRead, type ConversationFs } from '../src/core/laneResume';

/**
 * Item 1 (docs/Heads.md, "Restarting Hydra"): laneHasConversation is pure and injectable
 * (home/env/fs), so every case here runs against a fresh temp "fake home" — never against a
 * real ~/.claude or ~/.codex.
 */

async function fakeHome(): Promise<{ home: string; close: () => Promise<void> }> {
  const home = await mkdtemp(path.join(tmpdir(), 'hydra-conv-home-'));
  return { home, close: () => rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
const noEnv = {} as Record<string, string | undefined>;

test('laneHasConversation: Claude Code — present, absent, another cwd, and case-insensitive on Windows', async () => {
  const { home, close } = await fakeHome();
  try {
    const worktree = path.join(home, 'work', 'repo.worktrees', 'lane-1');
    const encoded = worktree.replace(/[^A-Za-z0-9]/g, '-');
    // Nothing under .claude/projects at all: no conversation, not a detection failure.
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux' }), false);
    // The project folder exists but has no transcripts yet.
    await mkdir(path.join(home, '.claude', 'projects', encoded), { recursive: true });
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux' }), false);
    // A transcript is there now.
    await writeFile(path.join(home, '.claude', 'projects', encoded, 'a1b2c3.jsonl'), '{"type":"summary"}\n');
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux' }), true);
    // A different worktree's folder doesn't count.
    const other = path.join(home, 'work', 'repo.worktrees', 'lane-2');
    assert.equal(await laneHasConversation('claude', other, new Date(0), { home, env: noEnv, platform: 'linux' }), false);
    // Windows: the drive letter's case, and the folder's, don't matter.
    const upper = encoded.toUpperCase();
    await rm(path.join(home, '.claude', 'projects', encoded), { recursive: true, force: true });
    await mkdir(path.join(home, '.claude', 'projects', upper), { recursive: true });
    await writeFile(path.join(home, '.claude', 'projects', upper, 'x.jsonl'), '{}\n');
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'win32' }), true);
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux' }), false, 'exact-case only off Windows');
    // CLAUDE_CONFIG_DIR overrides the default <home>/.claude.
    const configured = path.join(home, 'elsewhere');
    await mkdir(path.join(configured, 'projects', encoded), { recursive: true });
    await writeFile(path.join(configured, 'projects', encoded, 'y.jsonl'), '{}\n');
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: { CLAUDE_CONFIG_DIR: configured }, platform: 'linux' }), true);
  } finally { await close(); }
});

test('laneHasConversation: an unreadable folder resumes as today (assumed true), not the same as "nothing there"', async () => {
  const { home, close } = await fakeHome();
  try {
    const worktree = path.join(home, 'w');
    const failing: ConversationFs = { readdir: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }, readFirstLine: async () => undefined };
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux', fs: failing }), true);
    assert.equal(await laneHasConversation('codex', worktree, new Date(0), { home, env: noEnv, platform: 'linux', fs: failing }), true);
    // A plain ENOENT (nothing there) is not a failure: false, as the "absent" cases above.
    const notFound: ConversationFs = { readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, readFirstLine: async () => undefined };
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux', fs: notFound }), false);
    assert.equal(await laneHasConversation('codex', worktree, new Date(0), { home, env: noEnv, platform: 'linux', fs: notFound }), false);
  } finally { await close(); }
});

async function codexSession(home: string, dayPath: string, fileName: string, cwd: string): Promise<void> {
  const dir = path.join(home, '.codex', 'sessions', ...dayPath.split('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, fileName), `${JSON.stringify({ type: 'session_meta', payload: { id: 'x', cwd } })}\n{"type":"other"}\n`);
}

test('laneHasConversation: Codex — present on or after "since", an older day folder is ignored, and another cwd doesn\'t match', async () => {
  const { home, close } = await fakeHome();
  try {
    const worktree = path.join(home, 'work', 'repo.worktrees', 'lane-1');
    const since = new Date('2026-09-25T00:00:00');
    // Two days before the lane existed: even with a matching cwd, it doesn't count. (The day
    // before still does, since Codex may name its day folders in UTC.)
    await codexSession(home, '2026/09/23', 'rollout-old.jsonl', worktree);
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: noEnv, platform: 'linux' }), false, 'only an older day folder exists');
    // On the lane's own day, but for a different cwd.
    await codexSession(home, '2026/09/25', 'rollout-other.jsonl', path.join(home, 'work', 'repo.worktrees', 'lane-2'));
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: noEnv, platform: 'linux' }), false);
    // A matching cwd, the day after.
    await codexSession(home, '2026/09/26', 'rollout-match.jsonl', worktree);
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: noEnv, platform: 'linux' }), true);
    // Windows: separators and case don't matter.
    const winWorktree = 'C:\\Users\\ndunl\\Documents\\hydra-wt\\lane-1';
    await codexSession(home, '2026/09/27', 'rollout-win.jsonl', 'c:/users/ndunl/documents/hydra-wt/lane-1');
    assert.equal(await laneHasConversation('codex', winWorktree, since, { home, env: noEnv, platform: 'win32' }), true);
    // CODEX_HOME overrides the default <home>/.codex, and points straight at the sessions root.
    const configured = path.join(home, 'elsewhere-codex');
    const configuredDir = path.join(configured, 'sessions', '2026', '09', '28');
    await mkdir(configuredDir, { recursive: true });
    await writeFile(path.join(configuredDir, 'rollout-cfg.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: 'cfg', cwd: worktree } })}\n`);
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: { CODEX_HOME: configured }, platform: 'linux' }), true);
    // No sessions folder at all: false, not a failure.
    assert.equal(await laneHasConversation('codex', worktree, since, { home: path.join(home, 'nothing-here'), env: noEnv, platform: 'linux' }), false);
  } finally { await close(); }
});

test('laneHasConversation: Codex — hitting the file-read bound assumes a conversation exists', async () => {
  const { home, close } = await fakeHome();
  try {
    const worktree = path.join(home, 'work', 'repo.worktrees', 'lane-1');
    const since = new Date('2026-09-25T00:00:00');
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '25');
    await mkdir(dir, { recursive: true });
    // Every file names a different cwd, well past the bound, so no real match ever turns up.
    for (let i = 0; i < maxCodexFilesRead + 20; i++) {
      await writeFile(path.join(dir, `rollout-${i}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id: String(i), cwd: `${worktree}-not-it-${i}` } })}\n`);
    }
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: noEnv, platform: 'linux' }), true, 'the bound was hit: resume as today');
  } finally { await close(); }
});

test('laneHasConversation: Codex ignores a first line that isn\'t JSON, or has no payload.cwd, without failing', async () => {
  const { home, close } = await fakeHome();
  try {
    const worktree = path.join(home, 'work', 'repo.worktrees', 'lane-1');
    const since = new Date('2026-09-25T00:00:00');
    const dir = path.join(home, '.codex', 'sessions', '2026', '09', '25');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'rollout-bad.jsonl'), 'not json at all\n');
    await writeFile(path.join(dir, 'rollout-nocwd.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: '1' } })}\n`);
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: noEnv, platform: 'linux' }), false);
    await writeFile(path.join(dir, 'rollout-good.jsonl'), `${JSON.stringify({ type: 'session_meta', payload: { id: '2', cwd: worktree } })}\n`);
    assert.equal(await laneHasConversation('codex', worktree, since, { home, env: noEnv, platform: 'linux' }), true);
  } finally { await close(); }
});

test('laneHasConversation: Claude — a very long encoded folder name that Claude Code shortened still matches by its first 200 characters', async () => {
  const { home, close } = await fakeHome();
  try {
    const worktree = path.join(home, 'work', 'x'.repeat(260), 'lane-1');
    const encoded = worktree.replace(/[^A-Za-z0-9]/g, '-');
    const shortened = `${encoded.slice(0, 200)}-abc123`;
    await mkdir(path.join(home, '.claude', 'projects', shortened), { recursive: true });
    await writeFile(path.join(home, '.claude', 'projects', shortened, 'session.jsonl'), '{}\n');
    assert.equal(await laneHasConversation('claude', worktree, new Date(0), { home, env: noEnv, platform: 'linux' }), true);
  } finally { await close(); }
});
