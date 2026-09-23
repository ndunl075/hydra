import React, { useEffect, useRef, useState } from 'react';
import type { ClientMessage, Draft, Provider, ProviderInfo, Snapshot } from '../src/core/model';
import type { ModelCatalog, ModelSelection } from '../src/core/modelSelection';
import { SessionThread } from './SessionThread';
import { ModelControls } from './ModelControls';
import { TaskContext } from './TaskContext';
import { pendingSchedule } from '../src/core/scheduler';
import { CapacityStatus } from './CapacityStatus';
import { HydraMark } from './HydraMark';

type Send = (message: ClientMessage) => void;
const empty: Snapshot = { tasks: [], repositories: [], providers: [], files: [], busy: false, mode: 'editor' };
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
const providerLabel: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

function ModelPicker({ selection, provider, catalogs, providers, busy, send, onSelect }: {
  selection: ModelSelection | null; provider: Provider; catalogs: Partial<Record<Provider, ModelCatalog>>; providers: ProviderInfo[]; busy: boolean; send: Send;
  onSelect: (selection: ModelSelection | null, provider: Provider) => void;
}) {
  const label = selection ? `${selection.model} · ${selection.effort}` : 'Provider defaults';
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onToggle = () => {
      if (!element.open) return;
      for (const item of ['claude', 'codex'] as const) {
        const available = providers.find(entry => entry.provider === item)?.available;
        if (available && !catalogs[item]) send({ type: 'checkModelsForProvider', provider: item });
      }
    };
    const onOutsideClick = (event: MouseEvent) => { if (element.open && !element.contains(event.target as Node)) element.open = false; };
    element.addEventListener('toggle', onToggle);
    document.addEventListener('click', onOutsideClick, true);
    return () => { element.removeEventListener('toggle', onToggle); document.removeEventListener('click', onOutsideClick, true); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, catalogs]);
  return <details className="model-picker" ref={ref}>
    <summary title="Model and effort">{label}</summary>
    <div className="model-picker-body">
      {(['claude', 'codex'] as const).map(item => {
        const available = providers.find(entry => entry.provider === item)?.available;
        const catalog = catalogs[item];
        return <div key={item} className="model-picker-group">
          <div className="model-picker-group-header">
            <span>{providerLabel[item]}</span>
            {available && catalog?.status === 'error' && <button type="button" className="text-button" disabled={busy} onClick={() => send({ type: 'checkModelsForProvider', provider: item })}>Retry</button>}
          </div>
          {!available && <p className="form-note">Not connected.</p>}
          {available && catalog?.status === 'checking' && <p className="form-note">Loading…</p>}
          {available && catalog?.status === 'error' && <p role="status" className="session-error">{catalog.error}</p>}
          {available && catalog?.status === 'ready' && !catalog.models.length && <p className="form-note">No models advertised.</p>}
          {available && catalog?.status === 'ready' && catalog.models.map(model => (
            <button key={model.model} type="button" className="model-picker-option" aria-pressed={provider === item && selection?.model === model.model}
              onClick={() => onSelect({ model: model.model, effort: model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0] || '' }, item)}>
              {model.displayName}<span className="muted">{model.defaultEffort}</span>
            </button>
          ))}
        </div>;
      })}
      {selection && <button type="button" className="text-button model-picker-clear" onClick={() => onSelect(null, provider)}>Use provider defaults</button>}
    </div>
  </details>;
}

