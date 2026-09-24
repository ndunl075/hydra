import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TaskScheduler, configureSchedule, validateSchedule } from '../src/core/scheduler';
import { prepareScheduledTask } from '../src/core/schedulerGit';
import { LocalStore } from '../src/core/store';
import { createWorktree, git } from '../src/core/worktrees';
import { prepareCommitReview, commitReviewed } from '../src/core/reviewCommit';
import { parseMessage, type Task } from '../src/core/model';
import { ManagedSessions } from '../src/core/managedSessions';
import { SessionStore } from '../src/core/sessionStore';

const now = new Date().toISOString();
function task(n: number): Task { return { id: n.toString(16).padStart(12, '0'), title: `Task ${n}`, prompt: 'Implement this', repository: path.resolve('fixture'), worktree: path.resolve(`fixture-${n}`), branch: `agent/task-${n}`, baseCommit: 'a'.repeat(40), integrationTarget: 'main', provider: 'codex', interface: 'managed-cli', state: 'idle', createdAt: now, updatedAt: now }; }
function harness(tasks: Task[], persist = async () => {}, limit = 2) {
  const live = new Set<string>(), launches: string[] = [], writes: string[][] = [];
  const scheduler = new TaskScheduler({ tasks: () => tasks, capacity: () => limit, liveCount: () => live.size, enabled: () => true,
    persist: async () => { writes.push(tasks.map(item => item.schedule?.state || 'none')); await persist(); },
    prepare: async item => ({ commit: item.baseCommit, artifacts: item.schedule?.artifacts || [] }),
    launch: async item => { assert.equal(item.schedule?.state, 'starting'); assert.equal(item.schedule?.actualStartingCommit, item.baseCommit); assert.ok(!live.has(item.id)); live.add(item.id); launches.push(item.id); item.state = 'running'; }
  });
  return { scheduler, live, launches, writes };
}

test('full profile capacity retains FIFO requests without prepare, launch, or persist/drain spin', async () => {
  const item = task(90); let full = true, preparations = 0, launches = 0, saves = 0, releases = 0;
  let scheduler: TaskScheduler;
  scheduler = new TaskScheduler({ tasks: () => [item], capacity: () => 2, liveCount: () => 0, enabled: () => true,
    persist: async () => { saves++; if (saves > 12) throw Error('Drain spin'); queueMicrotask(() => { void scheduler.drain(); }); },
    reserve: async () => !full, release: async () => { releases++; },
    prepare: async () => { preparations++; return { commit: item.baseCommit, artifacts: [] }; },
    launch: async () => { launches++; item.state = 'running'; }
  });
  await scheduler.enqueue(item, { type: 'startManaged' }); await scheduler.idle();
  assert.equal(item.schedule?.state, 'queued'); assert.equal(item.schedule?.reason, 'Waiting for a shared profile slot.');
  assert.equal(preparations, 0); assert.equal(launches, 0); assert.equal(saves, 2);
  full = false; await scheduler.drain(); await scheduler.idle();
  assert.equal(launches, 1); assert.equal(preparations, 1); assert.equal(item.schedule?.state, 'running'); assert.ok(releases >= 2);
});

test('cancellation during asynchronous slot reservation never prepares or launches and releases protection', async () => {
  const item = task(91); let reserved!: () => void, entering!: () => void, releases = 0;
  const entered = new Promise<void>(resolve => { entering = resolve; });
  const acquired = new Promise<void>(resolve => { reserved = resolve; });
  const scheduler = new TaskScheduler({ tasks: () => [item], capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: async () => {},
    reserve: async () => { entering(); await acquired; return true; }, release: async () => { releases++; },
    prepare: async () => { throw Error('Cancelled reservation prepared checkout'); }, launch: async () => { throw Error('Cancelled reservation launched'); }
  });
  const enqueue = scheduler.enqueue(item, { type: 'startManaged' }); await entered;
  await scheduler.cancel(item); reserved(); await enqueue; await scheduler.idle();
  assert.equal(item.schedule?.state, 'cancelled'); assert.equal(releases, 1);
});

test('failed starting persistence releases reservation protection before reporting failure', async () => {
  const item = task(92); let saves = 0, releases = 0;
  const scheduler = new TaskScheduler({ tasks: () => [item], capacity: () => 2, liveCount: () => 0, enabled: () => true,
    persist: async () => { if (++saves === 2) throw Error('Starting save failed'); }, reserve: async () => true, release: async () => { releases++; },
    prepare: async () => { throw Error('Prepared after failed save'); }, launch: async () => { throw Error('Launched after failed save'); }
  });
  await assert.rejects(scheduler.enqueue(item, { type: 'startManaged' }), /Starting save failed/); assert.equal(releases, 1); assert.equal(item.schedule?.state, 'blocked'); assert.match(item.schedule?.reason || '', /Starting save failed/);
});

