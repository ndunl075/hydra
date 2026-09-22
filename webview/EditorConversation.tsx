import React, { useEffect, useState } from 'react';
import type { ClientMessage, Draft, Provider, Snapshot } from '../src/core/model';
import { SessionThread } from './SessionThread';
import { ModelControls } from './ModelControls';
import { TaskContext } from './TaskContext';
import { pendingSchedule } from '../src/core/scheduler';
import { CapacityStatus } from './CapacityStatus';
import { HydraMark } from './HydraMark';

type Send = (message: ClientMessage) => void;
const empty: Snapshot = { tasks: [], repositories: [], providers: [], files: [], busy: false, mode: 'editor' };
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;

function NewConversation({ snapshot, send }: { snapshot: Snapshot; send: Send }) {
  const [draft, setDraft] = useState<Draft>(snapshot.draft || { title: '', prompt: '', provider: 'claude' });
  const [repository, setRepository] = useState(snapshot.repositories[0] || '');
  useEffect(() => { setRepository(current => snapshot.repositories.includes(current) ? current : snapshot.repositories[0] || ''); }, [snapshot.repositories.join('\0')]);
  const update = (partial: Partial<Draft>) => { const next = { ...draft, ...partial }; setDraft(next); send({ type: 'draft', ...next }); };
  // One prompt creates and starts the task; the branch name comes from the first
  // line of the prompt, which createWorktree slugifies and bounds on its own.
  const title = (draft.prompt.trim().split('\n')[0] || '').slice(0, 120).trim();
  const ready = !snapshot.busy && !!draft.prompt.trim() && !!repository;
  const submit = () => { if (ready) send({ type: 'create', ...draft, title: title || 'New task', repository, autoStart: true }); };
  return <section className="chat-start">
    <div className="chat-introduction"><span className="section-label">NEW AGENT TASK</span><h2>Start from the editor.</h2><p>Give Hydra a focused task. The agent works in its own isolated worktree while your editor stays untouched.</p></div>
    <form className="task-prompt-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="task-prompt-box">
        <textarea className="task-prompt-textarea" autoFocus rows={4} maxLength={32000} value={draft.prompt}
          onChange={event => update({ prompt: event.target.value, brief: undefined })}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }}
          placeholder="Describe the change, constraints, and desired result..." aria-label="Task prompt" disabled={snapshot.busy} />
        <div className="task-prompt-toolbar">
          <div className="task-prompt-toolbar-group">
            <select className="compact-select" aria-label="Provider" value={draft.provider} onChange={event => update({ provider: event.target.value as Provider })} disabled={snapshot.busy}><option value="claude">Claude Code</option><option value="codex">Codex</option></select>
            <select className="compact-select" aria-label="Repository" value={repository} onChange={event => setRepository(event.target.value)} disabled={snapshot.busy}>{!snapshot.repositories.length && <option value="">No repository</option>}{snapshot.repositories.map(root => <option key={root} value={root}>{basename(root)}</option>)}</select>
          </div>
          <div className="task-prompt-toolbar-group">
            <div role="group" aria-label="Delegation mode" className="delegation-pill-group">
              <button type="button" className="delegation-pill" aria-pressed={(snapshot.delegation?.mode || 'solo') === 'solo'} onClick={() => send({ type: 'setDelegationMode', mode: 'solo' })}>Solo</button>
              <button type="button" className="delegation-pill" aria-pressed={snapshot.delegation?.mode === 'auto'} title="Auto planning is being prepared. This task still runs solo." onClick={() => send({ type: 'setDelegationMode', mode: 'auto' })}>Auto</button>
            </div>
            <button className="task-prompt-send" type="submit" aria-label="Start task" title="Start task" disabled={!ready}>↑</button>
          </div>
        </div>
      </div>
      <p className="form-note">Enter sends. Shift+Enter adds a line. The agent starts in its own isolated worktree.</p>
      {!snapshot.repositories.length && <p role="status" className="form-note">Open a local Git repository with an initial commit to begin.</p>}
    </form>
  </section>;
}

