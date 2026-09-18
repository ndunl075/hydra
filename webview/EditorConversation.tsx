import React, { useEffect, useState } from 'react';
import type { ClientMessage, Draft, Provider, Snapshot } from '../src/core/model';
import { SessionThread } from './SessionThread';
import { ModelControls } from './ModelControls';
import { TaskContext } from './TaskContext';
import { pendingSchedule } from '../src/core/scheduler';

type Send = (message: ClientMessage) => void;
const empty: Snapshot = { tasks: [], repositories: [], providers: [], files: [], busy: false, mode: 'editor' };
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;

function NewConversation({ snapshot, send }: { snapshot: Snapshot; send: Send }) {
  const [draft, setDraft] = useState<Draft>(snapshot.draft || { title: '', prompt: '', provider: 'claude' });
  const [repository, setRepository] = useState(snapshot.repositories[0] || '');
  useEffect(() => {
    setRepository(current => snapshot.repositories.includes(current) ? current : snapshot.repositories[0] || '');
  }, [snapshot.repositories.join('\0')]);
  const update = (partial: Partial<Draft>) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    send({ type: 'draft', ...next });
  };
  return <section className="chat-start">
    <div className="chat-introduction"><span className="section-label">NEW CONVERSATION</span><h2>What are we working on?</h2><p>Give your agent a task. Its changes stay in a separate worktree.</p></div>
    <form onSubmit={event => {
      event.preventDefault();
      if (!snapshot.busy && draft.title.trim() && draft.prompt.trim() && repository) send({ type: 'create', ...draft, repository });
    }}>
      <label>Task name<input autoFocus maxLength={120} value={draft.title} onChange={event => update({ title: event.target.value })} placeholder="A short name for this task" disabled={snapshot.busy} /></label>
      <label>Task brief<textarea rows={5} maxLength={32000} value={draft.prompt} onChange={event => update({ prompt: event.target.value, brief: undefined })} placeholder="Describe the change you want to make..." disabled={snapshot.busy} /></label>
      <div className="chat-create-options"><label>Provider<select value={draft.provider} onChange={event => update({ provider: event.target.value as Provider })} disabled={snapshot.busy}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><label>Repository<select value={repository} onChange={event => setRepository(event.target.value)} disabled={snapshot.busy}>{!snapshot.repositories.length && <option value="">No repository</option>}{snapshot.repositories.map(root => <option key={root} value={root}>{basename(root)}</option>)}</select></label></div>
      <button className="primary" disabled={snapshot.busy || !draft.title.trim() || !draft.prompt.trim() || !repository}>Create task</button>
      <p className="form-note">Creates the worktree. Choose Start task when you are ready to send the brief.</p>
      {!snapshot.repositories.length && <p role="status" className="form-note">Open a local Git repository with an initial commit to begin.</p>}
    </form>
  </section>;
}

export function EditorConversation({ send }: { send: Send }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'snapshot') { setSnapshot(event.data.snapshot); setReady(true); }
      if (event.data?.type === 'taskCreated') setCreating(false);
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, [send]);
  const tasks = snapshot.tasks.filter(task => task.state !== 'discarded');
  const task = tasks.find(item => item.id === snapshot.selectedId);
  const resource = task && snapshot.resources?.[task.id];
  const busy = snapshot.busy || resource?.status === 'running' || !!resource?.uncertain;
  const available = !!snapshot.providers.find(provider => provider.provider === task?.provider)?.available;
  return <main className="editor-conversation" aria-label="Editor agent conversation">
    <header className="chat-toolbar">
      <div className="mode-switch" aria-label="Workspace mode"><button className="current" aria-current="page">Editor</button><button onClick={() => send({ type: 'agents' })}>Agents</button></div>
      <button className="icon-button" aria-label="New conversation" title="New conversation" onClick={() => setCreating(true)}>+</button>
      <button className="icon-button" aria-label="Hydra settings" title="Hydra settings" onClick={() => send({ type: 'settings' })}>···</button>
    </header>
    {!!tasks.length && <div className="chat-task-picker"><label htmlFor="chat-task">Conversation</label><select id="chat-task" value={creating || !task ? '' : task.id} onChange={event => { if (event.target.value) { setCreating(false); send({ type: 'select', id: event.target.value }); } }}>{(creating || !task) && <option value="">New conversation</option>}{tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>}
    {snapshot.error && <div className="chat-error" role="alert">{snapshot.error}</div>}
    {!ready ? <p className="chat-loading" role="status">Loading conversation...</p> : snapshot.handoff ? <div className="chat-start"><h2>External provider workspace</h2><p>This task is managed from its original Hydra window.</p><button className="secondary" onClick={() => send({ type: 'agents' })}>Open handoff details</button></div> : creating || !task ? <NewConversation key={creating ? 'new' : 'empty'} snapshot={snapshot} send={send} /> : <>
      <div className="chat-identity"><span title={task.worktree}>{basename(task.repository)} / {task.branch}</span><span className={`state ${task.state}`}>{task.state}</span></div>
      <details className="chat-details"><summary>{task.provider === 'claude' ? 'Claude Code' : 'Codex'}<span>{task.modelSelection ? `${task.modelSelection.model} · ${task.modelSelection.effort}` : 'Provider defaults'}</span></summary><div className="chat-details-body">
        <p className="form-note">Task worktree</p><code className="chat-worktree">{task.worktree}</code>
        <TaskContext key={task.id} task={task} session={snapshot.session} busy={busy} send={send} />
        <ModelControls key={`model-${task.id}`} task={task} session={snapshot.session} catalog={snapshot.modelCatalogs?.[task.id]} busy={busy} send={send} />
        <div className="task-actions"><button className="secondary" onClick={() => send({ type: 'agents' })}>Task details & changes</button><button className="secondary" disabled={busy || !snapshot.session?.turns.length} onClick={() => send({ type: 'showSessionDiagnostics', id: task.id })}>Diagnostics</button></div>
      </div></details>
      {task.error && <div className="chat-error" role="status">{task.error}</div>}
      {!available && <div className="chat-notice">Provider CLI not found. <button className="text-button" onClick={() => send({ type: 'settings' })}>Set up provider</button></div>}
      {(task.state === 'external' || task.interface === 'official-extension') && <div className="chat-notice">This task is open in an external provider session. <button className="text-button" onClick={() => send({ type: 'agents' })}>Manage session</button></div>}
      {pendingSchedule(task) && task.state !== 'running' && <div className="chat-notice" role="status">{task.schedule?.reason || `Task ${task.schedule?.state}.`}{['queued', 'blocked'].includes(task.schedule?.state || '') && <button className="text-button" disabled={busy} onClick={() => send({ type: 'cancelQueued', id: task.id })}>Cancel queued work</button>}</div>}
      <SessionThread key={task.id} task={task} session={snapshot.session || { version: 1, turns: [] }} busy={busy} available={available} draft={snapshot.conversationDraft} send={send} compact />
    </>}
  </main>;
}
