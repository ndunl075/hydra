import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientMessage, HelperJobView, LaneLimitOfferView, LaneServerMessage, LaneView, Snapshot, Provider, Handoff, OfficialExtensionInfo } from '../src/core/model';
import type { Plan } from '../src/core/plans';
import type { JobCheckResult } from '../src/core/jobs';
import './styles.css';
import { AgentsBody, type AgentsViewName } from './AgentsBody';
import type { LaneSwitchCountdown } from './LanesView';
import { HydraMark } from './HydraMark';
import { emitLaneEvent } from './laneBus';

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
/** The Canvas | Lanes view, remembered across reloads (docs/Lanes_And_Planner_Plan.md, section 2). */
function initialView(): AgentsViewName {
  try { const state = api.getState() as { view?: string } | undefined; return state?.view === 'lanes' ? 'lanes' : 'canvas'; } catch { return 'canvas'; }
}

function App() {
  const [snapshot, setSnapshot] = useState(initial);
  const [heads, setHeads] = useState<HelperJobView[]>([]);
  // ---- Canvas tidy-up (docs/Lanes_And_Planner_Plan.md, "Canvas tidy-up"): the Finished tray's Clear button. ----
  const [dismissedTray, setDismissedTray] = useState<string[]>([]);
  // ---- Planner (docs/Lanes_And_Planner_Plan.md, section 4): its own block. ----
  const [plans, setPlans] = useState<Plan[]>([]);
  const [newPlanSignal, setNewPlanSignal] = useState(0);
  // ---- Lanes (docs/Lanes_And_Planner_Plan.md, sections 1-2): its own block. ----
  const [view, setView] = useState<AgentsViewName>(initialView);
  const [lanes, setLanes] = useState<LaneView[]>([]);
  const [terminals, setTerminals] = useState(true);
  const [laneError, setLaneError] = useState<string>();
  const [laneFocus, setLaneFocus] = useState<string>();
  // ---- The usage-limit banner and the onLimit:"switch" countdown (docs/Gates_Plan.md, section 2), by lane id ----
  const [laneLimits, setLaneLimits] = useState<Record<string, LaneLimitOfferView>>({});
  const [laneSwitchCountdowns, setLaneSwitchCountdowns] = useState<Record<string, LaneSwitchCountdown>>({});
  // ---- A gates run in progress on a lane (docs/Gates_Plan.md, "Lanes"): the tile header's "Gates: unit ✓ · review …" ----
  const [laneGates, setLaneGates] = useState<Record<string, { done: JobCheckResult[]; running?: string }>>({});
  const [headFocus, setHeadFocus] = useState<{ id: string; at: number }>();
  const changeView = (next: AgentsViewName, focus?: string) => {
    setView(next);
    try { api.setState({ view: next }); } catch { /* private windows: state just isn't remembered */ }
    send({ type: 'view', view: next, ...(focus ? { focus } : {}) });
  };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'snapshot') { const next = data.snapshot as Snapshot; setSnapshot(next); setHeads(next.helpers || []); setPlans(next.plans || []); setDismissedTray(next.dismissedTray || []); }
      if (data?.type === 'heads') setHeads(data.heads as HelperJobView[]);
      if (data?.type === 'plans') setPlans(data.plans as Plan[]);
      if (data?.type === 'showNewPlan') setNewPlanSignal(value => value + 1);
      // ---- Lanes: 'lanes'/'show' update React state; 'laneData'/'laneReplay' skip it entirely (the lane bus writes straight into xterm). ----
      const lane = data as LaneServerMessage | undefined;
      if (lane?.type === 'lanes') { setLanes(lane.lanes); setTerminals(lane.terminals); }
      if (lane?.type === 'laneError') setLaneError(lane.message);
      if (lane?.type === 'laneData' || lane?.type === 'laneReplay') emitLaneEvent({ type: lane.type, id: lane.id, data: lane.data });
      if (lane?.type === 'laneLimit') setLaneLimits(current => {
        if (!lane.offer) { if (!(lane.id in current)) return current; const { [lane.id]: _removed, ...rest } = current; return rest; }
        return { ...current, [lane.id]: lane.offer };
      });
      if (lane?.type === 'laneSwitchCountdown') setLaneSwitchCountdowns(current => ({ ...current, [lane.id]: { to: lane.to, deadline: lane.deadline } }));
      if (lane?.type === 'laneSwitchCancelled') setLaneSwitchCountdowns(current => { if (!(lane.id in current)) return current; const { [lane.id]: _removed, ...rest } = current; return rest; });
      if (lane?.type === 'laneGates') setLaneGates(current => {
        if (!lane.running && !lane.done.length) { if (!(lane.id in current)) return current; const { [lane.id]: _removed, ...rest } = current; return rest; }
        return { ...current, [lane.id]: { done: lane.done, ...(lane.running ? { running: lane.running } : {}) } };
      });
      if (lane?.type === 'show') {
        setView(lane.view);
        try { api.setState({ view: lane.view }); } catch { /* ignore */ }
        if (lane.focus) { if (lane.view === 'lanes') setLaneFocus(lane.focus); else setHeadFocus({ id: lane.focus, at: Date.now() }); }
      }
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
      : <AgentsBody view={view} onViewChange={changeView} heads={heads} dismissedTray={dismissedTray} plans={plans} lanes={lanes} terminals={terminals} defaultProvider={snapshot.defaultProvider}
          laneError={laneError} laneFocus={laneFocus} onLaneFocused={() => setLaneFocus(undefined)} laneLimits={laneLimits} laneSwitchCountdowns={laneSwitchCountdowns} laneGates={laneGates} openNewPlanAt={newPlanSignal} focusHead={headFocus}
          onAction={(type, jobId) => send({ type, jobId })} onPlan={send} onStopAll={() => send({ type: 'helperStopAll' })}
          onOpenLane={id => { setLaneFocus(id); changeView('lanes', id); }} onSend={send} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
