import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { createWorktree } from '../src/core/worktrees';
import { LaneStore, laneBranch, laneFolder, newLaneId, type Lane } from '../src/core/lanes';
import { LaneSync, branchTip, mergeTreeConflicts, snapshotLane } from '../src/core/laneSync';
import { checkMerge, closeLaneWorktree, commitLane, githubCompareUrl, laneDiffFiles, laneFullyMerged, mergeLane, pushLane, unlinkLinks, updateLane } from '../src/core/laneFinish';
import { LaneService } from '../src/core/laneService';
import { JobStore } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService } from '../src/core/helperService';
import { fakePtyModule } from './lanePtyFake';

/** A real repository with a main branch, a .gitignore and two files. */
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'hydra-lanes-git-')));
  const repo = path.join(root, 'repo');
  await git(root, ['init', '-q', '-b', 'main', repo]);
  for (const [key, value] of [['user.email', 'test@example.invalid'], ['user.name', 'Test'], ['core.autocrlf', 'false']]) await git(repo, ['config', key!, value!]);
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  await writeFile(path.join(repo, '.gitignore'), 'ignored/\n*.log\nnode_modules\n');
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  const lanes: Lane[] = [];
  const lane = async (name: string): Promise<Lane> => {
    const id = newLaneId();
    const created = await createWorktree(repo, name, id, undefined, undefined, { branch: laneBranch(name, id), folder: laneFolder(id) });
    const made: Lane = { id, name, provider: 'claude', repository: repo, worktree: created.worktree, branch: created.branch, baseCommit: created.baseCommit, target: created.integrationTarget, createdAt: new Date().toISOString(), state: 'running' };
    lanes.push(made);
    return made;
  };
  const write = (folder: string, file: string, text: string) => mkdir(path.dirname(path.join(folder, file)), { recursive: true }).then(() => writeFile(path.join(folder, file), text));
  const commit = async (folder: string, file: string, text: string) => { await write(folder, file, text); await git(folder, ['add', '-A']); await git(folder, ['commit', '-qm', `change ${file}`]); };
  const roots = [path.join(root, 'repo.worktrees')];
  return { root, repo, lane, lanes, write, commit, roots, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
const exists = (file: string) => access(file).then(() => true, () => false);
const hash = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
const indexOf = async (worktree: string) => (await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim();

test('a snapshot captures all of a lane\'s work without touching its index or files', async () => {
  const f = await fixture();
  try {
    const lane = await f.lane('Snap');
    await f.commit(lane.worktree, 'src/committed.ts', 'committed\n');
    await f.write(lane.worktree, 'src/a.ts', 'export const a = 2;\n');
    await f.write(lane.worktree, 'src/b.ts', 'export const b = 2;\n'); await git(lane.worktree, ['add', 'src/b.ts']);
    await f.write(lane.worktree, 'src/untracked.ts', 'new\n');
    await f.write(lane.worktree, 'ignored/cache.txt', 'ignored\n');
    await f.write(lane.worktree, 'debug.log', 'ignored\n');
    const index = await indexOf(lane.worktree);
    const [indexBefore, statusBefore, headBefore] = [await hash(index), await git(lane.worktree, ['status', '--porcelain=v1', '--untracked-files=all']), await git(lane.worktree, ['rev-parse', 'HEAD'])];
    const first = await snapshotLane(lane.worktree);
    assert.equal(await hash(index), indexBefore, 'the real index is byte-identical');
    assert.equal(await git(lane.worktree, ['status', '--porcelain=v1', '--untracked-files=all']), statusBefore, 'staged and unstaged stay as they were');
    assert.equal(first.head, headBefore.trim());
    assert.equal(first.dirty, true);
    const files = (await git(f.repo, ['diff', '--name-only', lane.baseCommit, first.snapshot])).trim().split('\n');
    assert.deepEqual(files.sort(), ['src/a.ts', 'src/b.ts', 'src/committed.ts', 'src/untracked.ts'], 'committed, staged, unstaged and untracked; ignored files left out');
    assert.equal((await git(f.repo, ['rev-parse', `${first.snapshot}^`])).trim(), first.head, 'the snapshot\'s parent is the lane\'s HEAD');
    assert.equal((await snapshotLane(lane.worktree)).snapshot, first.snapshot, 'the same work gives the same snapshot id');
    await git(lane.worktree, ['add', '-A']); await git(lane.worktree, ['commit', '-qm', 'all']);
    const clean = await snapshotLane(lane.worktree);
    assert.equal(clean.dirty, false);
    // A worktree with no usable index still snapshots, starting from HEAD.
    await rm(await indexOf(lane.worktree));
    await f.write(lane.worktree, 'src/later.ts', 'later\n');
    const fromHead = await snapshotLane(lane.worktree);
    assert.match((await git(f.repo, ['diff', '--name-only', clean.head, fromHead.snapshot])), /src\/later\.ts/);
  } finally { await f.close(); }
});

test('merge-tree finds lane-vs-lane and lane-vs-target conflicts, and a pass reports them per lane', async () => {
  const f = await fixture();
  try {
    const one = await f.lane('One'), two = await f.lane('Two'), three = await f.lane('Three');
    await f.commit(one.worktree, 'src/a.ts', 'export const a = "one";\n');
    await f.write(two.worktree, 'src/a.ts', 'export const a = "two";\n'); // uncommitted still counts
    await f.commit(three.worktree, 'src/c.ts', 'export const c = 3;\n');
    const [s1, s2, s3] = await Promise.all([one, two, three].map(lane => snapshotLane(lane.worktree)));
    assert.deepEqual(await mergeTreeConflicts(f.repo, s1!.snapshot, s2!.snapshot), ['src/a.ts']);
    assert.deepEqual(await mergeTreeConflicts(f.repo, s1!.snapshot, s3!.snapshot), []);
    await assert.rejects(mergeTreeConflicts(f.repo, s1!.snapshot, 'f'.repeat(40)), /./, 'anything but exit 0 or 1 is an error');
    // main moves: one commit that conflicts with lane three, one that doesn't.
    await f.commit(f.repo, 'src/c.ts', 'export const c = "main";\n');
    await f.commit(f.repo, 'README.md', 'readme\n');
    const sync = new LaneSync(() => new Date('2026-09-24T12:00:00Z'));
    const results = await sync.run([one, two, three, { ...one, id: 'dddddddddddd', worktree: path.join(f.root, 'missing'), state: 'exited' }]);
    const view = (lane: Lane) => results.get(lane.id)!;
    assert.deepEqual(view(one).conflicts, [{ laneId: two.id, files: ['src/a.ts'] }]);
    assert.deepEqual(view(two).conflicts, [{ laneId: one.id, files: ['src/a.ts'] }]);
    assert.deepEqual(view(three).conflicts, []);
    assert.deepEqual(view(three).targetConflicts, ['src/c.ts']);
    assert.deepEqual(view(one).targetConflicts, []);
    assert.deepEqual([view(one).behind, view(three).behind], [2, 2]);
    assert.deepEqual(view(one).changedFiles, ['src/a.ts']);
    assert.deepEqual([view(one).dirty, view(two).dirty], [false, true]);
    assert.equal(view(one).checkedAt, '2026-09-24T12:00:00.000Z');
    assert.match(results.get('dddddddddddd')!.error!, /Couldn't check this lane/, 'one broken lane never stops the others');
    const again = await sync.run([one, two, three]);
    assert.deepEqual([...again.values()].map(result => result.conflicts), [view(one).conflicts, view(two).conflicts, view(three).conflicts], 'unchanged snapshots give the same answer (from the cache)');
    // After "Update from target", the target's work doesn't count as the lane's own.
    const merged = await updateLane(three);
    assert.deepEqual(merged.conflicts, ['src/c.ts'], 'an update that conflicts leaves the lane mid-merge');
    assert.equal((await git(three.worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).trim().length, 40);
    await f.write(three.worktree, 'src/c.ts', 'export const c = "resolved";\n');
    await git(three.worktree, ['add', '-A']); await git(three.worktree, ['commit', '-qm', 'resolve']);
    const after = (await sync.run([three])).get(three.id)!;
    assert.deepEqual([after.changedFiles, after.targetConflicts, after.behind], [['src/c.ts'], [], 0]);
  } finally { await f.close(); }
});

test('merge refuses with the reason, and merges only when it is clean', async () => {
  const f = await fixture();
  try {
    const lane = await f.lane('Merge me');
    assert.deepEqual(await checkMerge(lane), { ok: false, reason: 'nothing', message: 'Nothing to merge.' });
    await f.commit(lane.worktree, 'src/b.ts', 'export const b = "lane";\n');
    await f.write(lane.worktree, 'src/b.ts', 'export const b = "dirty";\n');
    assert.equal((await checkMerge(lane) as { reason: string }).reason, 'dirty');
    assert.equal(await commitLane({ ...lane, goal: 'Tidy b\nand more' }), (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim());
    assert.match(await git(lane.worktree, ['log', '-1', '--format=%s']), /^Merge me: Tidy b$/m, 'the default message is "<name>: <first line of goal>"');
    assert.equal(await commitLane(lane), undefined, 'nothing to commit');
    await git(f.repo, ['switch', '-q', '-c', 'other']);
    const wrong = await checkMerge(lane) as { reason: string; message: string };
    assert.equal(wrong.reason, 'wrongBranch'); assert.match(wrong.message, /on other, not main/);
    await git(f.repo, ['switch', '-q', 'main']);
    await f.commit(f.repo, 'src/b.ts', 'export const b = "main";\n');
    const conflicts = await checkMerge(lane) as { reason: string; files: string[] };
    assert.equal(conflicts.reason, 'conflicts'); assert.deepEqual(conflicts.files, ['src/b.ts']);
    await assert.rejects(mergeLane(lane), /Merging would conflict in 1 file \(src\/b\.ts\)\. Update the lane from main first\./);
    // Uncommitted changes to a file main also changed: a plain reason, and nothing changes.
    await f.write(lane.worktree, 'src/b.ts', 'export const b = "uncommitted";\n');
    await assert.rejects(updateLane(lane), /The lane has uncommitted changes to files main also changed\. Commit them first/);
    assert.equal((await git(lane.worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')).trim(), '', 'no merge was started');
    await git(lane.worktree, ['checkout', '--', 'src/b.ts']);
    assert.deepEqual(await updateLane(lane), { conflicts: ['src/b.ts'], upToDate: false });
    await f.write(lane.worktree, 'src/b.ts', 'export const b = "both";\n');
    await commitLane(lane, 'Resolve');
    const ready = await checkMerge(lane);
    assert.deepEqual(ready, { ok: true, commits: 3, files: 1 });
    // git refuses when local changes in the main checkout are in the way: its message, and nothing changed.
    await f.write(f.repo, 'src/b.ts', 'local edit\n');
    await assert.rejects(mergeLane(lane), /git refused the merge: .*local changes/i);
    assert.equal(await readFile(path.join(f.repo, 'src', 'b.ts'), 'utf8'), 'local edit\n');
    assert.notEqual((await git(f.repo, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => '')).trim().length, 40);
    await git(f.repo, ['checkout', '--', 'src/b.ts']);
    const before = (await git(f.repo, ['rev-parse', 'HEAD'])).trim();
    const commit = await mergeLane(lane);
    assert.equal((await git(f.repo, ['rev-parse', `${commit}^1`])).trim(), before, 'a --no-ff merge commit on main');
    assert.equal((await git(f.repo, ['rev-parse', `${commit}^2`])).trim(), (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim());
    assert.equal(await laneFullyMerged(lane), true);
    assert.deepEqual(await checkMerge(lane), { ok: false, reason: 'nothing', message: 'Nothing to merge.' });
    assert.deepEqual(await updateLane(lane), { conflicts: [], upToDate: false }, 'the merged lane can catch up with main');
    // The diff lists uncommitted and untracked files against where the lane meets main.
    await f.write(lane.worktree, 'src/new.ts', 'new\n'); await f.write(lane.worktree, 'src/a.ts', 'changed\n');
    const diff = await laneDiffFiles(lane);
    assert.deepEqual(diff.files.sort((a, b) => a.path.localeCompare(b.path)), [{ path: 'src/a.ts', status: 'M' }, { path: 'src/new.ts', status: 'A' }]);
  } finally { await f.close(); }
});

test('Open PR pushes the branch to origin and builds the GitHub compare page', async () => {
  const f = await fixture();
  try {
    const lane = await f.lane('Push');
    await assert.rejects(pushLane(lane), /no "origin" remote/);
    const origin = path.join(f.root, 'origin.git');
    await git(f.root, ['init', '-q', '--bare', origin]);
    await git(f.repo, ['remote', 'add', 'origin', origin]);
    await f.commit(lane.worktree, 'src/p.ts', 'p\n');
    assert.deepEqual(await pushLane(lane), { branch: lane.branch });
    assert.equal((await git(origin, ['rev-parse', `refs/heads/${lane.branch}`])).trim(), (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim());
    assert.equal((await git(lane.worktree, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim(), `origin/${lane.branch}`);
    for (const remote of ['https://github.com/ndunl075/hydra.git', 'git@github.com:ndunl075/hydra.git', 'ssh://git@github.com/ndunl075/hydra', 'https://token@github.com/ndunl075/hydra/']) {
      assert.equal(githubCompareUrl(remote, 'main', 'lane/fix-abcdef012345'), 'https://github.com/ndunl075/hydra/compare/main...lane/fix-abcdef012345?expand=1', remote);
    }
    assert.equal(githubCompareUrl('https://gitlab.com/a/b.git', 'main', 'lane/x'), undefined);
    assert.equal(githubCompareUrl('https://github.com.evil.example/a/b.git', 'main', 'lane/x'), undefined);
  } finally { await f.close(); }
});

test('closing refuses anything but a known lane worktree, and never deletes through a junction', async () => {
  const f = await fixture();
  try {
    const lane = await f.lane('Linked');
    const known = [lane.worktree];
    await assert.rejects(closeLaneWorktree(lane, 'delete', f.roots, []), /isn't a lane Hydra knows/);
    await assert.rejects(closeLaneWorktree(lane, 'delete', [path.join(f.root, 'elsewhere')], known), /isn't in the worktree folder/);
    await assert.rejects(closeLaneWorktree({ ...lane, worktree: f.repo }, 'delete', f.roots, [f.repo]), /isn't a lane worktree/);
    const stray = path.join(f.roots[0]!, laneFolder('eeeeeeeeeeee'));
    await mkdir(stray, { recursive: true });
    await assert.rejects(closeLaneWorktree({ ...lane, id: 'eeeeeeeeeeee', worktree: stray, branch: 'lane/linked-eeeeeeeeeeee' }, 'delete', f.roots, [stray]), /git doesn't list it as a worktree/);
    assert.equal(await exists(stray), true, 'a refused path is left alone');

    // A linked node_modules (and one deeper down) pointing at a folder with a file that must survive.
    const outside = path.join(f.root, 'shared-node-modules'), deeper = path.join(f.root, 'shared-deeper');
    for (const folder of [outside, deeper]) { await mkdir(folder, { recursive: true }); await writeFile(path.join(folder, 'keep.txt'), 'keep me\n'); }
    await mkdir(path.join(lane.worktree, 'packages', 'app'), { recursive: true });
    const links = [path.join(lane.worktree, 'node_modules'), path.join(lane.worktree, 'packages', 'app', 'node_modules')];
    if (process.platform === 'win32') {
      for (const [link, target] of [[links[0]!, outside], [links[1]!, deeper]] as [string, string][]) {
        await new Promise<void>((resolve, reject) => execFile('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { windowsHide: true }, (error: Error | null) => error ? reject(error) : resolve()));
      }
    } else { await symlink(outside, links[0]!, 'dir'); await symlink(deeper, links[1]!, 'dir'); }
    assert.equal(await readFile(path.join(links[0]!, 'keep.txt'), 'utf8'), 'keep me\n', 'the junction is real');
    await f.write(lane.worktree, 'src/dirty.ts', 'uncommitted\n');
    const closed = await closeLaneWorktree(lane, 'delete', f.roots, known);
    assert.deepEqual(closed.unlinked.sort(), links.sort(), 'every link is unlinked before the forced removal');
    assert.equal(await exists(lane.worktree), false);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep me\n', 'the junction\'s target is intact');
    assert.equal(await readFile(path.join(deeper, 'keep.txt'), 'utf8'), 'keep me\n');
    assert.equal(await branchTip(f.repo, lane.branch), undefined, 'Delete everything removes the branch');
    assert.equal((await git(f.repo, ['worktree', 'list', '--porcelain'])).includes(laneFolder(lane.id)), false);
  } finally { await f.close(); }
});

test('Keep branch commits the work as WIP; a merged lane closes with branch -d', async () => {
  const f = await fixture();
  try {
    const kept = await f.lane('Keep me');
    await f.write(kept.worktree, 'src/wip.ts', 'wip\n');
    await closeLaneWorktree(kept, 'keep', f.roots, [kept.worktree]);
    assert.equal(await exists(kept.worktree), false);
    assert.equal((await git(f.repo, ['log', '-1', '--format=%s', kept.branch])).trim(), 'WIP: Keep me');
    assert.match(await git(f.repo, ['show', '--name-only', '--format=', kept.branch]), /src\/wip\.ts/);

    const merged = await f.lane('Merged');
    await f.commit(merged.worktree, 'src/m.ts', 'm\n');
    await mergeLane(merged);
    await f.write(merged.worktree, 'src/after.ts', 'after\n');
    await assert.rejects(closeLaneWorktree(merged, 'merged', f.roots, [merged.worktree]), /has uncommitted changes, so its worktree wasn't removed/);
    assert.equal(await exists(merged.worktree), true);
    await rm(path.join(merged.worktree, 'src', 'after.ts'));
    await closeLaneWorktree(merged, 'merged', f.roots, [merged.worktree]);
    assert.equal(await exists(merged.worktree), false);
    assert.equal(await branchTip(f.repo, merged.branch), undefined);

    // A worktree deleted by hand: nothing to remove, git's record is pruned, the branch goes.
    const gone = await f.lane('Gone');
    await rm(gone.worktree, { recursive: true, force: true });
    await closeLaneWorktree(gone, 'delete', f.roots, [gone.worktree]);
    assert.equal(await branchTip(f.repo, gone.branch), undefined);
    assert.equal(await unlinkLinks(f.repo).then(list => list.length), 0);
  } finally { await f.close(); }
});

test('the lane service starts, streams, resumes, coordinates and closes lanes over a fake pty', async () => {
  const f = await fixture();
  const pty = fakePtyModule();
  const store = new LaneStore(path.join(f.root, 'storage'));
  await store.load();
  const changes: number[] = [], data: [string, string][] = [], killed: number[] = [];
  let connected = false;
  const service = new LaneService({
    store, repository: f.repo, worktreeRoot: () => undefined, pty,
    executable: async provider => provider === 'claude' ? path.join(f.root, 'bin', 'claude.exe') : path.join(f.root, 'bin', 'codex.exe'),
    connected: async () => connected,
    bridge: provider => ({ command: 'hydra.exe', args: ['hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_LEAD_PROVIDER: provider } }),
    helpersDir: path.join(f.root, 'helpers'), configDirectory: path.join(f.root, 'storage', 'lanes'),
    runningHeads: lane => lane === store.open()[0]?.id ? 2 : 0,
    onChange: () => changes.push(Date.now()), onData: (lane, chunk) => data.push([lane, chunk]),
    killTree: async pid => { killed.push(pid); }, syncIntervalMs: 60_000,
    env: () => ({ PATH: 'x' }),
  });
  try {
    await assert.rejects(service.create({ name: 'Bad & name', provider: 'claude' }), /lane name/);
    const one = await service.create({ name: 'Lane 1', provider: 'claude', goal: 'Fix the checkout' });
    assert.match(one.branch, new RegExp(`^lane/lane-1-${one.id}$`));
    assert.equal(path.basename(one.worktree), `lane-${one.id}`);
    assert.equal(path.dirname(one.worktree), path.join(f.root, 'repo.worktrees'));
    assert.equal(one.target, 'main'); assert.equal(one.state, 'running');
    const [first] = pty.spawned;
    assert.equal(first!.file, path.join(f.root, 'bin', 'claude.exe'));
    const mcpFile = path.join(f.root, 'storage', 'lanes', `${one.id}.mcp.json`);
    assert.deepEqual(first!.args.slice(0, 2), ['--mcp-config', mcpFile], 'not connected: Hydra is passed for this process only');
    assert.match(first!.args[2]!, /^You are working in Hydra lane "Lane 1" on branch lane\/lane-1-[a-f0-9]{12}\. No other lanes are in progress\. .* Your task: Fix the checkout$/);
    assert.equal(JSON.parse(await readFile(mcpFile, 'utf8')).mcpServers.hydra.env.HYDRA_LANE_ID, one.id);
    assert.deepEqual([first!.options!.cwd, first!.options!.cols, first!.options!.rows, first!.options!.name], [one.worktree, 100, 30, 'xterm-256color']);
    assert.equal(first!.options!.env.HYDRA_LANE_ID, one.id);

    first!.emit('Welcome to Claude');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(data, [[one.id, 'Welcome to Claude']]);
    assert.equal(service.input(one.id, 'hi\r'), true);
    assert.deepEqual(first!.written, ['hi\r']);
    service.resize(one.id, 120, 40);
    assert.deepEqual(first!.sizes, [[120, 40]]);
    assert.throws(() => service.resize(one.id, 10, 40), /Invalid terminal size/);

    // A second lane (Codex, connected) edits the same file: both lanes see the conflict.
    connected = true;
    const two = await service.create({ name: 'Lane 2', provider: 'codex', goal: 'Rework a' });
    const second = pty.spawned[1]!;
    assert.equal(second.args[0], '-c'); assert.equal(second.args.includes('--mcp-config'), false);
    assert.match(second.args.at(-1)!, /Other lanes in progress: Lane 1 \(Claude Code\): Fix the checkout, no files changed yet\./);
    await f.write(one.worktree, 'src/a.ts', 'export const a = "one";\n');
    await f.write(two.worktree, 'src/a.ts', 'export const a = "two";\n');
    const answer = await service.describe(two.id);
    assert.equal(answer.you, two.id);
    const [a, b] = answer.lanes;
    assert.deepEqual({ ...a, goal: undefined }, { id: one.id, name: 'Lane 1', provider: 'claude', goal: undefined, branch: one.branch, target: 'main', state: 'running', changedFiles: ['src/a.ts'], conflictsWith: [{ lane: two.id, files: ['src/a.ts'] }], targetConflicts: [], behind: 0, runningHeads: 2 });
    assert.deepEqual(b!.conflictsWith, [{ lane: one.id, files: ['src/a.ts'] }]);
    assert.equal((await service.describe('ffffffffffff')).you, undefined, 'a caller that isn\'t an open lane has no "you"');
    const views = service.views();
    assert.deepEqual(views.map(view => [view.id, view.running, view.sync?.dirty]), [[one.id, true, true], [two.id, true, true]]);
    assert.deepEqual(service.openWorktrees(), [one.worktree, two.worktree]);

    // Exit, then resume with --continue; the replay keeps the earlier session.
    first!.exit(0);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual([store.get(one.id)!.state, store.get(one.id)!.exitCode], ['exited', 0]);
    assert.equal(service.input(one.id, 'x'), false, 'input to an exited lane is ignored');
    await service.resume(one.id);
    const resumed = pty.spawned[2]!;
    assert.deepEqual(resumed.args, ['--continue'], 'connected now, so no --mcp-config');
    assert.deepEqual([store.get(one.id)!.state, store.get(one.id)!.exitCode], ['running', undefined]);
    assert.deepEqual([resumed.options!.cols, resumed.options!.rows], [120, 40], 'the last size the UI sent');
    resumed.emit('again');
    assert.equal(service.replayOf(one.id), 'Welcome to Claudeagain');
    await assert.rejects(service.resume(one.id), /already running/);

    // Closing kills the process tree, removes the worktree and branch, and forgets the terminal.
    assert.equal(await service.closeKind(two.id), 'unmerged');
    await assert.rejects(service.close(two.id, 'merged'), /isn't merged/);
    await service.close(two.id, 'delete');
    assert.equal(killed.includes(second.pid), true);
    assert.equal(await exists(two.worktree), false);
    assert.equal(await branchTip(f.repo, two.branch), undefined);
    assert.equal(store.get(two.id)!.state, 'closed');
    assert.deepEqual(service.lanes().map(lane => lane.id), [one.id]);
    await assert.rejects(service.close(two.id, 'delete'), /isn't open/);

    // Commit and merge through the service: the lane becomes merged and then closes quietly.
    assert.match(await service.commit(one.id) ?? '', /^[a-f0-9]{40}$/);
    const check = await service.checkMerge(one.id);
    assert.deepEqual(check, { ok: true, commits: 1, files: 1 });
    await service.merge(one.id);
    assert.equal(store.get(one.id)!.state, 'merged');
    assert.ok(store.get(one.id)!.mergedAt);
    assert.equal(await service.closeKind(one.id), 'merged');
    await service.close(one.id, 'merged');
    assert.equal(await branchTip(f.repo, one.branch), undefined);
    assert.equal(service.lanes().length, 0);
    assert.ok(changes.length > 0);

    // A start that fails after its worktree was made leaves nothing behind.
    const broken = new LaneService({ ...(service as unknown as { options: ConstructorParameters<typeof LaneService>[0] }).options, pty: { spawn: () => { throw new Error('spawn failed'); } } });
    await assert.rejects(broken.create({ name: 'Broken', provider: 'claude' }), /spawn failed/);
    assert.equal(store.list().some(lane => lane.name === 'Broken'), false);
    assert.equal((await git(f.repo, ['branch', '--list', 'lane/broken-*'])).trim(), '');
    const noTerminals = new LaneService({ ...(service as unknown as { options: ConstructorParameters<typeof LaneService>[0] }).options, pty: undefined });
    await assert.rejects(noTerminals.create({ name: 'None', provider: 'claude' }), /Terminals aren't available in this build/);
  } finally { await service.dispose(); await f.close(); }
});

test('switchProvider (docs/Gates_Plan.md, section 2) ends the session, relaunches the other CLI in the same worktree with a handoff, and records the switch; uncommitted work survives', async () => {
  const f = await fixture();
  const pty = fakePtyModule();
  const store = new LaneStore(path.join(f.root, 'storage'));
  await store.load();
  const killed: number[] = [];
  const service = new LaneService({
    store, repository: f.repo, worktreeRoot: () => undefined, pty,
    executable: async provider => path.join(f.root, 'bin', `${provider}.exe`),
    connected: async () => true,
    bridge: provider => ({ command: 'hydra.exe', args: ['hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_LEAD_PROVIDER: provider } }),
    helpersDir: path.join(f.root, 'helpers'), configDirectory: path.join(f.root, 'storage', 'lanes'),
    onChange: () => {}, onData: () => {}, killTree: async pid => { killed.push(pid); }, syncIntervalMs: 60_000,
    env: () => ({ PATH: 'x' }),
  });
  try {
    const lane = await service.create({ name: 'Switch me', provider: 'claude', goal: 'Fix the checkout' });
    const first = pty.spawned[0]!;
    // Committed history, plus uncommitted and untracked work that must survive the switch untouched.
    await f.commit(lane.worktree, 'src/done.ts', 'done\n');
    await f.write(lane.worktree, 'src/a.ts', 'export const a = "uncommitted";\n');
    await f.write(lane.worktree, 'src/untracked.ts', 'new\n');
    const statusBefore = await git(lane.worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
    const headBefore = (await git(lane.worktree, ['rev-parse', 'HEAD'])).trim();

    // A manual switch (⋯ -> Switch to Codex): no LimitEvent given, the service builds its own.
    const switched = await service.switchProvider(lane.id, 'manual');
    assert.equal(switched.provider, 'codex');
    assert.equal(killed.includes(first.pid), true, 'the previous session is ended');
    assert.equal(switched.worktree, lane.worktree); assert.equal(switched.branch, lane.branch, 'same worktree and branch');
    assert.equal(await git(lane.worktree, ['status', '--porcelain=v1', '--untracked-files=all']), statusBefore, 'uncommitted and untracked work is untouched');
    assert.equal((await git(lane.worktree, ['rev-parse', 'HEAD'])).trim(), headBefore, 'the switch never commits');
    assert.deepEqual(switched.switches!.map(s => [s.from, s.to, s.reason]), [['claude', 'codex', 'manual']]);
    assert.equal(store.get(lane.id)!.provider, 'codex');

    const relaunched = pty.spawned[1]!;
    assert.equal(relaunched.file, path.join(f.root, 'bin', 'codex.exe'), 'the other CLI, in the same worktree');
    assert.equal(relaunched.options!.cwd, lane.worktree);
    const prompt = relaunched.args.at(-1)!;
    assert.match(prompt, /You are working in Hydra lane "Switch me"/);
    assert.match(prompt, /continuing in this lane after Claude Code hit its usage limit/);
    assert.match(prompt, /Handoff:/);

    // A limit-triggered switch back, with the caller's own LimitEvent (as the extension passes it).
    const event = { provider: 'codex' as const, source: 'lane' as const, laneId: lane.id, at: new Date().toISOString(), resetsAt: '2026-09-24T15:00:00.000Z', cwd: lane.worktree };
    const backAgain = await service.switchProvider(lane.id, 'limit', event);
    assert.equal(backAgain.provider, 'claude');
    assert.deepEqual(backAgain.switches!.map(s => [s.from, s.to, s.reason]), [['claude', 'codex', 'manual'], ['codex', 'claude', 'limit']]);
    assert.equal(pty.spawned[2]!.file, path.join(f.root, 'bin', 'claude.exe'));
  } finally { await service.dispose(); await f.close(); }
});

test('heads started from a lane record it, and hydra_lanes answers leads only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-lane-heads-'));
  const store = new JobStore(path.join(root, 'jobs')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  const laneId = 'abcdef012345';
  const described: (string | undefined)[] = [];
  service = new HelperService({
    store, endpoint, leadFolder: root, leadKey: 'window', executable: async () => { throw new Error('no CLI in this test'); },
    startRun: () => { throw new Error('unused'); }, bridge: { command: 'x', args: [] }, logDirectory: path.join(root, 'logs'), maxConcurrent: () => 1, watchdogMs: 60_000,
    lanes: { describe: async you => { described.push(you); return { you, lanes: [] }; }, name: id => id === laneId ? 'Lane 1' : undefined },
  });
  try {
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['-c', 'user.email=t@e.invalid', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const lead = endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'aaaaaaaaaaaa', provider: 'claude', lane: laneId });
    const started = await callHelperEndpoint(port, lead, 'hydra_start_head', { title: 'Split', brief: 'Do it.', write_scope: ['src/'], idempotency_key: 'k', lead_label: 'Mine' });
    assert.equal(started.ok, true, started.error);
    const job = store.get((started.result as { job_id: string }).job_id)!;
    assert.deepEqual(job.lead, { sessionId: 'aaaaaaaaaaaa', provider: 'claude', lane: laneId, label: 'Lane 1' }, 'grouped under the lane and labelled with its name');
    const plain = endpoint.issue({ role: 'lead', leadKey: 'window', leadSessionId: 'bbbbbbbbbbbb', lane: 'cccccccccccc' });
    const other = await callHelperEndpoint(port, plain, 'hydra_start_head', { title: 'Other', brief: 'Do it.', write_scope: ['src/'], idempotency_key: 'k2' });
    assert.deepEqual(store.get((other.result as { job_id: string }).job_id)!.lead, { sessionId: 'bbbbbbbbbbbb' }, 'a lane that isn\'t open here is not recorded');
    assert.deepEqual((await callHelperEndpoint(port, lead, 'hydra_lanes', {})).result, { you: laneId, lanes: [] });
    assert.deepEqual(described, [laneId]);
    const head = endpoint.issue({ role: 'helper', leadKey: 'window', jobId: job.id });
    assert.match((await callHelperEndpoint(port, head, 'hydra_lanes', {})).error || '', /not available to a Hydra head/);
  } finally { await service.dispose(); await endpoint.close(); await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
