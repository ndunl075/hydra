import React, { useEffect, useRef, useState } from 'react';
import type { ClientMessage, Draft, Provider, ProviderInfo, Snapshot } from '../src/core/model';
import type { ModelCatalog, ModelSelection } from '../src/core/modelSelection';
import { ModelPicker, DelegationModePicker, PermissionModePicker, asTaskPermissionMode, isPermissionModeFor, useOutsideClose, type PermissionModeName } from './ComposerPickers';
import { SessionThread } from './SessionThread';
import { pendingSchedule } from '../src/core/scheduler';
import { CapacityStatus } from './CapacityStatus';
import { HydraMark } from './HydraMark';
import { ComposerIcon } from './ComposerIcons';

type Send = (message: ClientMessage) => void;
const empty: Snapshot = { tasks: [], repositories: [], providers: [], files: [], busy: false, mode: 'editor' };
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
function NewConversation({ snapshot, send, onSubmit }: { snapshot: Snapshot; send: Send; onSubmit: (selection: ModelSelection | null, permissionMode: PermissionModeName | null) => void }) {
  const [draft, setDraft] = useState<Draft>(snapshot.draft || { title: '', prompt: '', provider: 'claude' });
  const [repository, setRepository] = useState(snapshot.repositories[0] || '');
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  // Mode names are provider-specific, so a provider switch drops the picked mode
  // back to that provider's default rather than carrying a name it does not have.
  const [permissionMode, setPermissionMode] = useState<PermissionModeName | null>(null);
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
  const submit = () => { if (ready) { send({ type: 'create', ...draft, title: title || 'New task', repository, autoStart: true }); onSubmit(selection, permissionMode); } };
  return <section className="chat-start chat-start-composer">
    <form className="task-prompt-form" onSubmit={event => { event.preventDefault(); submit(); }}>
      <div className="task-prompt-box">
        <textarea className="task-prompt-textarea" autoFocus rows={4} maxLength={32000} value={draft.prompt}
          onChange={event => update({ prompt: event.target.value, brief: undefined })}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }}
          placeholder="Plan, search, build anything" aria-label="Task prompt" disabled={snapshot.busy} />
        <div className="task-prompt-toolbar">
          <div className="task-prompt-toolbar-group">
            <button type="button" className="composer-icon-button" aria-label="Attach context" title="Attach a file to this task" disabled={snapshot.busy} onClick={() => send({ type: 'attachContext' })}><ComposerIcon name="plus" /></button>
            <ModelPicker selection={selection} provider={draft.provider} catalogs={snapshot.draftModelCatalogs || {}} providers={snapshot.providers} busy={snapshot.busy} send={send}
              onSelect={(next, provider) => { setSelection(next); if (provider !== draft.provider) setPermissionMode(null); update({ provider }); }} />
            <DelegationModePicker mode={snapshot.delegation?.mode === 'auto' ? 'auto' : 'solo'} send={send} />
          </div>
          <div className="task-prompt-toolbar-group">
            <PermissionModePicker provider={draft.provider} mode={permissionMode} busy={snapshot.busy} onSelect={setPermissionMode} />
            <button className="task-prompt-send" type="submit" aria-label="Start task" title="Start task" disabled={!ready}><ComposerIcon name="up" /></button>
          </div>
        </div>
      </div>
      <p className="form-note">Enter sends. Shift+Enter adds a line. The agent starts in its own isolated worktree.</p>
      {!snapshot.repositories.length && <p role="status" className="form-note">Open a local Git repository with an initial commit to begin.</p>}
    </form>
  </section>;
}

