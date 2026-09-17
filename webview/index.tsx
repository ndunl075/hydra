import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientMessage, Snapshot, Provider, Draft, Handoff, OfficialExtensionInfo } from '../src/core/model';
import './styles.css';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void; getState(): unknown; setState(state: unknown): void };
const api = acquireVsCodeApi();
const send = (message: ClientMessage) => api.postMessage(message);
const initial: Snapshot = { tasks: [], repositories: [], providers: [], files: [], busy: false, mode: 'agents' };
const providerName = (provider: Provider) => provider === 'claude' ? 'Claude Code' : 'Codex';
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
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
    (filter === 'all' || (filter === 'active' ? task.state === 'external' : task.state === 'error' || task.state === 'interrupted')));
  const active = snapshot.tasks.filter(task => task.state === 'external' && task.interface === 'interactive-cli').length;
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
        <div className="rail-bottom"><span><span className={`status-dot ${active ? 'external' : 'idle'}`} />{active} active terminals</span><button className="icon-button" aria-label="Refresh task status" onClick={() => send({ type: 'refresh' })}><Icon name="refresh" /></button></div>
      </aside>
      <section className="conversation" aria-label={creating ? 'New task' : 'Selected task'}>
        {snapshot.error && <div className="error" role="alert"><strong>Needs attention</strong><p>{snapshot.error}</p><button onClick={() => send({ type: 'refresh' })}>Retry</button></div>}
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
          </div>
        </> : <>
          <div className="conversation-header"><div><h2>{selected.title}</h2><span>{providerName(selected.provider)} <span className="separator">/</span> {selected.interface === 'official-extension' ? 'Official extension' : 'Interactive CLI'}</span></div><button className="icon-button" title="New task" aria-label="New task" onClick={() => setCreating(true)}><Icon name="plus" /></button></div>
          <div className="task-context"><Icon name="branch" /><span title={selected.branch}>{selected.branch}</span><span className={`state ${selected.state}`}>{selected.interface === 'official-extension' ? 'External · status unavailable' : selected.state === 'external' ? 'Terminal active' : selected.state}</span></div>
          <div className="thread">
            <article className="message"><div className="message-author"><span className="avatar">N</span><strong>You</strong><time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p className="prompt-text">{selected.prompt}</p></article>
            <article className="system-message"><div className="message-author"><span className="avatar hydra-avatar">h</span><strong>Hydra</strong><span className="local-tag">LOCAL</span></div><p>{selected.interface === 'official-extension' ? `This task is handed off to ${providerName(selected.provider)} in its own workspace window. Stop the provider session there before returning ownership.` : `Task checkout is ready. Open ${providerName(selected.provider)} in the terminal, then paste your prompt to begin.`}</p><div className="task-actions">{selected.interface === 'official-extension' ? <button className="secondary" disabled={snapshot.busy} onClick={() => send({ type: 'releaseExternal', id: selected.id })}>I stopped the external session</button> : <button className="primary" disabled={snapshot.busy || !provider?.available} onClick={() => send({ type: 'launch', id: selected.id })}><Icon name="terminal" />{selected.state === 'external' ? 'Show terminal' : 'Open provider terminal'}</button>}<button className="secondary" onClick={() => send({ type: 'copyPrompt', id: selected.id })}>Copy prompt</button></div>
              {!provider?.available && selected.interface === 'interactive-cli' && <p className="availability">{providerName(selected.provider)} CLI was not found. <button className="text-button" onClick={() => send({ type: 'settings' })}>Set its executable path</button>.</p>}
              <p className="observability">{selected.interface === 'official-extension' ? 'Session progress, approvals, and completion are unavailable to Hydra. History is not transferred automatically.' : 'Conversation and permissions stay in the provider terminal for this prototype. Structured streaming, resume, and usage reporting are not connected yet.'}</p>
            </article>
            <section className="changes" aria-label="Changed files"><div className="section-label">CHANGES <span>{snapshot.files.length}</span></div>{snapshot.files.length ? snapshot.files.map(file => <button className="file-row" key={file.path} onClick={() => send({ type: 'openFile', id: selected.id, path: file.path })}><span className="file-status">{file.status.trim()}</span><span>{file.path}</span><Icon name="arrow" /></button>) : <p className="quiet">No changes yet. Refresh to check this worktree.</p>}<p className="review-note">Files open in the native editor. Full diff review and integration arrive in M4.</p></section>
          </div>
          <footer className="task-footer"><div className="worktree-identity"><span className="section-label">WORKTREE</span><code title={selected.worktree}>{selected.worktree}</code></div><div className="footer-actions"><div className="handoff-actions">{(['claude', 'codex'] as const).map(provider => <button key={provider} className="secondary" disabled={snapshot.busy || selected.state === 'external' || selected.interface === 'official-extension'} onClick={() => send({ type: 'handoff', id: selected.id, provider })}>Open in {providerName(provider)} <Icon name="arrow" /></button>)}</div>{selected.state === 'external' && selected.interface === 'interactive-cli' && <button className="stop-button" onClick={() => send({ type: 'stop', id: selected.id })}>Stop terminal</button>}</div></footer>
        </>}
      </section>
    </div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
