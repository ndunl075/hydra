import { pendingSchedule } from '../src/core/scheduler';
import { ScheduleControls } from './ScheduleControls';
import { CapacityStatus } from './CapacityStatus';
import { ResourceControls } from './ResourceControls';
import { BudgetControls } from './BudgetControls';
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentMap } from './AgentMap';
import { BriefFields, PromptPreview, TaskContext, UsagePanel } from './TaskContext';
import { buildTaskPrompt, emptyBrief } from '../src/core/taskContext';
import { ModelControls } from './ModelControls';
import { IntegrationPanel } from './IntegrationPanel';
import type { DiscardReview } from '../src/core/discard';
import { diffLabels, type ClientMessage, type Snapshot, type Provider, type Draft, type Handoff, type OfficialExtensionInfo, type ProviderDiagnostic, type Task, type SessionView, type TaskFile, type PreparedReview } from '../src/core/model';
import './styles.css';
import { SessionThread } from './SessionThread';
import { FocusedWorkspace } from './FocusedWorkspace';
import { EditorConversation } from './EditorConversation';
import './editor-conversation.css';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void; getState(): unknown; setState(state: unknown): void };
const api = acquireVsCodeApi();
const send = (message: ClientMessage) => api.postMessage(message);
const initial: Snapshot = { tasks: [], repositories: [], providers: [], files: [], busy: false, mode: 'agents' };
const providerName = (provider: Provider) => provider === 'claude' ? 'Claude Code' : 'Codex';
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
function ProviderCheck({ provider, diagnostic }: { provider: Provider; diagnostic?: ProviderDiagnostic }) {
  return <section className="provider-check" aria-label={`${providerName(provider)} capabilities`}>
    <div className="section-label">PROVIDER CHECK <span>{diagnostic?.version || 'Not verified'}</span></div>
    <div className="diagnostic-actions"><button className="text-button" disabled={diagnostic?.status === 'checking'} onClick={() => send({ type: 'checkProvider', provider })}>{diagnostic?.status === 'checking' ? 'Checking…' : `Check ${providerName(provider)}`}</button>{diagnostic && diagnostic.status !== 'checking' && <button className="text-button" onClick={() => send({ type: 'showProviderDiagnostics', provider })}>View diagnostics</button>}</div>
    {diagnostic?.error && <p role="status">{diagnostic.error}</p>}
    {diagnostic?.status === 'checked' && <p role="status">CLI help advertises: {diagnostic.advertised.join(', ') || 'No recognized structured options'}. These are not verified Hydra session capabilities.</p>}
    <p className="quiet">Checks read public version and help output only. They make no model request or authentication check. Managed sessions require Claude 2.1.270 or Codex 0.154.0. Supported approval requests appear in the conversation.</p>
  </section>;
}
function Icon({ name }: { name: 'plus' | 'branch' | 'terminal' | 'arrow' | 'refresh' | 'search' | 'close' | 'folder' }) {
  const paths = {
    plus: 'M8 2v12M2 8h12', branch: 'M4 3v10M4 8c6 0 8-1 8-5M10 3h4M2 3h4M2 13h4',
    terminal: 'M2 4l4 4-4 4M8 12h6', arrow: 'M3 8h10M9 4l4 4-4 4',
    refresh: 'M13 6a5 5 0 1 0 0 5M13 2v4H9', search: 'M11 11l3 3M12 7a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
    close: 'M3 3l10 10M13 3L3 13', folder: 'M2 4h5l2 2h5v7H2z'
  };
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}
function HandoffView({ handoff, info, busy }: { handoff: Handoff; info?: OfficialExtensionInfo; busy: boolean }) {
  const task = handoff.task;
  return <>
    <div className="conversation-header"><div><h2>{task.title}</h2><span>{providerName(task.provider)} <span className="separator">/</span> Official extension</span></div><span>External session</span></div>
    <div className="task-context"><Icon name="branch" /><span title={task.branch}>{task.branch}</span></div>
    <div className="thread">
      <div className="eyebrow">TASK WORKSPACE</div><h2 className="handoff-heading">You're in the right checkout.</h2>
      <p className="intro">Open {providerName(task.provider)} here, then paste your task prompt when you're ready. Its login, conversation, and approvals stay with the official extension.</p>
      <div className="handoff-actions"><button className="primary" disabled={busy || !info?.commandAvailable} onClick={() => send({ type: 'openOfficial' })}>Open {providerName(task.provider)} <Icon name="arrow" /></button><button className="secondary" disabled={busy} onClick={() => send({ type: 'copyHandoffPrompt' })}>Copy task prompt</button></div>
      {!info?.installed ? <p className="availability">The official extension isn't enabled in this window. <button className="text-button" onClick={() => send({ type: 'showOfficial' })}>Find official extension</button>.</p> : <p className="form-note">Installed version: {info.version || 'Unavailable'}.{!info.commandAvailable && ` Use the Command Palette and select “${info.commandTitle}”.`}</p>}
      <article className="handoff-prompt"><div className="section-label">TASK PROMPT</div><p className="prompt-text">{task.prompt}</p></article>
      <p className="form-note">Hydra cannot observe or stop work inside the official extension. Before returning this task to the CLI, stop its session here and acknowledge the handback in the original Hydra window. History is not transferred automatically.</p>
    </div>
    <footer className="task-footer"><div className="worktree-identity"><span className="section-label">WORKTREE</span><code title={task.worktree}>{task.worktree}</code></div></footer>
  </>;
}
function Changes({ task, files, busy, prepared }: { task: Task; files: TaskFile[]; busy: boolean; prepared?: PreparedReview }) {
  const [message, setMessage] = useState('');
  const blocked = pendingSchedule(task) || busy || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension';
  return <section className="changes" aria-label="Changed files">
    <div className="section-label">CHANGES <span>{files.length}</span><button className="text-button" onClick={() => send({ type: 'refresh' })}>Refresh</button></div>
    {files.length ? files.map(file => <div className="change-row" key={file.path}>
      <div className="change-path"><span className="file-status">{file.status.trim()}</span><span title={file.path}>{file.path}</span><button className="text-button" title={`Open ${file.path} in the native editor`} onClick={() => send({ type: 'openFile', id: task.id, path: file.path })}>Open file</button></div>
      <div className="change-layers">{file.changes?.map(change => <button className="diff-button" key={change.layer} disabled={blocked} title={`${change.beforePath ? `${change.beforePath} → ` : ''}${change.path} · ${diffLabels[change.layer]}`} onClick={() => send({ type: 'openDiff', id: task.id, path: change.path, layer: change.layer })}>{diffLabels[change.layer]} <Icon name="arrow" /></button>)}</div>
    </div>) : <p className="quiet">No changes yet. Refresh to check this worktree.</p>}
    <p className="review-note">{blocked ? 'Stop the task writer or acknowledge official-extension handback to review changes.' : 'Choose a layer to open a read-only native diff. Saved files exclude unsaved editor buffers. Snapshots stay fixed; reopen after edits. Binary and large files show metadata.'}</p>
    <section className="commit-review" aria-label="Reviewed task commit">
      <div className="section-label">REVIEWED COMMIT</div>
      <p className="quiet">Stage all saved task changes first. Preparing captures the complete task tree, including earlier commits. It makes no model request.</p>
      <button className="secondary" disabled={blocked} onClick={() => send({ type: 'prepareCommitReview', id: task.id })}>{prepared ? 'Prepare fresh review' : 'Prepare commit review'}</button>
      {prepared && <>
        <p className="quiet" role="status">Prepared tree <code>{prepared.tree.slice(0, 8)}</code> · {prepared.files.length} files. Inspect these fixed snapshots before committing.</p>
        {prepared.files.map(file => <div className="change-row" key={file.path}><div className="change-path"><span className="file-status">{file.status}</span><span title={file.path}>{file.path}</span><button className="diff-button" disabled={blocked} onClick={() => send({ type: 'openCommitReview', id: task.id, token: prepared.token, path: file.path })}>Review snapshot <Icon name="arrow" /></button></div></div>)}
        <form onSubmit={event => { event.preventDefault(); if (message.trim()) send({ type: 'commitReviewed', id: task.id, token: prepared.token, message }); }}>
          <label>Commit message<input maxLength={500} value={message} disabled={blocked} onChange={event => setMessage(event.target.value)} placeholder={`Complete ${task.title}`} /></label>
          <button className="primary" type="submit" disabled={blocked || !message.trim()}>Commit reviewed tree</button>
          <p className="quiet">Records your review of this exact tree. If already committed, records the current commit. Changed files or unsaved buffers require another review. Git hooks still apply.</p>
        </form>
      </>}
      {task.reviewedCommit && <p className="quiet" role="status">Recorded reviewed commit <code>{task.reviewedCommit.commit.slice(0, 8)}</code>. Later edits require a fresh review.</p>}
    </section>
  </section>;
}
function DiscardControls({ task, review, busy }: { task: Task; review?: DiscardReview; busy: boolean }) {
  if (task.state === 'discarded') return <section className="changes" aria-label="Discarded task">
    <h3>Task discarded</h3>
    <p>This task has left active work. Its checkout, branch, ignored files and local diagnostics are retained.</p>
    <p className="quiet">Discarded {task.discard && new Date(task.discard.discardedAt).toLocaleString()} · head <code>{task.discard?.head.slice(0, 8)}</code>. The record describes the saved state at discard; retained files may have changed since.</p>
    <p><code className="retained-checkout">{task.worktree}</code></p>
    <div className="task-actions"><button className="secondary" disabled={busy} onClick={() => send({ type: 'copyDiscardLocation', id: task.id })}>Copy retained checkout path</button><button className="primary" disabled={busy} onClick={() => send({ type: 'restoreDiscarded', id: task.id })}>Restore task</button></div>
    <p className="quiet">Restore returns an interrupted task for inspection. It makes no provider request and starts no process. Retained checkouts use disk space.</p>
  </section>;
  const blocked = busy || pendingSchedule(task) || !!task.schedule?.request || task.state === 'running' || task.state === 'external' || task.interface === 'official-extension';
  return <section className="changes discard-controls" aria-label="Discard task">
    <div className="section-label">DISCARD TASK</div>
    <p className="quiet">Review saved changes before removing this task from active work. Its complete checkout and branch remain available for recovery.</p>
    <button className="secondary" disabled={blocked} onClick={() => send({ type: 'prepareDiscard', id: task.id })}>{review ? 'Prepare fresh discard review' : 'Review discard'}</button>
    {review && <>
      <p role="status">Task head <code>{review.head.slice(0, 8)}</code> · target <code>{review.targetCommit.slice(0, 8)}</code></p>
      <details open><summary>{review.unmergedCommits.length} unmerged commits</summary>{review.unmergedCommits.length ? <ul>{review.unmergedCommits.map(item => <li key={item.commit}><code>{item.commit.slice(0, 8)}</code> {item.subject}</li>)}</ul> : <p className="quiet">No commits outside the target branch.</p>}</details>
      <details open><summary>{review.changes.length} saved changed files</summary>{review.changes.length ? <ul>{review.changes.map(file => <li key={file.path}><code>{file.status}</code> <span>{file.path}</span></li>)}</ul> : <p className="quiet">No staged, unstaged or untracked changes.</p>}</details>
      <p className="quiet">Ignored files and integration candidates are retained. Unsaved task buffers must be saved or reverted. A changed task or target requires a fresh review.</p>
      <button className="stop-button" disabled={blocked} onClick={() => send({ type: 'confirmDiscard', id: task.id, token: review.token })}>Discard task…</button>
      <p className="quiet">A confirmation identifies this task and checkout. Discard and restore make no model requests.</p>
    </>}
  </section>;
}
function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState<Draft>({ title: '', prompt: '', provider: 'claude' });
  const [repository, setRepository] = useState('');
  const [startingCommit, setStartingCommit] = useState('');
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'snapshot') {
        const next = event.data.snapshot as Snapshot;
        setSnapshot(next);
        if (next.tasks.find(task => task.id === next.selectedId)?.state !== 'discarded') setFilter(current => current === 'discarded' ? 'all' : current);
        setRepository(current => next.repositories.includes(current) ? current : next.repositories[0] || '');
        if (next.draft) setDraft(next.draft);
        if (next.tasks.length === 0 && !next.handoff) setCreating(true);
      }
      if (event.data?.type === 'newTask') setCreating(true);
      if (event.data?.type === 'taskCreated') setCreating(false);
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  const updateDraft = (partial: Partial<Draft>) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    send({ type: 'draft', ...next });
  };
  const selected = snapshot.tasks.find(task => task.id === snapshot.selectedId);
  const tasks = snapshot.tasks.filter(task => (filter === 'discarded' ? task.state === 'discarded' : task.state !== 'discarded') && `${task.title} ${task.branch} ${task.provider}`.toLowerCase().includes(search.toLowerCase()) &&
    (filter === 'all' || filter === 'discarded' || (filter === 'active' ? task.state === 'external' || task.state === 'running' || snapshot.resources?.[task.id]?.status === 'running' : task.state === 'error' || task.state === 'interrupted' || snapshot.resources?.[task.id]?.uncertain || snapshot.capacity?.owned[task.id]?.uncertain || !!snapshot.taskActivity?.[task.id]?.awaitingApproval || task.schedule?.state === 'blocked' || task.schedule?.state === 'interrupted')));
  const active = snapshot.tasks.filter(task => task.state === 'running' || task.state === 'external' && task.interface === 'interactive-cli').length + Object.values(snapshot.resources || {}).filter(resource => resource.status === 'running' || resource.uncertain).length;
  const taskBusy = snapshot.busy || !!selected && (snapshot.resources?.[selected.id]?.status === 'running' || !!snapshot.resources?.[selected.id]?.uncertain || !!snapshot.capacity?.owned[selected.id]?.uncertain || !!snapshot.session?.writerUncertain);
  const provider = snapshot.providers.find(item => item.provider === selected?.provider);
  return <main className="app">
    <header className="topbar">
      <div className="wordmark"><span className="logo" aria-hidden="true">h</span>hydra<span className="build">PROTOTYPE</span></div>
      <div className="mode-switch" aria-label="Workspace mode"><button onClick={() => send({ type: 'editor' })}>Editor</button><button className="current" aria-current="page">Agents</button></div>
      <button className="icon-button" title="Hydra settings" aria-label="Hydra settings" onClick={() => send({ type: 'settings' })}>···</button>
    </header>
    {!snapshot.handoff && snapshot.tasks.some(task => task.state !== 'discarded') && <AgentMap snapshot={{ ...snapshot, tasks: snapshot.tasks.filter(task => task.state !== 'discarded') }} selectedId={creating ? undefined : selected?.id} onSelect={id => { setCreating(false); send({ type: 'select', id }); }} />}
    <div className="workspace">
      <aside className="task-rail" aria-label="Tasks">
        <div className="rail-header"><h1>Tasks <span>{snapshot.tasks.length}</span></h1><button className="icon-button" disabled={!!snapshot.handoff} aria-label="New task" title="New task" onClick={() => setCreating(true)}><Icon name="plus" /></button></div>
        <label className="search"><Icon name="search" /><input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="filters" aria-label="Filter tasks">{[['all', 'All'], ['active', 'Active'], ['attention', 'Attention'], ['discarded', 'Discarded']].map(([id, label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id || 'all')}>{label}</button>)}</div>
        <nav className="task-list" aria-label="Task selection">
          {snapshot.repositories.map(repo => <section key={repo} className="repo-group">
            <div className="repo-label"><Icon name="folder" />{basename(repo)}</div>
            {tasks.filter(task => task.repository === repo).map(task => <button key={task.id} className={`task ${selected?.id === task.id && !creating ? 'selected' : ''}`} aria-current={selected?.id === task.id && !creating ? 'true' : undefined} onClick={() => { setCreating(false); send({ type: 'select', id: task.id }); }}>
              <span className="task-title"><span className={`status-dot ${task.state}`} />{task.title}</span>
              <span className="task-meta">{providerName(task.provider)}<span>{task.state === 'external' ? task.interface === 'official-extension' ? 'External' : 'Terminal' : task.schedule?.state || task.state}</span></span>
              <span className="task-branch">{task.branch.replace('agent/', '')}</span>
            </button>)}
          </section>)}
          {tasks.length === 0 && <p className="rail-empty">{snapshot.handoff ? 'Manage task ownership in the original Hydra window.' : search || filter !== 'all' ? 'No matching tasks.' : 'Your tasks will appear here.'}</p>}
        </nav>
        {snapshot.capacity && <p className="observability" role="status">{snapshot.capacity.reserved ?? 'Unknown'} / {snapshot.capacity.limit} profile slots reserved</p>}
        <div className="rail-bottom"><span><span className={`status-dot ${active ? 'external' : 'idle'}`} />{active} active writers</span><button className="icon-button" aria-label="Refresh task status" onClick={() => send({ type: 'refresh' })}><Icon name="refresh" /></button></div>
      </aside>
      <section className="conversation" aria-label={creating ? 'New task' : 'Selected task'}>
        {(snapshot.error || selected?.error) && <div className="error" role="alert"><strong>Needs attention</strong><p>{snapshot.error || selected?.error}</p><button onClick={() => send({ type: 'refresh' })}>Retry</button></div>}
        {snapshot.handoff ? <HandoffView handoff={snapshot.handoff} info={snapshot.officialExtensions?.find(info => info.provider === snapshot.handoff?.task.provider)} busy={snapshot.busy} /> : creating || !selected ? <>
          <div className="conversation-header"><span>New task</span>{selected && <button className="icon-button" aria-label="Cancel new task" onClick={() => setCreating(false)}><Icon name="close" /></button>}</div>
          <div className="new-task-body"><div className="eyebrow">A SEPARATE BRANCH. A CLEAR GOAL.</div><h2>What are we working on?</h2><p className="intro">Give an agent a focused task. Hydra keeps its checkout separate while you keep working.</p>
            <form onSubmit={event => { event.preventDefault(); send({ type: 'create', ...draft, repository, startingCommit }); }}>
              <label>Repository<select value={repository} onChange={event => setRepository(event.target.value)} required><option value="" disabled>Select repository</option>{snapshot.repositories.map(repo => <option key={repo} value={repo}>{basename(repo)} · {repo}</option>)}</select></label>
              <label>Task title<input autoFocus value={draft.title} maxLength={120} onChange={event => updateDraft({ title: event.target.value })} placeholder="e.g. Fix keyboard navigation" required /></label>
              <BriefFields brief={draft.brief || { ...emptyBrief(), goal: draft.prompt }} onChange={brief => updateDraft({ brief, prompt: buildTaskPrompt(brief) })} disabled={snapshot.busy} />
              <PromptPreview prompt={draft.prompt} />
              <fieldset className="delegation-control"><legend>Agent delegation</legend><div role="group" aria-label="Delegation mode"><button type="button" className="secondary" aria-pressed={(snapshot.delegation?.mode || 'solo') === 'solo'} onClick={() => send({ type: 'setDelegationMode', mode: 'solo' })}>Solo</button><button type="button" className="secondary" aria-pressed={snapshot.delegation?.mode === 'auto'} onClick={() => send({ type: 'setDelegationMode', mode: 'auto' })}>Auto</button></div><p className="form-note">Auto planning is being prepared. This task still runs solo.</p></fieldset>
              <div className="form-bottom"><label className="provider-select">Provider<select value={draft.provider} onChange={event => updateDraft({ provider: event.target.value as Provider })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><button className="primary" type="submit" disabled={snapshot.busy || !repository || draft.prompt.length > 32000}>Create task <Icon name="arrow" /></button></div>
              {draft.prompt.length > 32000 && <p role="alert">Shorten the complete brief to 32,000 characters.</p>}
              <p className="form-note">Starts from committed HEAD. Uncommitted edits stay in your main checkout. Creating a task makes no model request.</p>
              <p className="form-note">Model and effort start with official provider settings. After creating a Codex task, load available models to choose an explicit managed selection.</p>
            </form>
            {snapshot.repositories.length === 0 && <div className="inline-notice">Open a local Git repository with an initial commit to create tasks.</div>}
            <label>Starting commit (optional full SHA)<input maxLength={64} value={startingCommit} onChange={event => setStartingCommit(event.target.value)} placeholder="Defaults to current repository HEAD" /></label>
            <ProviderCheck provider={draft.provider} diagnostic={snapshot.diagnostics?.find(item => item.provider === draft.provider)} />
          </div>
        </> : <>
          <div className="conversation-header"><div><h2>{selected.title}</h2><span>{providerName(selected.provider)} <span className="separator">/</span> {selected.interface === 'official-extension' ? 'Official extension' : selected.interface === 'managed-cli' ? 'Managed CLI' : 'Interactive CLI'}</span></div><button className="icon-button" title="New task" aria-label="New task" onClick={() => setCreating(true)}><Icon name="plus" /></button></div>
          <div className="task-context"><Icon name="branch" /><span title={selected.branch}>{selected.branch}</span><span className={`state ${selected.state}`}>{selected.interface === 'official-extension' ? 'External · status unavailable' : selected.state === 'external' ? 'Terminal active' : selected.state}</span></div>
          <div className="thread">
            <CapacityStatus capacity={snapshot.capacity} task={selected} busy={snapshot.busy} writerUncertain={snapshot.session?.writerUncertain} send={send} />
            <ResourceControls key={`resources-${selected.id}-${JSON.stringify(snapshot.resources?.[selected.id]?.config || {})}`} task={selected} saved={snapshot.resources?.[selected.id]} busy={snapshot.busy} send={send} />
            {selected.state === 'discarded' ? <DiscardControls task={selected} busy={taskBusy} /> : <>
            <FocusedWorkspace task={selected} files={snapshot.files} session={snapshot.session} />
            <TaskContext key={selected.id} task={selected} session={snapshot.session} busy={taskBusy} send={send} />
            <ModelControls key={`models-${selected.id}`} task={selected} session={snapshot.session} catalog={snapshot.modelCatalogs?.[selected.id]} busy={taskBusy} send={send} />
            <UsagePanel task={snapshot.usage?.tasks[selected.id]} project={snapshot.usage?.projects[selected.repository]} delegationRun={snapshot.usage?.delegationRuns?.[selected.delegation?.parentId || selected.id]} send={send} />
            <BudgetControls key={`budgets-${selected.id}`} task={selected} settings={snapshot.budgets?.settings} observations={snapshot.budgets?.observations[selected.id]} busy={taskBusy} send={send} />
            {snapshot.session?.turns.length && selected.interface !== 'official-extension' ? <SessionThread key={selected.id} task={selected} session={snapshot.session} busy={taskBusy} draft={snapshot.conversationDraft} send={send} /> : <>
            <article className="message"><div className="message-author"><span className="avatar">N</span><strong>You</strong><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p className="prompt-text">{selected.prompt}</p></article>
            <article className="system-message"><div className="message-author"><span className="avatar hydra-avatar">h</span><strong>Hydra</strong><span className="local-tag">LOCAL</span></div><p>{selected.interface === 'official-extension' ? `This task is handed off to ${providerName(selected.provider)} in its own workspace window. Stop the provider session there before returning ownership.` : `Task checkout is ready. Open ${providerName(selected.provider)} in the terminal, then paste your prompt to begin.`}</p><div className="task-actions">{selected.interface === 'official-extension' ? <button className="secondary" disabled={taskBusy} onClick={() => send({ type: 'releaseExternal', id: selected.id })}>I stopped the external session</button> : <button className="primary" disabled={taskBusy || !provider?.available} onClick={() => send({ type: 'launch', id: selected.id })}><Icon name="terminal" />{selected.state === 'external' ? 'Show terminal' : 'Open provider terminal'}</button>}<button className="secondary" onClick={() => send({ type: 'copyPrompt', id: selected.id })}>Copy prompt</button></div>
              {!provider?.available && selected.interface === 'interactive-cli' && <p className="availability">{providerName(selected.provider)} CLI was not found. <button className="text-button" onClick={() => send({ type: 'settings' })}>Set its executable path</button>.</p>}
              <p className="observability">{selected.interface === 'official-extension' ? 'Session progress, approvals, and completion are unavailable to Hydra. History is not transferred automatically.' : 'The terminal uses the official provider interface. Start a managed session below to stream the conversation in Hydra.'}</p>
              {selected.interface !== 'official-extension' && <><button className="secondary" disabled={taskBusy || selected.state === 'external' || !provider?.available} onClick={() => send({ type: 'startManaged', id: selected.id })}>Start managed {providerName(selected.provider)} <Icon name="arrow" /></button><p className="observability">{selected.provider === 'claude' ? 'Submits the task to Claude CLI 2.1.270 after checking effective settings. Review supported command and file approval requests here; other interactions require the official client.' : 'Submits the task to Codex CLI 0.154.0 with a worktree sandbox and restricted network. Review approval requests here. Requires provider login and Windows sandbox readiness.'}</p></>}
              {selected.interface === 'interactive-cli' && <ProviderCheck provider={selected.provider} diagnostic={snapshot.diagnostics?.find(item => item.provider === selected.provider)} />}
            </article>
            </>}
            <ScheduleControls key={`schedule-${selected.id}`} task={selected} tasks={snapshot.tasks} busy={taskBusy} send={send} />
            <Changes key={selected.id} task={selected} files={snapshot.files} busy={taskBusy} prepared={snapshot.commitReview} />
            <IntegrationPanel key={`integration-${selected.id}`} task={selected} operation={snapshot.integration} busy={taskBusy} send={send} />
            <DiscardControls key={`discard-${selected.id}`} task={selected} review={snapshot.discardReview} busy={taskBusy} />
            </>}
          </div>
          <footer className="task-footer"><div className="worktree-identity"><span className="section-label">WORKTREE</span><code title={selected.worktree}>{selected.worktree}</code></div>{selected.state !== 'discarded' && <div className="footer-actions"><div className="handoff-actions">{(['claude', 'codex'] as const).map(provider => <button key={provider} className="secondary" disabled={taskBusy || selected.state === 'external' || selected.state === 'running' || selected.interface === 'official-extension'} onClick={() => send({ type: 'handoff', id: selected.id, provider })}>Open in {providerName(provider)} <Icon name="arrow" /></button>)}</div>{selected.state === 'external' && selected.interface === 'interactive-cli' && <button className="stop-button" onClick={() => send({ type: 'stop', id: selected.id })}>Stop terminal</button>}</div>}</footer>
        </>}
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(document.body.dataset.surface === 'editor' ? <EditorConversation send={send} /> : <App />);