export function EditorConversation({ send }: { send: Send }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    const listener = (event: MessageEvent) => { if (event.data?.type === 'snapshot') { setSnapshot(event.data.snapshot); setReady(true); } if (event.data?.type === 'taskCreated') setCreating(false); };
    window.addEventListener('message', listener); send({ type: 'ready' }); return () => window.removeEventListener('message', listener);
  }, [send]);
  const tasks = snapshot.tasks.filter(task => task.state !== 'discarded');
  const task = tasks.find(item => item.id === snapshot.selectedId);
  const resource = task && snapshot.resources?.[task.id];
  const busy = snapshot.busy || resource?.status === 'running' || !!resource?.uncertain || !!task && !!snapshot.capacity?.owned[task.id]?.uncertain || !!snapshot.session?.writerUncertain;
  const available = !!snapshot.providers.find(provider => provider.provider === task?.provider)?.available;
  return <main className="editor-conversation" aria-label="Editor agent conversation">
    <header className="chat-toolbar">
      <div className="chat-brand" aria-label="Hydra"><HydraMark className="chat-mark" /><span>HYDRA</span></div>
      <div className="mode-switch" aria-label="Workspace mode"><button className="current" aria-current="page">Editor</button><button onClick={() => send({ type: 'agents' })}>Agents</button></div>
      <div className="chat-toolbar-actions"><button className="icon-button" aria-label="New conversation" title="New conversation" onClick={() => setCreating(true)}>+</button><button className="icon-button chat-settings" aria-label="Hydra settings" title="Hydra settings" onClick={() => send({ type: 'settings' })}>...</button></div>
    </header>
    {!!tasks.length && <div className="chat-task-picker"><span className="picker-kicker">CHAT</span><label htmlFor="chat-task">Conversation</label><select id="chat-task" value={creating || !task ? '' : task.id} onChange={event => { if (event.target.value) { setCreating(false); send({ type: 'select', id: event.target.value }); } }}>{(creating || !task) && <option value="">New conversation</option>}{tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>}
    {snapshot.error && <div className="chat-error" role="alert">{snapshot.error}</div>}
    {!ready ? <p className="chat-loading" role="status">Loading conversation...</p> : snapshot.handoff ? <div className="chat-start"><h2>External provider workspace</h2><p>This task is managed from its original Hydra window.</p><button className="secondary" onClick={() => send({ type: 'agents' })}>Open handoff details</button></div> : creating || !task ? <NewConversation key={creating ? 'new' : 'empty'} snapshot={snapshot} send={send} /> : <>
      <div className="chat-identity"><div><span className="chat-project" title={task.worktree}>{basename(task.repository)}</span><span className="chat-separator">/</span><span className="chat-branch" title={task.branch}>{task.branch}</span></div><span className={`state ${task.state}`}>{task.state}</span></div>
      <details className="chat-details"><summary><span className="provider-badge">{task.provider === 'claude' ? 'C' : 'O'}</span><span>{task.provider === 'claude' ? 'Claude Code' : 'Codex'}</span><span className="chat-model">{task.modelSelection ? `${task.modelSelection.model} · ${task.modelSelection.effort}` : 'Provider defaults'}</span></summary><div className="chat-details-body">
        <p className="form-note">Isolated worktree</p><code className="chat-worktree">{task.worktree}</code>
        <TaskContext key={task.id} task={task} session={snapshot.session} busy={busy} send={send} />
        <ModelControls key={`model-${task.id}`} task={task} session={snapshot.session} catalog={snapshot.modelCatalogs?.[task.id]} busy={busy} send={send} />
        <div className="task-actions"><button className="secondary" onClick={() => send({ type: 'agents' })}>Task details & changes</button><button className="secondary" disabled={busy || !snapshot.session?.turns.length} onClick={() => send({ type: 'showSessionDiagnostics', id: task.id })}>Diagnostics</button></div>
      </div></details>
      {task.error && <div className="chat-error" role="status">{task.error}</div>}
      {!available && <div className="chat-notice">Provider CLI not found. <button className="text-button" onClick={() => send({ type: 'settings' })}>Set up provider</button></div>}
      {(task.state === 'external' || task.interface === 'official-extension') && <div className="chat-notice">This task is open in an external provider session. <button className="text-button" onClick={() => send({ type: 'agents' })}>Manage session</button></div>}
      {pendingSchedule(task) && task.state !== 'running' && <div className="chat-notice" role="status">{task.schedule?.reason || `Task ${task.schedule?.state}.`}{['queued', 'blocked'].includes(task.schedule?.state || '') && <button className="text-button" disabled={busy} onClick={() => send({ type: 'cancelQueued', id: task.id })}>Cancel queued work</button>}</div>}
      {snapshot.capacity && (snapshot.capacity.error || snapshot.capacity.owned[task.id]?.uncertain || snapshot.session?.writerUncertain) && <div className="chat-notice"><CapacityStatus capacity={snapshot.capacity} task={task} busy={busy} writerUncertain={snapshot.session?.writerUncertain} send={send} /></div>}
      <SessionThread key={task.id} task={task} session={snapshot.session || { version: 1, turns: [] }} busy={busy} available={available} draft={snapshot.conversationDraft} send={send} compact />
    </>}
  </main>;
}