// Conversation switcher. A native <select> cannot be themed: Chromium hands the
// open list to the OS, which draws its own popup and blue highlight, and the
// click leaves a focus ring on the control. A details menu matches the pickers.
function ConversationMenu({ tasks, currentId, onSelect }: { tasks: Snapshot['tasks']; currentId?: string; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useOutsideClose(ref);
  return <details className="conversation-menu" ref={ref}>
    <summary className="composer-icon-button" aria-label="Conversation history" title="Conversation history"><ComposerIcon name="history" /></summary>
    <div className="mode-picker-body conversation-menu-body">
      {tasks.map(item => (
        <button key={item.id} type="button" className="mode-picker-option" aria-pressed={item.id === currentId}
          onClick={() => { onSelect(item.id); if (ref.current) ref.current.open = false; }}>
          <span className="mode-picker-option-text"><span>{item.title}</span><span className="muted">{item.branch} · {item.state}</span></span>
          {item.id === currentId && <span className="mode-picker-check">✓</span>}
        </button>
      ))}
    </div>
  </details>;
}

export function EditorConversation({ send }: { send: Send }) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  // Best-effort for the common single-task creation flow: applies to whichever
  // task next appears selected with no model set. Consumed once, then cleared.
  const pendingSelection = useRef<ModelSelection | null>(null);
  const pendingPermissionMode = useRef<PermissionModeName | null>(null);
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
  // The mode needs no catalog check: it is a fixed provider vocabulary, so it
  // applies as soon as the created task appears, and only if it still has none.
  useEffect(() => {
    const pending = pendingPermissionMode.current;
    if (!pending || !task || task.permissionMode) return;
    pendingPermissionMode.current = null;
    if (isPermissionModeFor(task.provider, pending)) {
      send({ type: 'savePermissionMode', id: task.id, permissionMode: asTaskPermissionMode(task.provider, pending) });
    }
  }, [task, send]);
  return <main className="editor-conversation" aria-label="Editor agent conversation">
    <header className="chat-toolbar">
      <div className="chat-brand" aria-label="Hydra"><HydraMark className="chat-mark" /><span>HYDRA</span></div>
      <div className="mode-switch" aria-label="Workspace mode"><button className="current" aria-current="page">Editor</button><button onClick={() => send({ type: 'agents' })}>Agents</button></div>
      <div className="chat-toolbar-actions"><button className="icon-button" aria-label="New conversation" title="New conversation" onClick={() => setCreating(true)}>+</button><button className="icon-button chat-settings" aria-label="Hydra settings" title="Hydra settings" onClick={() => send({ type: 'settings' })}>...</button></div>
    </header>
    {/* One quiet line instead of a stack of header rows. The branch and state are
        kept because Hydra runs each agent in its own worktree, which the panel this
        mirrors has no equivalent for; everything else moved into the composer. */}
    {!!tasks.length && <div className="chat-quiet">
      <span className="chat-quiet-title" title={creating || !task ? undefined : task.title}>{creating || !task ? 'New conversation' : task.title}</span>
      {task && !creating && <span className="chat-quiet-branch" title={`${task.worktree}
${basename(task.repository)}`}>{task.branch}</span>}
      {task && !creating && <span className={`state ${task.state}`}>{task.state}</span>}
      <ConversationMenu tasks={tasks} currentId={creating || !task ? undefined : task.id} onSelect={id => { setCreating(false); send({ type: 'select', id }); }} />
    </div>}
    {snapshot.error && <div className="chat-error" role="alert">{snapshot.error}</div>}
    {!ready ? <p className="chat-loading" role="status">Loading conversation...</p> : snapshot.handoff ? <div className="chat-start"><h2>External provider workspace</h2><p>This task is managed from its original Hydra window.</p><button className="secondary" onClick={() => send({ type: 'agents' })}>Open handoff details</button></div> : creating || !task ? <NewConversation key={creating ? 'new' : 'empty'} snapshot={snapshot} send={send} onSubmit={(selection, permissionMode) => { pendingSelection.current = selection; pendingPermissionMode.current = permissionMode; }} /> : <>
      {task.error && <div className="chat-error" role="status">{task.error}</div>}
      {!available && <div className="chat-notice">Provider CLI not found. <button className="text-button" onClick={() => send({ type: 'settings' })}>Set up provider</button></div>}
      {(task.state === 'external' || task.interface === 'official-extension') && <div className="chat-notice">This task is open in an external provider session. <button className="text-button" onClick={() => send({ type: 'agents' })}>Manage session</button></div>}
      {pendingSchedule(task) && task.state !== 'running' && <div className="chat-notice" role="status">{task.schedule?.reason || `Task ${task.schedule?.state}.`}{['queued', 'blocked'].includes(task.schedule?.state || '') && <button className="text-button" disabled={busy} onClick={() => send({ type: 'cancelQueued', id: task.id })}>Cancel queued work</button>}</div>}
      {snapshot.capacity && (snapshot.capacity.error || snapshot.capacity.owned[task.id]?.uncertain || snapshot.session?.writerUncertain) && <div className="chat-notice"><CapacityStatus capacity={snapshot.capacity} task={task} busy={busy} writerUncertain={snapshot.session?.writerUncertain} send={send} /></div>}
      <SessionThread key={task.id} task={task} session={snapshot.session || { version: 1, turns: [] }} busy={busy} available={available} draft={snapshot.conversationDraft} send={send} compact composer={{ catalogs: snapshot.draftModelCatalogs || {}, providers: snapshot.providers, delegationMode: snapshot.delegation?.mode === 'auto' ? 'auto' : 'solo' }} />
    </>}
  </main>;
}
