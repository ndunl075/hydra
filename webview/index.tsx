import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientMessage, Snapshot, Provider, Draft, Handoff, OfficialExtensionInfo, ProviderDiagnostic, Task, SessionView } from '../src/core/model';
import './styles.css';

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
    <p className="quiet">Checks read public version and help output only. They make no model request or authentication check. Managed sessions require Claude 2.1.270 or Codex 0.154.0. Codex command, network, and file approvals appear in the conversation.</p>
  </section>;
}
function SessionThread({ task, session, busy }: { task: Task; session: SessionView; busy: boolean }) {
  const [prompt, setPrompt] = useState('');
  const running = task.state === 'running' || !!session.active;
  const blocked = busy || running || task.state === 'external' || task.interface === 'official-extension' || !!task.sessionProvider && task.sessionProvider !== task.provider;
  return <>
    {(session.totalTurns || session.turns.length) > 10 && <p className="quiet">Showing the latest ten turns. Full conversation and process events remain in local storage.</p>}
    {session.turns.slice(-10).map(turn => <React.Fragment key={turn.id}>
      <article className="message"><div className="message-author"><span className="avatar">N</span><strong>You</strong><time dateTime={turn.createdAt}>{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p className="prompt-text">{turn.prompt}</p></article>
      <article className="message assistant-message"><div className="message-author"><span className="avatar hydra-avatar">c</span><strong>{providerName(turn.provider || 'claude')}</strong><span className="local-tag">{turn.status === 'completed' ? 'TURN FINISHED' : turn.status.toUpperCase()}</span></div><p className="prompt-text">{turn.text || (turn.status === 'running' ? 'Waiting for provider output…' : 'No response text returned.')}</p>
        {turn.error && <p className="session-error" role="status">{turn.error}</p>}
        {turn.textTruncated && <p className="session-note">Showing the first 50,000 characters here. Full output is retained in local raw diagnostics; model context is unchanged.</p>}
        {!!turn.permissionDenials && <p className="session-note">{turn.permissionDenials} permission request(s) denied. Interactive approvals are unavailable here; use the provider terminal when needed.</p>}
        {turn.usage && <p className="session-note">Provider-reported tokens: {turn.usage.input.toLocaleString()} input · {turn.usage.output.toLocaleString()} output{turn.usage.cacheRead !== undefined && ` · ${turn.usage.cacheRead.toLocaleString()} cache read`}{turn.usage.cacheCreated !== undefined && ` · ${turn.usage.cacheCreated.toLocaleString()} cache created`}{turn.usage.estimatedUsd !== undefined && ` · $${turn.usage.estimatedUsd.toFixed(4)} provider estimate, not your bill`}</p>}
      </article>
    </React.Fragment>)}
    {session.approvals?.map(approval => <article key={approval.id} className="approval-request" aria-label={`${approval.kind} approval`}>
      <div className="section-label">{approval.kind.toUpperCase()} APPROVAL</div><p>Review this request before allowing Codex to proceed.</p><pre>{approval.detail}</pre>
      <div className="task-actions"><button className="secondary" disabled={!running} onClick={() => send({ type: 'approve', id: task.id, approvalId: approval.id, decision: 'accept' })}>Allow this request</button><button className="stop-button" disabled={!running} onClick={() => send({ type: 'approve', id: task.id, approvalId: approval.id, decision: 'decline' })}>Decline</button></div>
    </article>)}
    {!!task.sessionProvider && task.sessionProvider !== task.provider && <p role="status">This recorded session belongs to {providerName(task.sessionProvider)}. Create a separate task for {providerName(task.provider)}.</p>}
    <form className="follow-up" onSubmit={event => { event.preventDefault(); if (prompt.trim()) { send({ type: 'followUp', id: task.id, prompt }); setPrompt(''); } }}>
      <label>Follow-up<textarea rows={3} maxLength={32000} value={prompt} disabled={blocked || !task.sessionId} onChange={event => setPrompt(event.target.value)} placeholder="Continue this task in its recorded provider session." /></label>
      <div className="task-actions">{task.sessionId ? <button className="primary" disabled={blocked || !prompt.trim()} type="submit">Send follow-up <Icon name="arrow" /></button> : <button className="primary" disabled={blocked} type="button" onClick={() => send({ type: 'startManaged', id: task.id })}>Retry managed task</button>}<button className="secondary" type="button" disabled={busy} onClick={() => send({ type: 'showSessionDiagnostics', id: task.id })}>Raw diagnostics</button>{running ? <button className="stop-button" disabled={busy} type="button" onClick={() => send({ type: 'stop', id: task.id })}>Stop process</button> : <button className="secondary" type="button" disabled={blocked} onClick={() => send({ type: 'launch', id: task.id })}>Open provider terminal</button>}</div>
      <p className="form-note">Sending submits a model request. Follow-ups resume the recorded session after its process has ended. {task.provider === 'codex' ? 'Stop requests an interrupt, then terminates the owned process if needed. Approvals grant only the displayed request; unsupported prompts stop the turn.' : 'Stop process terminates the process tree. Provider rules and hooks still apply; unresolved permissions are denied.'}</p>
    </form>
  </>;
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
function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState<Draft>({ title: '', prompt: '', provider: 'claude' });
  const [repository, setRepository] = useState('');
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'snapshot') {
        const next = event.data.snapshot as Snapshot;
        setSnapshot(next);
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
  const tasks = snapshot.tasks.filter(task => `${task.title} ${task.branch} ${task.provider}`.toLowerCase().includes(search.toLowerCase()) &&
    (filter === 'all' || (filter === 'active' ? task.state === 'external' || task.state === 'running' : task.state === 'error' || task.state === 'interrupted')));
  const active = snapshot.tasks.filter(task => task.state === 'running' || task.state === 'external' && task.interface === 'interactive-cli').length;
  const provider = snapshot.providers.find(item => item.provider === selected?.provider);
  return <main className="app">
    <header className="topbar">
      <div className="wordmark"><span className="logo" aria-hidden="true">h</span>hydra<span className="build">PROTOTYPE</span></div>
      <div className="mode-switch" aria-label="Workspace mode"><button onClick={() => send({ type: 'editor' })}>Editor</button><button className="current" aria-current="page">Agents</button></div>
      <button className="icon-button" title="Hydra settings" aria-label="Hydra settings" onClick={() => send({ type: 'settings' })}>···</button>
    </header>
    <div className="workspace">
      <aside className="task-rail" aria-label="Tasks">
        <div className="rail-header"><h1>Tasks <span>{snapshot.tasks.length}</span></h1><button className="icon-button" disabled={!!snapshot.handoff} aria-label="New task" title="New task" onClick={() => setCreating(true)}><Icon name="plus" /></button></div>
        <label className="search"><Icon name="search" /><input aria-label="Search tasks" placeholder="Search tasks…" value={search} onChange={event => setSearch(event.target.value)} /></label>
        <div className="filters" aria-label="Filter tasks">{[['all', 'All'], ['active', 'Active'], ['attention', 'Attention']].map(([id, label]) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'selected' : ''} onClick={() => setFilter(id || 'all')}>{label}</button>)}</div>
        <nav className="task-list" aria-label="Task selection">
          {snapshot.repositories.map(repo => <section key={repo} className="repo-group">
            <div className="repo-label"><Icon name="folder" />{basename(repo)}</div>
            {tasks.filter(task => task.repository === repo).map(task => <button key={task.id} className={`task ${selected?.id === task.id && !creating ? 'selected' : ''}`} aria-current={selected?.id === task.id && !creating ? 'true' : undefined} onClick={() => { setCreating(false); send({ type: 'select', id: task.id }); }}>
              <span className="task-title"><span className={`status-dot ${task.state}`} />{task.title}</span>
              <span className="task-meta">{providerName(task.provider)}<span>{task.state === 'external' ? task.interface === 'official-extension' ? 'External' : 'Terminal' : task.state}</span></span>
              <span className="task-branch">{task.branch.replace('agent/', '')}</span>
            </button>)}
          </section>)}
          {tasks.length === 0 && <p className="rail-empty">{snapshot.handoff ? 'Manage task ownership in the original Hydra window.' : search || filter !== 'all' ? 'No matching tasks.' : 'Your tasks will appear here.'}</p>}
        </nav>
        <div className="rail-bottom"><span><span className={`status-dot ${active ? 'external' : 'idle'}`} />{active} active writers</span><button className="icon-button" aria-label="Refresh task status" onClick={() => send({ type: 'refresh' })}><Icon name="refresh" /></button></div>
      </aside>
      <section className="conversation" aria-label={creating ? 'New task' : 'Selected task'}>
        {(snapshot.error || selected?.error) && <div className="error" role="alert"><strong>Needs attention</strong><p>{snapshot.error || selected?.error}</p><button onClick={() => send({ type: 'refresh' })}>Retry</button></div>}
        {snapshot.handoff ? <HandoffView handoff={snapshot.handoff} info={snapshot.officialExtensions?.find(info => info.provider === snapshot.handoff?.task.provider)} busy={snapshot.busy} /> : creating || !selected ? <>
          <div className="conversation-header"><span>New task</span>{selected && <button className="icon-button" aria-label="Cancel new task" onClick={() => setCreating(false)}><Icon name="close" /></button>}</div>
          <div className="new-task-body"><div className="eyebrow">A SEPARATE BRANCH. A CLEAR GOAL.</div><h2>What are we working on?</h2><p className="intro">Give an agent a focused task. Hydra keeps its checkout separate while you keep working.</p>
            <form onSubmit={event => { event.preventDefault(); send({ type: 'create', ...draft, repository }); }}>
              <label>Repository<select value={repository} onChange={event => setRepository(event.target.value)} required><option value="" disabled>Select repository</option>{snapshot.repositories.map(repo => <option key={repo} value={repo}>{basename(repo)} · {repo}</option>)}</select></label>
              <label>Task title<input autoFocus value={draft.title} maxLength={120} onChange={event => updateDraft({ title: event.target.value })} placeholder="e.g. Fix keyboard navigation" required /></label>
              <label>Task prompt<textarea rows={6} value={draft.prompt} maxLength={32000} onChange={event => updateDraft({ prompt: event.target.value })} placeholder="Describe the goal, relevant files, constraints, and how to verify the result." required /></label>
              <div className="form-bottom"><label className="provider-select">Provider<select value={draft.provider} onChange={event => updateDraft({ provider: event.target.value as Provider })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><button className="primary" type="submit" disabled={snapshot.busy || !repository}>Create task <Icon name="arrow" /></button></div>
              <p className="form-note">Starts from committed HEAD. Uncommitted edits stay in your main checkout. Creating a task makes no model request.</p>
            </form>
            {snapshot.repositories.length === 0 && <div className="inline-notice">Open a local Git repository with an initial commit to create tasks.</div>}
            <ProviderCheck provider={draft.provider} diagnostic={snapshot.diagnostics?.find(item => item.provider === draft.provider)} />
          </div>
        </> : <>
          <div className="conversation-header"><div><h2>{selected.title}</h2><span>{providerName(selected.provider)} <span className="separator">/</span> {selected.interface === 'official-extension' ? 'Official extension' : selected.interface === 'managed-cli' ? 'Managed CLI' : 'Interactive CLI'}</span></div><button className="icon-button" title="New task" aria-label="New task" onClick={() => setCreating(true)}><Icon name="plus" /></button></div>
          <div className="task-context"><Icon name="branch" /><span title={selected.branch}>{selected.branch}</span><span className={`state ${selected.state}`}>{selected.interface === 'official-extension' ? 'External · status unavailable' : selected.state === 'external' ? 'Terminal active' : selected.state}</span></div>
          <div className="thread">
            {snapshot.session?.turns.length && selected.interface !== 'official-extension' ? <SessionThread key={selected.id} task={selected} session={snapshot.session} busy={snapshot.busy} /> : <>
            <article className="message"><div className="message-author"><span className="avatar">N</span><strong>You</strong><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p className="prompt-text">{selected.prompt}</p></article>
            <article className="system-message"><div className="message-author"><span className="avatar hydra-avatar">h</span><strong>Hydra</strong><span className="local-tag">LOCAL</span></div><p>{selected.interface === 'official-extension' ? `This task is handed off to ${providerName(selected.provider)} in its own workspace window. Stop the provider session there before returning ownership.` : `Task checkout is ready. Open ${providerName(selected.provider)} in the terminal, then paste your prompt to begin.`}</p><div className="task-actions">{selected.interface === 'official-extension' ? <button className="secondary" disabled={snapshot.busy} onClick={() => send({ type: 'releaseExternal', id: selected.id })}>I stopped the external session</button> : <button className="primary" disabled={snapshot.busy || !provider?.available} onClick={() => send({ type: 'launch', id: selected.id })}><Icon name="terminal" />{selected.state === 'external' ? 'Show terminal' : 'Open provider terminal'}</button>}<button className="secondary" onClick={() => send({ type: 'copyPrompt', id: selected.id })}>Copy prompt</button></div>
              {!provider?.available && selected.interface === 'interactive-cli' && <p className="availability">{providerName(selected.provider)} CLI was not found. <button className="text-button" onClick={() => send({ type: 'settings' })}>Set its executable path</button>.</p>}
              <p className="observability">{selected.interface === 'official-extension' ? 'Session progress, approvals, and completion are unavailable to Hydra. History is not transferred automatically.' : 'The terminal uses the official provider interface. Start a managed session below to stream the conversation in Hydra.'}</p>
              {selected.interface !== 'official-extension' && <><button className="secondary" disabled={snapshot.busy || selected.state === 'external' || !provider?.available} onClick={() => send({ type: 'startManaged', id: selected.id })}>Start managed {providerName(selected.provider)} <Icon name="arrow" /></button><p className="observability">{selected.provider === 'claude' ? 'Submits the task to Claude CLI 2.1.270. Unresolved permissions are denied; no interactive approval controls.' : 'Submits the task to Codex CLI 0.154.0 with a worktree sandbox and restricted network. Review approval requests here. Requires provider login and Windows sandbox readiness.'}</p></>}
              {selected.interface === 'interactive-cli' && <ProviderCheck provider={selected.provider} diagnostic={snapshot.diagnostics?.find(item => item.provider === selected.provider)} />}
            </article>
            </>}
            <section className="changes" aria-label="Changed files"><div className="section-label">CHANGES <span>{snapshot.files.length}</span></div>{snapshot.files.length ? snapshot.files.map(file => <button className="file-row" key={file.path} onClick={() => send({ type: 'openFile', id: selected.id, path: file.path })}><span className="file-status">{file.status.trim()}</span><span>{file.path}</span><Icon name="arrow" /></button>) : <p className="quiet">No changes yet. Refresh to check this worktree.</p>}<p className="review-note">Files open in the native editor. Full diff review and integration arrive in M4.</p></section>
          </div>
          <footer className="task-footer"><div className="worktree-identity"><span className="section-label">WORKTREE</span><code title={selected.worktree}>{selected.worktree}</code></div><div className="footer-actions"><div className="handoff-actions">{(['claude', 'codex'] as const).map(provider => <button key={provider} className="secondary" disabled={snapshot.busy || selected.state === 'external' || selected.state === 'running' || selected.interface === 'official-extension'} onClick={() => send({ type: 'handoff', id: selected.id, provider })}>Open in {providerName(provider)} <Icon name="arrow" /></button>)}</div>{selected.state === 'external' && selected.interface === 'interactive-cli' && <button className="stop-button" onClick={() => send({ type: 'stop', id: selected.id })}>Stop terminal</button>}</div></footer>
        </>}
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