test('FIFO excess queue persists across reload, reserves uncertain capacity, and never duplicates launches', async () => {
  const directory = path.resolve('.test-build/scheduler-store'); await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'queue-'));
  try {
    const tasks = [task(1), task(2), task(3), task(4)]; const store = new LocalStore(root);
    const first = harness(tasks, () => store.save(tasks));
    await Promise.all(tasks.map(item => first.scheduler.enqueue(item, { type: 'startManaged' })));
    assert.deepEqual(first.launches, [tasks[0]!.id, tasks[1]!.id]);
    assert.deepEqual(tasks.map(item => item.schedule?.state), ['running', 'running', 'queued', 'queued']);
    const restored = await store.load(), next = harness(restored, () => store.save(restored));
    next.scheduler.reconcile(); await store.save(restored); await next.scheduler.drain();
    assert.equal(next.launches.length, 0);
    assert.equal(restored[0]!.schedule?.uncertain, true);
    await assert.rejects(next.scheduler.enqueue(restored[0]!, { type: 'startManaged' }), /unreconciled/);
    await next.scheduler.reconcileStopped(restored[0]!);
    assert.deepEqual(next.launches, [tasks[2]!.id]);
    await next.scheduler.reconcileStopped(restored[1]!);
    await Promise.all([next.scheduler.drain(), next.scheduler.drain(), next.scheduler.drain()]);
    assert.deepEqual(next.launches, [tasks[2]!.id, tasks[3]!.id]);
    assert.deepEqual((await store.load()).slice(2).map(item => item.schedule?.actualStartingCommit), ['a'.repeat(40), 'a'.repeat(40)]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('dependency cycles refuse atomically, failed prerequisites require explicit retry, cancellation never launches', async () => {
  const tasks = [task(1), task(2), task(3)];
  configureSchedule(tasks[1]!, tasks, [tasks[0]!.id]); configureSchedule(tasks[2]!, tasks, [tasks[1]!.id]);
  assert.throws(() => configureSchedule(tasks[0]!, tasks, [tasks[2]!.id]), /cycle/);
  assert.equal(tasks[0]!.schedule, undefined);
  const h = harness(tasks); tasks[0]!.state = 'error';
  await h.scheduler.enqueue(tasks[1]!, { type: 'launch' });
  assert.equal(tasks[1]!.schedule?.state, 'blocked'); assert.equal(h.launches.length, 0);
  tasks[0]!.state = 'idle'; tasks[0]!.reviewedCommit = { commit: 'b'.repeat(40), tree: 'c'.repeat(40), baseCommit: tasks[0]!.baseCommit, reviewedAt: now };
  await h.scheduler.drain(); assert.equal(h.launches.length, 0);
  configureSchedule(tasks[1]!, tasks, [tasks[0]!.id]); await h.scheduler.drain();
  assert.deepEqual(h.launches, [tasks[1]!.id]);
  await h.scheduler.enqueue(tasks[2]!, { type: 'startManaged' });
  assert.equal(tasks[2]!.schedule?.state, 'queued'); await h.scheduler.cancel(tasks[2]!);
  await h.scheduler.drain(); assert.equal(h.launches.length, 1);
});

test('launch persistence failure prevents provider invocation and preparation failure stays blocked', async () => {
  const tasks = [task(1)]; let saves = 0;
  const h = harness(tasks, async () => { if (++saves === 2) throw new Error('Disk full'); });
  await assert.rejects(h.scheduler.enqueue(tasks[0]!, { type: 'launch' }), /Disk full/);
  assert.equal(h.launches.length, 0);
  const failed = task(2);
  const scheduler = new TaskScheduler({ tasks: () => [failed], capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: async () => {}, prepare: async () => { throw new Error('Changed predecessor'); }, launch: async () => assert.fail('must not launch') });
  await scheduler.enqueue(failed, { type: 'launch' }); await scheduler.drain();
  assert.equal(failed.schedule?.state, 'blocked'); assert.match(failed.schedule?.reason || '', /Changed/);
});

test('schedule storage and messages reject malformed identities and follow-up requests', () => {
  const s = { state: 'queued', dependencies: [], artifacts: [], request: { type: 'followUp', prompt: '' } };
  assert.throws(() => validateSchedule(s), /Invalid/);
  assert.throws(() => validateSchedule({ ...s, request: { type: 'launch' }, dependencies: ['bad'] }), /Invalid/);
  assert.throws(() => parseMessage({ type: 'configureSchedule', id: task(1).id, dependencies: [42] }), /Invalid/);
  assert.deepEqual(parseMessage({ type: 'configureSchedule', id: task(1).id, dependencies: [] }), { type: 'configureSchedule', id: task(1).id, dependencies: [], startFromDependency: undefined });
});

test('post-launch save failure retains writer ownership and legacy active tasks reserve recovery capacity', async () => {
  const tasks = [task(1)]; let saves = 0;
  const h = harness(tasks, async () => { if (++saves === 4) throw new Error('Transient storage failure after launch'); });
  await h.scheduler.enqueue(tasks[0]!, { type: 'launch' });
  assert.equal(h.launches.length, 1); assert.equal(tasks[0]!.schedule?.state, 'running');
  await assert.rejects(h.scheduler.cancel(tasks[0]!), /Stop and reconcile/);
  const legacy = task(2); legacy.state = 'running'; const external = task(3); external.state = 'external'; external.interface = 'official-extension';
  const recovered = harness([legacy, external]); recovered.scheduler.reconcile();
  assert.equal(legacy.schedule?.uncertain, true); assert.equal(external.schedule, undefined);
});

test('a writer stopped before startup persistence completes stays interrupted and releases capacity once', async () => {
  const tasks = [task(1), task(2)]; const live = new Set<string>(), launches: string[] = [];
  let signalWriter!: () => void, finishStartup!: () => void;
  const writerVisible = new Promise<void>(resolve => { signalWriter = resolve; });
  const startupSaved = new Promise<void>(resolve => { finishStartup = resolve; });
  const scheduler = new TaskScheduler({ tasks: () => tasks, capacity: () => 1, liveCount: () => live.size, enabled: () => true,
    persist: async () => {}, prepare: async item => ({ commit: item.baseCommit, artifacts: [] }),
    launch: async item => {
      launches.push(item.id); live.add(item.id); item.state = 'external';
      if (item === tasks[0]) { signalWriter(); await startupSaved; }
    }
  });
  const first = scheduler.enqueue(tasks[0]!, { type: 'launch' });
  await writerVisible;
  assert.equal(tasks[0]!.schedule?.state, 'starting');
  const second = scheduler.enqueue(tasks[1]!, { type: 'launch' });
  // Mirrors the terminal-close notification while the launch save is still in flight.
  live.delete(tasks[0]!.id); tasks[0]!.state = 'interrupted'; finishStartup();
  await Promise.all([first, second]); await scheduler.drain();
  assert.equal(tasks[0]!.schedule?.state, 'interrupted'); assert.equal(tasks[0]!.schedule?.request, undefined);
  assert.equal(tasks[1]!.schedule?.state, 'running');
  assert.deepEqual(launches, tasks.map(item => item.id)); assert.equal(live.size, 1);
});

test('persisted cyclic dependencies block and explicit follow-up text survives capacity waiting', async () => {
  const tasks = [task(1), task(2)];
  tasks[0]!.schedule = { state: 'queued', dependencies: [tasks[1]!.id], artifacts: [], request: { type: 'followUp', prompt: 'Resume with only this delta' } };
  tasks[1]!.schedule = { state: 'queued', dependencies: [tasks[0]!.id], artifacts: [], request: { type: 'launch' } };
  const h = harness(tasks); await h.scheduler.drain();
  assert.equal(h.launches.length, 0); assert.equal(tasks[0]!.schedule.state, 'blocked');
  assert.match(tasks[0]!.schedule.reason || '', /cycle/);
  assert.deepEqual(tasks[0]!.schedule.request, { type: 'followUp', prompt: 'Resume with only this delta' });
});

test('integration activity or capacity changes during preparation hold intent for a later drain', async () => {
  for (const blocker of ['integration', 'capacity']) {
    const item = task(1); let enabled = true, capacity = 2, live = 1, preparations = 0, launches = 0;
    const scheduler = new TaskScheduler({ tasks: () => [item], capacity: () => capacity, liveCount: () => live, enabled: () => enabled,
      persist: async () => {},
      prepare: async () => {
        if (++preparations === 1) { if (blocker === 'integration') enabled = false; else capacity = 1; }
        return { commit: item.baseCommit, artifacts: [] };
      },
      launch: async task => { launches++; task.state = 'running'; live++; }
    });
    await scheduler.enqueue(item, { type: 'startManaged' });
    assert.equal(item.schedule?.state, 'queued'); assert.equal(launches, 0); assert.ok(item.schedule?.request);
    enabled = true; live = 0; await scheduler.drain(); await scheduler.drain();
    assert.equal(launches, 1); assert.equal(item.schedule?.state, 'running');
  }
});

test('cancelling preparation or asynchronous launch startup never creates a writer and retains cancellation', async () => {
  for (const stage of ['prepare', 'launch']) {
    const item = task(1); let spawned = false;
    const scheduler = new TaskScheduler({ tasks: () => [item], capacity: () => 2, liveCount: () => 0, enabled: () => true,
      persist: async () => {},
      prepare: async () => { if (stage === 'prepare') await scheduler.cancel(item); return { commit: item.baseCommit, artifacts: [] }; },
      launch: async () => {
        if (stage === 'launch') { await scheduler.cancel(item); throw new Error('Queued launch cancelled before provider start.'); }
        spawned = true;
      }
    });
    await scheduler.enqueue(item, { type: 'launch' }); await scheduler.drain();
    assert.equal(spawned, false); assert.equal(item.schedule?.state, 'cancelled'); assert.equal(item.schedule?.request, undefined);
  }
});

test('cancel then immediate requeue cannot launch the stale request or steal the replacement intent', async () => {
  const item = task(1), prompts: string[] = [];
  let replacement: Promise<void> | undefined, preparations = 0;
  const scheduler = new TaskScheduler({ tasks: () => [item], capacity: () => 2, liveCount: () => prompts.length, enabled: () => true,
    persist: async () => {},
    prepare: async () => {
      if (++preparations === 1) {
        await scheduler.cancel(item);
        replacement = scheduler.enqueue(item, { type: 'followUp', prompt: 'Only the new intent' });
      }
      return { commit: item.baseCommit, artifacts: [] };
    },
    launch: async (task, request) => { prompts.push(request.type === 'followUp' ? request.prompt : 'Unexpected initial launch'); task.state = 'running'; }
  });
  await scheduler.enqueue(item, { type: 'followUp', prompt: 'Cancelled stale intent' });
  await replacement; await scheduler.drain();
  assert.deepEqual(prompts, ['Only the new intent']); assert.equal(item.schedule?.state, 'running');
});

test('both managed adapters recheck cancellation after startup persistence before spawning', async () => {
  const directory = path.resolve('.test-build/scheduler-cancel'); await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'cancel-'));
  try {
    for (const provider of ['claude', 'codex'] as const) {
      const item = task(provider === 'claude' ? 1 : 2); item.provider = provider;
      item.providerVersion = provider === 'claude' ? '2.1.270' : '0.154.0'; item.worktree = root;
      item.schedule = { state: 'starting', dependencies: [], artifacts: [], request: { type: 'startManaged' } };
      const sessions = new ManagedSessions(new SessionStore(path.join(root, provider)), async () => {
        if (item.schedule?.state === 'starting') { item.schedule.state = 'cancelled'; item.schedule.request = undefined; }
      }, () => {}, error => { throw error; });
      await sessions.start(item, process.execPath, 'No provider turn may start');
      assert.equal(sessions.has(item.id), false); assert.equal(sessions.count, 0);
      assert.equal(item.state, 'interrupted'); assert.equal(item.schedule.state, 'cancelled');
      assert.equal((await sessions.store.load(item.id)).turns[0]?.status, 'interrupted');
      assert.match(sessions.view(item.id)?.turns[0]?.error || '', /before provider process started/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real Git pins selected base and reviewed predecessor, refuses changed/dirty results, fast-forwards only a clean unstarted dependent', async () => {
  const directory = path.resolve('.test-build/scheduler-git'); await mkdir(directory, { recursive: true });
  const root = await mkdtemp(path.join(directory, 'git-')), repository = path.join(root, 'main'); await mkdir(repository);
  try {
    await git(repository, ['init', '-b', 'main']); await git(repository, ['config', 'user.email', 'scheduler@example.invalid']); await git(repository, ['config', 'user.name', 'Scheduler test']); await git(repository, ['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(repository, 'base.txt'), 'base\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Base']);
    const base = (await git(repository, ['rev-parse', 'HEAD'])).trim();
    await writeFile(path.join(repository, 'later.txt'), 'later\n'); await git(repository, ['add', '.']); await git(repository, ['commit', '-m', 'Later']);
    const predecessor: Task = { ...task(1), repository: await realpath(repository), ...await createWorktree(repository, 'Parent', task(1).id, undefined, base) };
    const dependent: Task = { ...task(2), repository: predecessor.repository, ...await createWorktree(repository, 'Child', task(2).id, undefined, base) };
    assert.equal(predecessor.baseCommit, base); assert.equal((await git(dependent.worktree, ['rev-parse', 'HEAD'])).trim(), base);
    await writeFile(path.join(predecessor.worktree, 'result.txt'), 'reviewed result\n'); await git(predecessor.worktree, ['add', '.']);
    predecessor.reviewedCommit = await commitReviewed(predecessor.worktree, await prepareCommitReview(predecessor.worktree, base, predecessor.branch), 'Reviewed result', () => {});
    const tasks = [predecessor, dependent]; configureSchedule(dependent, tasks, [predecessor.id], predecessor.id);
    await writeFile(path.join(predecessor.worktree, 'result.txt'), 'dirty\n');
    await assert.rejects(prepareScheduledTask(dependent, tasks, async () => {}), /clean/);
    await git(predecessor.worktree, ['restore', '--', 'result.txt']);
    await writeFile(path.join(dependent.worktree, 'mine.txt'), 'keep this\n');
    await assert.rejects(prepareScheduledTask(dependent, tasks, async () => {}), /clean/);
    await rm(path.join(dependent.worktree, 'mine.txt'));
    const prepared = await prepareScheduledTask(dependent, tasks, async () => {});
    assert.equal(prepared.commit, predecessor.reviewedCommit.commit); assert.equal(dependent.baseCommit, prepared.commit);
    assert.deepEqual(prepared.artifacts, [{ taskId: predecessor.id, ...predecessor.reviewedCommit }]);
    dependent.schedule!.actualStartingCommit = prepared.commit; dependent.schedule!.artifacts = prepared.artifacts;
    await writeFile(path.join(predecessor.worktree, 'more.txt'), 'changed result\n'); await git(predecessor.worktree, ['add', '.']);
    predecessor.reviewedCommit = await commitReviewed(predecessor.worktree, await prepareCommitReview(predecessor.worktree, base, predecessor.branch), 'New review', () => {});
    await assert.rejects(prepareScheduledTask(dependent, tasks, async () => {}), /review changed/);
    configureSchedule(dependent, tasks, [predecessor.id], predecessor.id);
    const resumed = await prepareScheduledTask(dependent, tasks, async () => {});
    assert.equal(resumed.commit, prepared.commit); assert.notEqual(resumed.artifacts[0]!.commit, prepared.artifacts[0]!.commit);
    assert.notEqual((await git(repository, ['rev-parse', 'HEAD'])).trim(), prepared.commit);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a launch that failed at startup can be retried with the same request instead of only cancelled', async () => {
  const failing = task(3); let attempts = 0; const requests: string[] = [];
  const scheduler = new TaskScheduler({ tasks: () => [failing], capacity: () => 2, liveCount: () => 0, enabled: () => true, persist: async () => {},
    prepare: async item => ({ commit: item.baseCommit, artifacts: [] }),
    // First attempt fails the way a provider handshake error does: the task ends in error, no writer.
    launch: async (item, request) => { requests.push(request.type); if (++attempts === 1) { item.state = 'error'; item.error = 'Claude emitted a non-control event before settings were verified.'; return; } item.state = 'running'; item.error = undefined; } });
  await assert.rejects(scheduler.retryBlocked(failing), /no stopped launch to retry/);
  await scheduler.enqueue(failing, { type: 'startManaged' }); await scheduler.drain();
  assert.equal(failing.schedule?.state, 'blocked'); assert.match(failing.schedule?.reason || '', /non-control event/);
  await scheduler.retryBlocked(failing); await scheduler.idle();
  assert.deepEqual(requests, ['startManaged', 'startManaged']);
  assert.equal(failing.schedule?.state, 'running'); assert.equal(failing.schedule?.reason, undefined);
  // Uncertain writers keep their own recovery path.
  const uncertain = task(5); uncertain.schedule = { state: 'blocked', dependencies: [], artifacts: [], request: { type: 'startManaged' }, uncertain: true } as Task['schedule'];
  await assert.rejects(scheduler.retryBlocked(uncertain), /no stopped launch to retry/);
});
