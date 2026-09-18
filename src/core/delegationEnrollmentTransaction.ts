import type { Task } from './model';

export interface DelegatedEnrollmentTransaction {
  tasks: () => Task[];
  parent: Task;
  expected: Task[];
  runId: string;
  change: (parent: Task, expected: Task[], persisted: Task[]) => Task[];
  /** Must throw synchronously when the owner is no longer allowed to write. */
  assertWritable?: () => void;
  save: (snapshot: Task[]) => Promise<void>;
  settleCapacity: () => Promise<void>;
}

/**
 * Persists an enrollment transition using detached child records, then copies
 * only the durable schedule fields onto the original live task objects.
 *
 * A failed write leaves live objects untouched. A concurrent update to an
 * affected child trips the fingerprint fence before any child is patched;
 * unrelated live objects are never replaced.
 */
export async function saveDelegatedEnrollmentTransaction(input: DelegatedEnrollmentTransaction): Promise<Task[]> {
  // This must happen before constructing the durable snapshot. The host calls
  // it again after its last await, which fences a command that raced shutdown.
  input.assertWritable?.();
  const original = input.tasks().filter(task => task.delegation?.parentId === input.parent.id && task.delegation?.runId === input.runId);
  const detached = structuredClone(original);
  const changed = input.change(input.parent, input.expected, detached);
  const changedById = new Map(changed.map(task => [task.id, task]));
  const fingerprints = new Map(original.map(task => [task.id, JSON.stringify(task)]));
  const needsSave = original.some(task => {
    const candidate = changedById.get(task.id)!;
    return JSON.stringify(task.schedule) !== JSON.stringify(candidate.schedule) || task.updatedAt !== candidate.updatedAt;
  });
  if (!needsSave) return changed;

  // Snapshot current unrelated tasks while substituting only detached child
  // records. The live array and live child objects remain authoritative until
  // the write has succeeded and the fence below accepts them.
  const snapshot = input.tasks().map(task => changedById.get(task.id) ?? structuredClone(task));
  await input.save(snapshot);
  for (const task of original) {
    if (input.tasks().find(item => item.id === task.id) !== task || fingerprints.get(task.id) !== JSON.stringify(task)) {
      throw new Error('Delegated enrollment changed while its durable record was being saved. Reload the run and retry.');
    }
  }
  for (const task of original) {
    const candidate = changedById.get(task.id)!;
    task.schedule = structuredClone(candidate.schedule);
    task.updatedAt = candidate.updatedAt;
  }
  await input.settleCapacity();
  return changed;
}
