import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, HelperJobView, LaneView, Provider } from '../src/core/model';
import { buildCanvas, elapsedLabel, gateChip, headStatus, isActive, layout, type CanvasHead, type CanvasLead, type CanvasPlanJob, type CanvasPlanNode } from '../src/core/agentsCanvas';
// Type-only (see the note in agentsCanvas.ts): plans.ts's storage code must never
// enter this browser bundle, so only PlanJob's shape crosses this boundary.
import type { Plan, PlanJob } from '../src/core/plans';
import { ProviderLogo } from './ProviderLogo';
import './agents-canvas.css';

/**
 * The Agents view (docs/Agents_View_Plan.md): a live canvas of the heads your
 * Claude Code and Codex chats start. Blank until a chat starts heads; each head
 * grows out of its chat, shows what it's doing, and leaves when it's merged.
 * The canvas never starts work itself.
 */
export type HeadAction = 'helperReview' | 'helperLog' | 'helperCancel' | 'helperAnswer' | 'helperEvidence';
const leaveMs = 650;
const edgeStart = (x: number, y: number) => ({ x, y: y + 34 });
const curve = (x1: number, y1: number, x2: number, y2: number) => { const mid = (x1 + x2) / 2; return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`; };
/** A conflict edge bows out to the left of both lane leads, clear of the head columns to their right. */
const conflictCurve = (x1: number, y1: number, x2: number, y2: number) => { const bow = 46; return `M${x1} ${y1} C${x1 - bow} ${y1} ${x2 - bow} ${y2} ${x2} ${y2}`; };

interface Ghost { head: CanvasHead; to: { x: number; y: number }; until: number }
interface LeadGhost { lead: CanvasLead; until: number }
/** A chat stays briefly after its last head, so the heads visibly fold back into it. */
const leadGraceMs = 1200;

/** Planner (docs/Lanes_And_Planner_Plan.md, section 4): a job-edit popover's own form state. */
interface JobPopoverState { planId: string; job: PlanJob; x: number; y: number }
interface JobMenuState { planId: string; job: PlanJob; x: number; y: number }

export function AgentsCanvas({ heads, plans = [], lanes = [], defaultProvider, onAction, onPlan = () => {}, onStopAll, openNewPlanAt, onOpenLane, focusHead }: {
  heads: readonly HelperJobView[];
  plans?: readonly Plan[];
  /** Open lanes (docs/Lanes_And_Planner_Plan.md, section 2): every one is a lead node, even with no heads. */
  lanes?: readonly LaneView[];
  defaultProvider?: Provider;
  onAction: (action: HeadAction, jobId: string) => void;
  onPlan?: (message: ClientMessage) => void;
  onStopAll?: () => void;
  /** Bumped by index.tsx when the extension asks (hydra.newPlan / "showNewPlan"): opens the New plan card. */
  openNewPlanAt?: number;
  /** Clicking a lane node: switch to Lanes and focus that tile. */
  onOpenLane?: (laneId: string) => void;
  /** A `show` message asked to focus a head on the canvas (bumped each time, so the same id can be re-focused). */
  focusHead?: { id: string; at: number };
}) {
  const [now, setNow] = useState(() => Date.now());
  const [still, setStill] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [filter, setFilter] = useState<'running' | 'today'>('running');
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [leadGhosts, setLeadGhosts] = useState<LeadGhost[]>([]);
  // ---- Planner UI state (docs/Lanes_And_Planner_Plan.md, section 4): its own block. ----
  const [newPlan, setNewPlan] = useState<{ title: string; brief: string }>();
  const [jobPopover, setJobPopover] = useState<JobPopoverState>();
  const [jobMenu, setJobMenu] = useState<JobMenuState>();
  const dragging = useRef<{ planId: string; key: string } | undefined>(undefined);
  const previousLeads = useRef(new Map<string, CanvasLead>());
  // When each head was first drawn: for its first moments it grows out of its chat.
  const enteredAt = useRef(new Map<string, number>());
  const previous = useRef(new Map<string, { head: CanvasHead; lead?: CanvasLead }>());
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | undefined>(undefined);
  // Until you zoom or pan, the canvas fits every head into the space it has (a short pane, a terminal open below).
  const [manual, setManual] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBox({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // One clock drives elapsed times, the finished-head timeout, and clearing heads that have collapsed away.
  useEffect(() => { const timer = setInterval(() => { setNow(Date.now()); setGhosts(current => current.some(ghost => ghost.until <= Date.now()) ? current.filter(ghost => ghost.until > Date.now()) : current); setLeadGhosts(current => current.some(ghost => ghost.until <= Date.now()) ? current.filter(ghost => ghost.until > Date.now()) : current); }, 250); return () => clearInterval(timer); }, []);
  const model = useMemo(() => buildCanvas(heads, now, { plans, lanes }), [heads, now, plans, lanes]);
  useEffect(() => {
    if (manual || !box.width || !box.height || (!model.heads.length && !model.plans.length)) return;
    const fit = Math.min(1, (box.width - 24) / model.width, (box.height - 24) / model.height);
    setZoom(Math.max(.4, +fit.toFixed(2)));
    setPan({ x: 0, y: 0 });
  }, [manual, box, model.width, model.height, model.heads.length, model.plans.length]);
  const leadAt = new Map(model.leads.map(lead => [lead.key, lead]));
  const headAt = new Map(model.heads.map(item => [item.id, item]));
  const planAt = new Map(model.plans.map(node => [node.plan.id, node]));
  const planJobAt = new Map(model.plans.flatMap(node => node.jobs.map(job => [job.id, job] as const)));

  // The New plan card: opened by its toolbar button, or by the extension (hydra.newPlan / "showNewPlan").
  useEffect(() => { if (openNewPlanAt) setNewPlan(current => current ?? { title: '', brief: '' }); }, [openNewPlanAt]);
  useEffect(() => {
    if (!newPlan) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setNewPlan(undefined); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [newPlan !== undefined]);
  const openJobMenu = (planId: string, job: PlanJob, x: number, y: number) => setJobMenu({ planId, job, x, y });
  const openJobPopover = (planId: string, job: PlanJob, x: number, y: number) => setJobPopover({ planId, job, x, y });
  const startDependencyDrag = (planId: string, key: string) => (event: React.PointerEvent) => {
    event.stopPropagation();
    dragging.current = { planId, key };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };
  const endDependencyDrag = (event: React.PointerEvent) => {
    const drag = dragging.current;
    dragging.current = undefined;
    if (!drag) return;
    const target = (document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null)?.closest('[data-plan-job]');
    const dropped = target ? planJobAt.get(target.getAttribute('data-plan-job') || '') : undefined;
    if (dropped && dropped.planId === drag.planId && dropped.job.key !== drag.key) onPlan({ type: 'planAddDependency', id: drag.planId, key: dropped.job.key, dependsOn: drag.key });
  };
  const removePlanEdge = (kind: string, from: string, to: string) => {
    if (kind !== 'plan-dependency') return;
    const dependency = planJobAt.get(from), dependent = planJobAt.get(to);
    if (dependency && dependent) onPlan({ type: 'planRemoveDependency', id: dependent.planId, key: dependent.job.key, dependsOn: dependency.job.key });
  };

  // Heads that just left the canvas collapse back into their chat before they disappear.
  useEffect(() => {
    const leaving: Ghost[] = [];
    for (const [id, was] of previous.current) {
      if (headAt.has(id)) continue;
      const lead = leadAt.get(was.head.lead) || was.lead;
      leaving.push({ head: was.head, to: lead ? { x: lead.x, y: lead.y } : { x: was.head.x, y: was.head.y }, until: Date.now() + leaveMs });
    }
    previous.current = new Map(model.heads.map(item => [item.id, { head: item, lead: leadAt.get(item.lead) }]));
    const gone = [...previousLeads.current.values()].filter(lead => !leadAt.has(lead.key));
    previousLeads.current = new Map(model.leads.map(lead => [lead.key, lead]));
    if (gone.length) setLeadGhosts(current => [...current.filter(ghost => !gone.some(lead => lead.key === ghost.lead.key) && !leadAt.has(ghost.lead.key)), ...gone.map(lead => ({ lead, until: Date.now() + leadGraceMs }))]);
    if (leaving.length) {
      setGhosts(current => [...current.filter(ghost => !leaving.some(item => item.head.id === ghost.head.id)), ...leaving]);
    }
  }, [model]);
  const clock = Date.now();
  for (const item of model.heads) if (!enteredAt.current.has(item.id)) enteredAt.current.set(item.id, clock);
  const fresh = model.heads.filter(item => clock - enteredAt.current.get(item.id)! < 700).map(item => item.id);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => { if (!(event.target as HTMLElement).closest?.('.canvas-menu')) setMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(undefined); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => {
    if (!jobMenu) return;
    const close = (event: Event) => { if (!(event.target as HTMLElement).closest?.('.canvas-menu')) setJobMenu(undefined); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setJobMenu(undefined); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape); };
  }, [jobMenu]);
  useEffect(() => {
    if (!jobPopover) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setJobPopover(undefined); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [jobPopover !== undefined]);

  const reveal = (id: string) => {
    setSelected(id);
    const item = headAt.get(id);
    const box = viewport.current;
    if (!item || !box) return;
    setManual(true);
    setPan({ x: Math.min(0, box.clientWidth / 2 - (item.x + layout.headWidth / 2) * zoom), y: Math.min(0, box.clientHeight / 2 - (item.y + 40) * zoom) });
  };
  useEffect(() => { if (focusHead) reveal(focusHead.id); }, [focusHead?.at]);
  const openMenu = (id: string, x: number, y: number) => { setSelected(id); setMenu({ id, x, y }); };
  const menuHead = menu ? heads.find(head => head.id === menu.id) : undefined;
  const ordered = model.heads.map(item => item.id);
  const onNodeKey = (event: React.KeyboardEvent, id: string) => {
    if (event.key === 'Enter') { event.preventDefault(); onAction('helperReview', id); }
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(id, rect.left + 24, rect.top + 24); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = ordered[(ordered.indexOf(id) + (event.key === 'ArrowDown' ? 1 : ordered.length - 1)) % ordered.length];
      if (next) { setSelected(next); document.getElementById(`head-${next}`)?.focus(); }
    }
  };

  const running = heads.filter(isActive);
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
  const listed = (filter === 'running' ? running : heads.filter(head => Date.parse(head.createdAt) >= dayStart.getTime()))
    .slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const lingering = leadGhosts.filter(ghost => !leadAt.has(ghost.lead.key));
  const laneLeads = model.leads.filter(lead => lead.kind === 'lane');
  const empty = !model.heads.length && !ghosts.length && !lingering.length && !model.plans.length && !laneLeads.length;

  return <section className={`agents-canvas${still ? ' still' : ''}`} aria-label="Agents">
    <div className="canvas-stage">
      <div className="canvas-toolbar">
        <div className="canvas-title"><strong>Agents</strong><span>{running.length ? `${running.length} ${running.length === 1 ? 'head' : 'heads'} working` : model.heads.length ? 'Nothing working' : 'Idle'}</span></div>
        <div className="canvas-controls">
          <button className="canvas-button" aria-haspopup="dialog" aria-expanded={newPlan !== undefined} onClick={() => setNewPlan(current => current ? undefined : { title: '', brief: '' })}>New plan</button>
          {running.length > 0 && onStopAll && <button className="canvas-button danger" onClick={onStopAll}>Stop all heads</button>}
          <button className="canvas-button" aria-pressed={still} onClick={() => setStill(value => !value)}>{still ? 'Resume motion' : 'Pause motion'}</button>
          <div className="canvas-zoom" role="group" aria-label="Zoom">
            <button aria-label="Zoom out" onClick={() => { setManual(true); setZoom(value => Math.max(.4, +(value - .1).toFixed(2))); }}>−</button>
            <button aria-label={manual ? 'Fit all heads' : 'Fitting all heads'} title="Fit all heads" onClick={() => { setManual(false); setPan({ x: 0, y: 0 }); }}>{manual ? `${Math.round(zoom * 100)}%` : 'Fit'}</button>
            <button aria-label="Zoom in" onClick={() => { setManual(true); setZoom(value => Math.min(1.5, +(value + .1).toFixed(2))); }}>+</button>
          </div>
        </div>
      </div>
      {newPlan && <div className="canvas-newplan" role="dialog" aria-label="New plan">
        <label>Title<input value={newPlan.title} onChange={event => setNewPlan({ ...newPlan, title: event.target.value })} maxLength={200} autoFocus /></label>
        <label>Brief<textarea value={newPlan.brief} onChange={event => setNewPlan({ ...newPlan, brief: event.target.value })} maxLength={8000} rows={3} placeholder="What should this plan accomplish? Claude or Codex will read the repository and split it into jobs." /></label>
        <div className="canvas-newplan-actions">
          <button className="primary" disabled={!newPlan.title.trim() || !newPlan.brief.trim()} onClick={() => { onPlan({ type: 'planCreate', title: newPlan.title.trim(), brief: newPlan.brief.trim() }); setNewPlan(undefined); }}>Plan with {defaultProvider === 'codex' ? 'Codex' : 'Claude'}</button>
          <button disabled={!newPlan.title.trim()} onClick={() => { onPlan({ type: 'planCreateEmpty', title: newPlan.title.trim() }); setNewPlan(undefined); }}>Start empty</button>
          <button className="text-button" onClick={() => setNewPlan(undefined)}>Cancel</button>
        </div>
      </div>}
      <div className="canvas-viewport" ref={viewport}
        onPointerDown={event => { if ((event.target as HTMLElement).closest('.canvas-node, .canvas-lead, .canvas-plan-lead, button')) return; drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; setManual(true); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }}
        onPointerMove={event => { const start = drag.current; if (start) setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }); }}
        onPointerUp={() => { drag.current = undefined; }}
        onWheel={event => { if (!event.ctrlKey) return; event.preventDefault(); setManual(true); setZoom(value => Math.min(1.5, Math.max(.4, +(value - Math.sign(event.deltaY) * .1).toFixed(2)))); }}>
        {empty ? <div className="canvas-empty"><div className="canvas-empty-mark" aria-hidden="true"><i /><i /><i /></div><p>Lanes you open, plans you draft and heads your chats start will appear here.</p><span>Start a task in a chat that splits into independent pieces. Each head grows out of the chat that started it.</span></div>
          : <div className="canvas-plane" style={{ width: model.width, height: model.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <svg className="canvas-edges" width={model.width} height={model.height}>
              {model.edges.map(edge => {
                if (edge.kind === 'conflict') {
                  const from = leadAt.get(edge.from), to = leadAt.get(edge.to);
                  if (!from || !to) return null;
                  const start = edgeStart(from.x, from.y), end = edgeStart(to.x, to.y);
                  return <g key={edge.id} className="canvas-edge conflict" aria-hidden="true">
                    <path className="base" style={{ d: `path("${conflictCurve(start.x, start.y, end.x, end.y)}")` } as React.CSSProperties} />
                  </g>;
                }
                const leadLike = edge.kind === 'lead' || edge.kind === 'plan-lead';
                const to = edge.kind === 'plan-dependency' || edge.kind === 'plan-lead' ? planJobAt.get(edge.to) : headAt.get(edge.to);
                if (!to) return null;
                const from = edge.kind === 'lead' ? leadAt.get(edge.from) : edge.kind === 'plan-lead' ? planAt.get(edge.from) : edge.kind === 'plan-dependency' ? planJobAt.get(edge.from) : headAt.get(edge.from);
                if (!from) return null;
                const start = edgeStart(from.x + (leadLike ? layout.leadWidth : layout.headWidth), from.y);
                const end = edgeStart(to.x, to.y);
                const d = curve(start.x, start.y, end.x, end.y);
                const removable = edge.kind === 'plan-dependency';
                return <g key={edge.id} className={`canvas-edge ${edge.kind}${edge.active ? ' active' : ''}${edge.waiting ? ' waiting' : ''}${edge.cycle ? ' cycle' : ''}`} aria-hidden={!removable}
                  {...(removable ? {
                    tabIndex: 0, role: 'button',
                    'aria-label': 'Dependency between two draft jobs. Press Delete to remove.',
                    onKeyDown: (event: React.KeyboardEvent) => { if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Enter') { event.preventDefault(); removePlanEdge(edge.kind, edge.from, edge.to); } },
                    onContextMenu: (event: React.MouseEvent) => { event.preventDefault(); removePlanEdge(edge.kind, edge.from, edge.to); },
                  } : {})}>
                  <path className="hit" style={{ d: `path("${d}")` } as React.CSSProperties} />
                  <path className="base" style={{ d: `path("${d}")` } as React.CSSProperties} />
                  {edge.active && <path className="flow" style={{ d: `path("${d}")` } as React.CSSProperties} />}
                </g>;
              })}
            </svg>
            {model.leads.map(lead => lead.kind === 'lane'
              ? <div key={lead.key} className={`canvas-lead kind-lane provider-${lead.provider || 'unknown'}${lead.status?.startsWith('Conflicts') ? ' conflict' : ''}`}
                  style={{ transform: `translate(${lead.x}px, ${lead.y}px)` }} title={lead.label}
                  role="button" tabIndex={0} aria-label={`Lane ${lead.label}. ${lead.status || ''}. Opens the Lanes view.`}
                  onClick={() => onOpenLane?.(lead.laneId!)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenLane?.(lead.laneId!); } }}>
                  <span className="canvas-lead-logo">{lead.provider ? <ProviderLogo provider={lead.provider} /> : <span aria-hidden="true">◆</span>}</span>
                  <span className="canvas-lead-copy"><em>Lane</em><b>{lead.label}</b><span>{lead.status}</span></span>
                </div>
              : <div key={lead.key} className={`canvas-lead provider-${lead.provider || 'unknown'}`} style={{ transform: `translate(${lead.x}px, ${lead.y}px)` }} title={lead.label}>
                  <span className="canvas-lead-logo">{lead.provider ? <ProviderLogo provider={lead.provider} /> : <span aria-hidden="true">◆</span>}</span>
                  <span className="canvas-lead-copy"><em>Lead</em><b>{lead.label}</b><span>{lead.heads.length} {lead.heads.length === 1 ? 'head' : 'heads'}</span></span>
                </div>)}
            {lingering.map(ghost => <div key={`lead-ghost-${ghost.lead.key}`} className={`canvas-lead leaving provider-${ghost.lead.provider || 'unknown'}`} aria-hidden="true" style={{ transform: `translate(${ghost.lead.x}px, ${ghost.lead.y}px)` }}>
              <span className="canvas-lead-logo">{ghost.lead.provider ? <ProviderLogo provider={ghost.lead.provider} /> : <span>◆</span>}</span>
              <span className="canvas-lead-copy"><em>Lead</em><b>{ghost.lead.label}</b><span>Done</span></span>
            </div>)}
            {model.heads.map(item => <HeadNode key={item.id} item={item} now={now} fresh={fresh.includes(item.id)} from={leadAt.get(item.lead)} selected={selected === item.id}
              onSelect={() => setSelected(item.id)} onOpen={() => onAction('helperReview', item.id)} onMenu={(x, y) => openMenu(item.id, x, y)} onKey={event => onNodeKey(event, item.id)} />)}
            {ghosts.map(ghost => <div key={`ghost-${ghost.head.id}`} className={`canvas-node leaving provider-${ghost.head.head.provider}`} aria-hidden="true" style={{ transform: `translate(${ghost.head.x}px, ${ghost.head.y}px)`, '--to-x': `${ghost.to.x - ghost.head.x}px`, '--to-y': `${ghost.to.y - ghost.head.y}px` } as React.CSSProperties}>
              <div className="canvas-node-card"><strong>{ghost.head.head.title}</strong></div>
            </div>)}
            {model.plans.map(node => <PlanLeadNode key={node.plan.id} node={node} defaultProvider={defaultProvider} onPlan={onPlan} />)}
            {model.plans.flatMap(node => node.jobs.map(item => <PlanJobNode key={item.id} item={item}
              onOpen={() => openJobPopover(item.planId, item.job, item.x, item.y)}
              onMenu={(x, y) => openJobMenu(item.planId, item.job, x, y)}
              onHandleDown={startDependencyDrag(item.planId, item.job.key)} onHandleUp={endDependencyDrag} />))}
          </div>}
      </div>
        {model.tray.length > 0 && <div className="canvas-tray" aria-label="Finished heads">
          <span className="canvas-tray-label">Finished</span>
          {model.tray.slice(0, 8).map(head => <button key={head.id} className={`canvas-chip state-${head.state}`} title={`${head.title} · ${headStatus[head.state] || head.state}${head.reason ? `\n${head.reason}` : ''}`} onClick={() => onAction('helperReview', head.id)} onContextMenu={event => { event.preventDefault(); openMenu(head.id, event.clientX, event.clientY); }}>
            <i aria-hidden="true" />{head.title}</button>)}
        </div>}
    </div>
    <aside className="canvas-list" aria-label="Heads list">
      <div className="canvas-list-head"><strong>Heads</strong>
        <div className="canvas-filter" role="tablist" aria-label="Show">{(['running', 'today'] as const).map(value => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? 'on' : ''} onClick={() => setFilter(value)}>{value === 'running' ? `Running ${running.length}` : 'All today'}</button>)}</div>
      </div>
      <ul>
        {listed.map(head => <li key={head.id}>
          <button className={`canvas-row${selected === head.id ? ' on' : ''}`} aria-current={selected === head.id ? 'true' : undefined}
            onClick={() => headAt.has(head.id) ? reveal(head.id) : setSelected(head.id)} onDoubleClick={() => onAction('helperReview', head.id)}
            onContextMenu={event => { event.preventDefault(); openMenu(head.id, event.clientX, event.clientY); }}
            onKeyDown={event => { if (event.key === 'Enter') onAction('helperReview', head.id); }}>
            <span className={`canvas-dot state-${head.state}`} aria-hidden="true" />
            <span className="canvas-row-copy"><b>{head.title}</b><span>{headStatus[head.state] || head.state}{head.merged ? ' · merged' : ''} · {head.lead?.label || (head.lead?.provider === 'codex' ? 'Codex chat' : head.lead?.provider === 'claude' ? 'Claude Code chat' : 'This window')}</span></span>
            <span className="canvas-row-time">{elapsedLabel(head, now)}</span>
          </button>
        </li>)}
        {!listed.length && <li className="canvas-list-empty">{filter === 'running' ? 'No heads working.' : 'No heads today.'}</li>}
      </ul>
    </aside>
    {menu && menuHead && <div className="canvas-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
      <button role="menuitem" autoFocus disabled={!menuHead.branch} onClick={() => { setMenu(undefined); onAction('helperReview', menuHead.id); }}>Open diff</button>
      <button role="menuitem" onClick={() => { setMenu(undefined); onAction('helperLog', menuHead.id); }}>Open log</button>
      {menuHead.state === 'blocked' && <button role="menuitem" onClick={() => { setMenu(undefined); onAction('helperAnswer', menuHead.id); }}>Answer question…</button>}
      {!!menuHead.checks.length && <button role="menuitem" onClick={() => { setMenu(undefined); onAction('helperEvidence', menuHead.id); }}>View evidence</button>}
      {isActive(menuHead) && <button role="menuitem" className="danger" onClick={() => { setMenu(undefined); onAction('helperCancel', menuHead.id); }}>Cancel head</button>}
    </div>}
    {jobMenu && <div className="canvas-menu" role="menu" style={{ left: jobMenu.x, top: jobMenu.y }}>
      <button role="menuitem" autoFocus onClick={() => { setJobMenu(undefined); openJobPopover(jobMenu.planId, jobMenu.job, jobMenu.x, jobMenu.y); }}>Edit</button>
      <button role="menuitem" onClick={() => { setJobMenu(undefined); onPlan({ type: 'planDependsOn', id: jobMenu.planId, key: jobMenu.job.key }); }}>Depends on…</button>
      <button role="menuitem" className="danger" onClick={() => { setJobMenu(undefined); onPlan({ type: 'planDeleteJob', id: jobMenu.planId, key: jobMenu.job.key }); }}>Delete</button>
    </div>}
    {jobPopover && <JobEditPopover key={`${jobPopover.planId}:${jobPopover.job.key}`} state={jobPopover} onCancel={() => setJobPopover(undefined)}
      onSave={(title, brief, provider) => { onPlan({ type: 'planSaveJob', id: jobPopover.planId, key: jobPopover.job.key, title, brief, provider }); setJobPopover(undefined); }} />}
  </section>;
}

function HeadNode({ item, now, fresh, from, selected, onSelect, onOpen, onMenu, onKey }: {
  item: CanvasHead; now: number; fresh: boolean; from?: CanvasLead; selected: boolean;
  onSelect: () => void; onOpen: () => void; onMenu: (x: number, y: number) => void; onKey: (event: React.KeyboardEvent) => void;
}) {
  const head = item.head, status = headStatus[head.state] || head.state, active = isActive(head);
  const detail = head.state === 'blocked' ? `Asks: ${head.question || 'a question'}`
    : active ? head.progress || (head.state === 'queued' ? (head.dependsOn.length ? 'Waiting for what it depends on' : 'Waiting for a free slot') : 'Working…')
    : head.state === 'done' ? `${head.changedFiles} ${head.changedFiles === 1 ? 'file' : 'files'} changed`
    : head.reason || status;
  const style = { transform: `translate(${item.x}px, ${item.y}px)`, ...(fresh && from ? { '--from-x': `${from.x - item.x}px`, '--from-y': `${from.y - item.y}px` } : {}) } as React.CSSProperties;
  return <div id={`head-${item.id}`} className={`canvas-node provider-${head.provider} state-${head.state}${fresh ? ' entering' : ''}${selected ? ' selected' : ''}`} style={style}
    role="button" tabIndex={0} aria-label={`${head.title}, ${head.provider === 'codex' ? 'Codex' : 'Claude'} head, ${status}. ${detail}. Enter opens the diff; Shift+F10 for more.`}
    onClick={() => { onSelect(); onOpen(); }} onKeyDown={onKey} onContextMenu={event => { event.preventDefault(); onMenu(event.clientX, event.clientY); }}>
    <div className="canvas-node-card">
      <div className="canvas-node-top">
        <span className="canvas-node-logo"><ProviderLogo provider={head.provider} /></span>
        <span className="canvas-node-kind">{head.provider === 'codex' ? 'Codex head' : 'Claude head'}</span>
        <span className={`canvas-state state-${head.state}`}><i aria-hidden="true" />{status}</span>
      </div>
      <strong className="canvas-node-title" title={head.title}>{head.title}</strong>
      <p key={detail} className="canvas-node-detail" title={detail}>{detail}</p>
      {!!head.checks.length && <div className="canvas-node-gates" aria-label="Gate results">
        {head.checks.map(check => { const chip = gateChip(check); return <span key={chip.id} className={`gate-chip tone-${chip.tone}`} title={chip.title}>{chip.label}</span>; })}
      </div>}
      <div className="canvas-node-foot">
        <code title={head.branch || head.writeScope?.join(', ')}>{head.branch ? head.branch.replace(/^agent\//, '') : (head.writeScope || []).join(' ') || 'not started'}</code>
        <span>{elapsedLabel(head, now)}</span>
        <button className="canvas-node-more" aria-label={`More actions for ${head.title}`} onClick={event => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(rect.left, rect.bottom + 4); }}>⋯</button>
      </div>
    </div>
  </div>;
}

/**
 * Planner (docs/Lanes_And_Planner_Plan.md, section 4): a plan still being
 * drafted (planning, draft or failed). A running or done plan's heads render
 * through the ordinary lead/head path above instead (see agentsCanvas.ts).
 */
function PlanLeadNode({ node, defaultProvider, onPlan }: { node: CanvasPlanNode; defaultProvider?: Provider; onPlan: (message: ClientMessage) => void }) {
  const plan = node.plan, providerName = defaultProvider === 'codex' ? 'Codex' : 'Claude';
  return <div className={`canvas-plan-lead state-${plan.state}`} style={{ transform: `translate(${node.x}px, ${node.y}px)` }}>
    <div className="canvas-plan-lead-head"><b title={plan.title}>Plan · {plan.title}</b></div>
    {plan.state === 'planning' && <>
      <p className="canvas-plan-status">Planning with {providerName}…</p>
      <div className="canvas-plan-actions"><button onClick={() => onPlan({ type: 'planCancel', id: plan.id })}>Cancel</button></div>
    </>}
    {plan.state === 'failed' && <>
      <p className="canvas-plan-status error" role="alert">{plan.error || 'Planning failed.'}</p>
      <div className="canvas-plan-actions">
        {plan.brief && <button onClick={() => onPlan({ type: 'planRetry', id: plan.id })}>Retry</button>}
        <button onClick={() => onPlan({ type: 'planStartEmpty', id: plan.id })}>Start empty</button>
        <button className="danger" aria-label={`Delete plan "${plan.title}"`} onClick={() => onPlan({ type: 'planDelete', id: plan.id })}>Delete plan</button>
      </div>
    </>}
    {plan.state === 'draft' && <>
      {node.cycleMessage && <p className="canvas-plan-status error" role="alert">{node.cycleMessage}</p>}
      <p className="canvas-plan-status">{plan.jobs.length} {plan.jobs.length === 1 ? 'job' : 'jobs'}</p>
      <div className="canvas-plan-actions">
        <button aria-label={`Add a job to "${plan.title}"`} disabled={plan.jobs.length >= 12} onClick={() => onPlan({ type: 'planAddJob', id: plan.id })}>+ Job</button>
        <button className="primary" disabled={!!node.cycleMessage || !plan.jobs.length} title={node.cycleMessage || undefined} onClick={() => onPlan({ type: 'planRun', id: plan.id })}>Run plan</button>
        <button className="danger" aria-label={`Delete plan "${plan.title}"`} onClick={() => onPlan({ type: 'planDelete', id: plan.id })}>Delete plan</button>
      </div>
    </>}
  </div>;
}

/** A draft job: dashed, since nothing has run yet. Click (or Enter) edits it; the handle drags a dependency onto another job. */
function PlanJobNode({ item, onOpen, onMenu, onHandleDown, onHandleUp }: {
  item: CanvasPlanJob; onOpen: () => void; onMenu: (x: number, y: number) => void;
  onHandleDown: (event: React.PointerEvent) => void; onHandleUp: (event: React.PointerEvent) => void;
}) {
  const job = item.job, providerLabel = job.provider === 'codex' ? 'Codex' : job.provider === 'claude' ? 'Claude' : 'Auto';
  return <div className="canvas-node canvas-plan-job" data-plan-job={item.id} style={{ transform: `translate(${item.x}px, ${item.y}px)` }}
    role="button" tabIndex={0} aria-label={`${job.title}, draft job, ${providerLabel}. Enter to edit; Shift+F10 for more.`}
    onClick={onOpen}
    onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); onOpen(); }
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) { event.preventDefault(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(rect.left + 24, rect.top + 24); }
    }}
    onContextMenu={event => { event.preventDefault(); onMenu(event.clientX, event.clientY); }}>
    <div className="canvas-node-card">
      <div className="canvas-node-top"><span className="canvas-node-kind">Draft job</span><span className="canvas-state"><i aria-hidden="true" />{providerLabel}</span></div>
      <strong className="canvas-node-title" title={job.title}>{job.title}</strong>
      <p className="canvas-node-detail" title={job.brief}>{job.brief}</p>
      <button className="canvas-plan-handle" aria-label={`Drag onto another job to make it depend on "${job.title}"`}
        onClick={event => event.stopPropagation()} onPointerDown={onHandleDown} onPointerUp={onHandleUp}>⋮</button>
    </div>
  </div>;
}

/** The job-edit popover: title, brief, and provider (Auto/Claude/Codex). */
function JobEditPopover({ state, onSave, onCancel }: { state: JobPopoverState; onSave: (title: string, brief: string, provider?: Provider) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(state.job.title);
  const [brief, setBrief] = useState(state.job.brief);
  const [provider, setProvider] = useState<'' | Provider>(state.job.provider || '');
  return <div className="canvas-menu canvas-job-popover" role="dialog" aria-label={`Edit "${state.job.title}"`} style={{ left: state.x, top: state.y }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
    <label>Title<input value={title} onChange={event => setTitle(event.target.value)} maxLength={80} autoFocus /></label>
    <label>Brief<textarea value={brief} onChange={event => setBrief(event.target.value)} maxLength={4000} rows={3} /></label>
    <label>Provider<select value={provider} onChange={event => setProvider(event.target.value as '' | Provider)}>
      <option value="">Auto</option><option value="claude">Claude</option><option value="codex">Codex</option>
    </select></label>
    <div className="canvas-newplan-actions">
      <button className="primary" disabled={!title.trim() || !brief.trim()} onClick={() => onSave(title.trim(), brief.trim(), provider || undefined)}>Save</button>
      <button className="text-button" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}