function NewConversation({ snapshot, send, onSubmit }: { snapshot: Snapshot; send: Send; onSubmit: (selection: ModelSelection | null) => void }) {
  const [draft, setDraft] = useState<Draft>(snapshot.draft || { title: '', prompt: '', provider: 'claude' });
  const [repository, setRepository] = useState(snapshot.repositories[0] || '');
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  useEffect(() => { setRepository(current => snapshot.repositories.includes(current) ? current : snapshot.repositories[0] || ''); }, [snapshot.repositories.join('\0')]);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type !== 'contextAttached' || !Array.isArray(event.data.paths)) return;
      const reference = event.data.paths.map((item: string) => `\`${item}\``).join(' ');
      update({ prompt: `${draft.prompt}${draft.prompt.trim() ? '\n' : ''}Context: ${reference}` });
    };
    window.addEventListener('message', listener); return () => window.removeEventListener('message', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.prompt]);
  const update = (partial: Partial<Draft>) => { const next = { ...draft, ...partial }; setDraft(next); send({ type: 'draft', ...next }); };
  // One prompt creates and starts the task; the branch name comes from the first
  // line of the prompt, which createWorktree slugifies and bounds on its own.
  const title = (draft.prompt.trim().split('\n')[0] || '').slice(0, 120).trim();
  const ready = !snapshot.busy && !!draft.prompt.trim() && !!repository;
  const submit = () => { if (ready) { send({ type: 'create', ...draft, title: title || 'New task', repository, autoStart: true }); onSubmit(selection); } };
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
            <button type="button" className="icon-button" aria-label="Attach context" title="Attach a file to this task" disabled={snapshot.busy} onClick={() => send({ type: 'attachContext' })}>+</button>
            <ModelPicker selection={selection} provider={draft.provider} catalogs={snapshot.draftModelCatalogs || {}} providers={snapshot.providers} busy={snapshot.busy} send={send}
              onSelect={(next, provider) => { setSelection(next); update({ provider }); }} />
            <select className="compact-select" aria-label="Repository" value={repository} onChange={event => setRepository(event.target.value)} disabled={snapshot.busy}>{!snapshot.repositories.length && <option value="">No repository</option>}{snapshot.repositories.map(root => <option key={root} value={root}>{basename(root)}</option>)}</select>
          </div>
          <div className="task-prompt-toolbar-group">
            <button type="button" className="auto-toggle" aria-pressed={snapshot.delegation?.mode === 'auto'} title="Auto planning is being prepared. This task still runs solo." onClick={() => send({ type: 'setDelegationMode', mode: snapshot.delegation?.mode === 'auto' ? 'solo' : 'auto' })}>Auto</button>
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
  // Best-effort for the common single-task creation flow: applies to whichever
  // task next appears selected with no model set. Consumed once, then cleared.
  const pendingSelection = useRef<ModelSelection | null>(null);
  useEffect(() => {
    const listener = (event: MessageEvent) => { if (event.data?.type === 'snapshot') { setSnapshot(event.data.snapshot); setReady(true); } if (event.data?.type === 'taskCreated') setCreating(false); };
    window.addEventListener('message', listener); send({ type: 'ready' }); return () => window.removeEventListener('message', listener);
  }, [send]);
  const tasks = snapshot.tasks.filter(task => task.state !== 'discarded');
  const task = tasks.find(item => item.id === snapshot.selectedId);
  const resource = task && snapshot.resources?.[task.id];
  const busy = snapshot.busy || resource?.status === 'running' || !!resource?.uncertain || !!task && !!snapshot.capacity?.owned[task.id]?.uncertain || !!snapshot.session?.writerUncertain;
  const available = !!snapshot.providers.find(provider => provider.provider === task?.provider)?.available;
  // A task submitted with a picked model applies it once the task's own catalog
  // confirms the model is actually advertised there; the pre-creation picker
  // only previews, it never launches with an unverified selection.
  useEffect(() => {
    const pending = pendingSelection.current;
    if (!pending || !task || task.modelSelection) return;
    const catalog = snapshot.modelCatalogs?.[task.id];
    if (!catalog) { send({ type: 'checkModels', id: task.id }); return; }
    if (catalog.status === 'checking') return;
    if (catalog.status === 'ready' && catalog.models.some(model => model.model === pending.model && model.efforts.includes(pending.effort))) {
      send({ type: 'saveModelSelection', id: task.id, selection: pending });
    }
    pendingSelection.current = null;
  }, [task, snapshot.modelCatalogs, send]);
  return <main className="editor-conversation" aria-label="Editor agent conversation">
    <header className="chat-toolbar">
      <div className="chat-brand" aria-label="Hydra"><HydraMark className="chat-mark" /><span>HYDRA</span></div>
      <div className="mode-switch" aria-label="Workspace mode"><button className="current" aria-current="page">Editor</button><button onClick={() => send({ type: 'agents' })}>Agents</button></div>
      <div className="chat-toolbar-actions"><button className="icon-button" aria-label="New conversation" title="New conversation" onClick={() => setCreating(true)}>+</button><button className="icon-button chat-settings" aria-label="Hydra settings" title="Hydra settings" onClick={() => send({ type: 'settings' })}>...</button></div>
    </header>
    {!!tasks.length && <div className="chat-task-picker"><span className="picker-kicker">CHAT</span><label htmlFor="chat-task">Conversation</label><select id="chat-task" value={creating || !task ? '' : task.id} onChange={event => { if (event.target.value) { setCreating(false); send({ type: 'select', id: event.target.value }); } }}>{(creating || !task) && <option value="">New conversation</option>}{tasks.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></div>}
    {snapshot.error && <div className="chat-error" role="alert">{snapshot.error}</div>}
    {!ready ? <p className="chat-loading" role="status">Loading conversation...</p> : snapshot.handoff ? <div className="chat-start"><h2>External provider workspace</h2><p>This task is managed from its original Hydra window.</p><button className="secondary" onClick={() => send({ type: 'agents' })}>Open handoff details</button></div> : creating || !task ? <NewConversation key={creating ? 'new' : 'empty'} snapshot={snapshot} send={send} onSubmit={selection => { pendingSelection.current = selection; }} /> : <>
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
