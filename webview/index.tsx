import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientMessage, HelperJobView, Snapshot, Provider, Handoff, OfficialExtensionInfo } from '../src/core/model';
import type { Plan } from '../src/core/plans';
import './styles.css';
import { AgentsCanvas } from './AgentsCanvas';
import { HydraMark } from './HydraMark';

declare function acquireVsCodeApi(): { postMessage(message: ClientMessage): void; getState(): unknown; setState(state: unknown): void };
const api = acquireVsCodeApi();
const send = (message: ClientMessage) => api.postMessage(message);
const initial: Snapshot = { busy: false, mode: 'agents' };
const providerName = (provider: Provider) => provider === 'claude' ? 'Claude Code' : 'Codex';

function Icon({ name }: { name: 'branch' | 'arrow' }) {
  const paths = { branch: 'M4 3v10M4 8c6 0 8-1 8-5M10 3h4M2 3h4M2 13h4', arrow: 'M3 8h10M9 4l4 4-4 4' };
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d={paths[name]} /></svg>;
}

/** A window opened to hand one piece of work to an official extension (Handoff mode). */
function HandoffView({ handoff, info, busy }: { handoff: Handoff; info?: OfficialExtensionInfo; busy: boolean }) {
  const task = handoff.task;
  return <section className="conversation handoff-only" aria-label="Handoff">
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
  </section>;
}

/**
 * The Agents view: a live canvas of the heads your Claude Code and Codex chats
 * start (docs/Agents_View_Plan.md). Heads arrive with each snapshot, and at once
 * through "heads" events when a job changes.
 */
function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [heads, setHeads] = useState<HelperJobView[]>([]);
  // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4): its own block. ----
  const [plans, setPlans] = useState<Plan[]>([]);
  const [newPlanSignal, setNewPlanSignal] = useState(0);
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.data?.type === 'snapshot') { const next = event.data.snapshot as Snapshot; setSnapshot(next); setHeads(next.helpers || []); setPlans(next.plans || []); }
      if (event.data?.type === 'heads') setHeads(event.data.heads as HelperJobView[]);
      if (event.data?.type === 'plans') setPlans(event.data.plans as Plan[]);
      if (event.data?.type === 'showNewPlan') setNewPlanSignal(value => value + 1);
    };
    window.addEventListener('message', listener);
    send({ type: 'ready' });
    return () => window.removeEventListener('message', listener);
  }, []);
  return <main className="app">
    <header className="topbar">
      <div className="wordmark"><HydraMark className="wordmark-mark" />Hydra</div>
      <div className="mode-switch" aria-label="Workspace mode"><button onClick={() => send({ type: 'editor' })}>Editor</button><button className="current" aria-current="page">Agents</button></div>
      <button className="icon-button" title="Hydra settings" aria-label="Hydra settings" onClick={() => send({ type: 'settings' })}>···</button>
    </header>
    {(snapshot.error) && <div className="error" role="alert"><strong>Needs attention</strong><p>{snapshot.error}</p><button onClick={() => send({ type: 'refresh' })}>Retry</button></div>}
    {snapshot.handoff
      ? <HandoffView handoff={snapshot.handoff} info={snapshot.officialExtensions?.find(info => info.provider === snapshot.handoff?.task.provider)} busy={snapshot.busy} />
      : <div className="agents-body"><AgentsCanvas heads={heads} plans={plans} defaultProvider={snapshot.defaultProvider} openNewPlanAt={newPlanSignal}
          onAction={(type, jobId) => send({ type, jobId })} onPlan={send} onStopAll={() => send({ type: 'helperStopAll' })} /></div>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
