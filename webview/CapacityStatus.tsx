import type { CapacityView } from '../src/core/profileCapacity';
import type { ClientMessage, Task } from '../src/core/model';

export function CapacityStatus({ capacity, task, busy, writerUncertain, send }: { capacity?: CapacityView; task: Task; busy: boolean; writerUncertain?: boolean; send: (message: ClientMessage) => void }) {
  const owner = capacity?.owned[task.id];
  const uncertain = owner?.uncertain || writerUncertain;
  if (!capacity || !uncertain && !capacity.error) return null;
  return <section className="inline-notice" aria-label="Profile capacity recovery">
    <strong>{uncertain ? 'Task writer needs reconciliation' : 'Profile capacity needs attention'}</strong>
    <p>{capacity.error || 'A reservation survived restart or uncertain cleanup. Stop any surviving provider or setup process, including its children, before acknowledging absence.'}</p>
    {uncertain && <button className="secondary" disabled={busy} onClick={() => send({ type: 'reconcileCapacity', id: task.id })}>Acknowledge all task writers stopped</button>}
    <p>Only this task’s reservation can be released here. Other windows retain their slots.</p>
  </section>;
}
