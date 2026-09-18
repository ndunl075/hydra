import React, { useEffect, useState } from 'react';
import type { ClientMessage, Task } from '../src/core/model';

export function ScheduleControls({ task, tasks, busy, send }: { task: Task; tasks: Task[]; busy: boolean; send(message: ClientMessage): void }) {
  const [dependencies, setDependencies] = useState(task.schedule?.dependencies || []);
  const [start, setStart] = useState(task.schedule?.startFromDependency || '');
  useEffect(() => { setDependencies(task.schedule?.dependencies || []); setStart(task.schedule?.startFromDependency || ''); }, [task.id, JSON.stringify(task.schedule?.dependencies), task.schedule?.startFromDependency]);
  const schedule = task.schedule;
  const locked = busy || task.state === 'discarded' || task.state === 'running' || task.state === 'external' || !!schedule?.uncertain || schedule?.state === 'starting';
  return <section className="provider-check schedule-controls" aria-label="Task scheduling">
    <div className="section-label">SCHEDULING <span>{task.interface === 'official-extension' ? 'External session' : schedule?.state || 'Not queued'}</span></div>
    <p className="quiet">Terminal and managed launches share this window's configured capacity (default two). Official-extension sessions run externally. Provider completion does not establish acceptance.</p>
    {schedule?.reason && <p role="status">{schedule.reason}</p>}
    {schedule?.budgetWarnings?.map(warning => <p role="status" key={warning}>{warning} New work is allowed by this warning setting.</p>)}
    {schedule?.budgetHold && <button className="secondary" disabled={locked} onClick={() => send({ type: 'retryBudgetHold', id: task.id })}>Retry held launch</button>}
    {schedule?.state === 'queued' && <p role="status">Waiting for capacity or reviewed prerequisites. Hydra will launch automatically when eligible.</p>}
    {!!schedule?.actualStartingCommit && <p className="quiet">Last launch started at <code>{schedule.actualStartingCommit}</code></p>}
    {schedule?.artifacts.map(artifact => <p className="quiet" key={artifact.taskId}>Reviewed prerequisite: {tasks.find(item => item.id === artifact.taskId)?.title || artifact.taskId} <code>{artifact.commit}</code></p>)}
    {schedule?.uncertain && <button className="secondary" disabled={busy} onClick={() => send({ type: 'reconcileWriter', id: task.id })}>Acknowledge stopped writer</button>}
    {schedule && ['queued', 'blocked'].includes(schedule.state) && <button className="secondary" disabled={locked} onClick={() => send({ type: 'cancelQueued', id: task.id })}>Cancel queued launch</button>}
    <form onSubmit={event => { event.preventDefault(); send({ type: 'configureSchedule', id: task.id, dependencies, startFromDependency: start || undefined }); }}>
      <fieldset disabled={locked}><legend>Prerequisite tasks</legend>
        {tasks.filter(item => item.id !== task.id && item.repository === task.repository && (item.state !== 'discarded' || dependencies.includes(item.id))).map(item => <label key={item.id}><input type="checkbox" checked={dependencies.includes(item.id)} onChange={event => { setDependencies(event.target.checked ? [...dependencies, item.id] : dependencies.filter(id => id !== item.id)); if (!event.target.checked && start === item.id) setStart(''); }} />{item.title}{item.state === 'discarded' ? ' · discarded; remove or restore' : item.reviewedCommit ? ` · reviewed ${item.reviewedCommit.commit.slice(0, 8)}` : ' · awaiting review'}</label>)}
        <label>Initial checkout<select value={start} onChange={event => setStart(event.target.value)}><option value="">Keep selected starting commit</option>{dependencies.map(id => <option key={id} value={id}>Start from {tasks.find(item => item.id === id)?.title || id}</option>)}</select></label>
        <button className="secondary" type="submit">{schedule?.state === 'blocked' ? 'Accept dependencies and retry queue' : 'Save dependencies'}</button>
      </fieldset>
      <p className="quiet">Saving explicitly accepts the current reviewed prerequisite results. Starting from one result requires an unstarted, clean task and a fast-forward; Hydra does not merge multiple prerequisites automatically.</p>
    </form>
  </section>;
}
