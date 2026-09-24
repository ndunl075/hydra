import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { HelperJobView } from '../src/core/model';
import { buildCanvas, elapsedLabel, headStatus, isActive, layout, type CanvasHead, type CanvasLead } from '../src/core/agentsCanvas';
import { ProviderLogo } from './ProviderLogo';
import './agents-canvas.css';

/**
 * The Agents view (docs/Agents_View_Plan.md): a live canvas of the heads your
 * Claude Code and Codex chats start. Blank until a chat starts heads; each head
 * grows out of its chat, shows what it's doing, and leaves when it's merged.
 * The canvas never starts work itself.
 */
export type HeadAction = 'helperReview' | 'helperLog' | 'helperCancel' | 'helperAnswer';
const leaveMs = 650;
const edgeStart = (x: number, y: number) => ({ x, y: y + 34 });
const curve = (x1: number, y1: number, x2: number, y2: number) => { const mid = (x1 + x2) / 2; return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`; };

interface Ghost { head: CanvasHead; to: { x: number; y: number }; until: number }
interface LeadGhost { lead: CanvasLead; until: number }
/** A chat stays briefly after its last head, so the heads visibly fold back into it. */
const leadGraceMs = 1200;

export function AgentsCanvas({ heads, onAction, onStopAll }: { heads: readonly HelperJobView[]; onAction: (action: HeadAction, jobId: string) => void; onStopAll?: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const [still, setStill] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<string>();
  const [menu, setMenu] = useState<{ id: string; x: number; y: number }>();
  const [filter, setFilter] = useState<'running' | 'today'>('running');
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const [leadGhosts, setLeadGhosts] = useState<LeadGhost[]>([]);
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
  const model = useMemo(() => buildCanvas(heads, now), [heads, now]);
  useEffect(() => {
    if (manual || !box.width || !box.height || !model.heads.length) return;
    const fit = Math.min(1, (box.width - 24) / model.width, (box.height - 24) / model.height);
    setZoom(Math.max(.4, +fit.toFixed(2)));
    setPan({ x: 0, y: 0 });
  }, [manual, box, model.width, model.height, model.heads.length]);
  const leadAt = new Map(model.leads.map(lead => [lead.key, lead]));
  const headAt = new Map(model.heads.map(item => [item.id, item]));

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

  const reveal = (id: string) => {
    setSelected(id);
    const item = headAt.get(id);
    const box = viewport.current;
    if (!item || !box) return;
    setManual(true);
    setPan({ x: Math.min(0, box.clientWidth / 2 - (item.x + layout.headWidth / 2) * zoom), y: Math.min(0, box.clientHeight / 2 - (item.y + 40) * zoom) });
  };
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
  const empty = !model.heads.length && !ghosts.length && !lingering.length;

  return <section className={`agents-canvas${still ? ' still' : ''}`} aria-label="Agents">
    <div className="canvas-stage">
      <div className="canvas-toolbar">
        <div className="canvas-title"><strong>Agents</strong><span>{running.length ? `${running.length} ${running.length === 1 ? 'head' : 'heads'} working` : model.heads.length ? 'Nothing working' : 'Idle'}</span></div>
        <div className="canvas-controls">
          {running.length > 0 && onStopAll && <button className="canvas-button danger" onClick={onStopAll}>Stop all heads</button>}
          <button className="canvas-button" aria-pressed={still} onClick={() => setStill(value => !value)}>{still ? 'Resume motion' : 'Pause motion'}</button>
          <div className="canvas-zoom" role="group" aria-label="Zoom">
            <button aria-label="Zoom out" onClick={() => { setManual(true); setZoom(value => Math.max(.4, +(value - .1).toFixed(2))); }}>−</button>
            <button aria-label={manual ? 'Fit all heads' : 'Fitting all heads'} title="Fit all heads" onClick={() => { setManual(false); setPan({ x: 0, y: 0 }); }}>{manual ? `${Math.round(zoom * 100)}%` : 'Fit'}</button>
            <button aria-label="Zoom in" onClick={() => { setManual(true); setZoom(value => Math.min(1.5, +(value + .1).toFixed(2))); }}>+</button>
          </div>
        </div>
      </div>
      <div className="canvas-viewport" ref={viewport}
        onPointerDown={event => { if ((event.target as HTMLElement).closest('.canvas-node, .canvas-lead, button')) return; drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }; setManual(true); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); }}
        onPointerMove={event => { const start = drag.current; if (start) setPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y }); }}
        onPointerUp={() => { drag.current = undefined; }}
        onWheel={event => { if (!event.ctrlKey) return; event.preventDefault(); setManual(true); setZoom(value => Math.min(1.5, Math.max(.4, +(value - Math.sign(event.deltaY) * .1).toFixed(2)))); }}>
        {empty ? <div className="canvas-empty"><div className="canvas-empty-mark" aria-hidden="true"><i /><i /><i /></div><p>Heads your Claude Code and Codex chats start will appear here.</p><span>Start a task in a chat that splits into independent pieces. Each head grows out of the chat that started it.</span></div>
          : <div className="canvas-plane" style={{ width: model.width, height: model.height, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <svg className="canvas-edges" width={model.width} height={model.height} aria-hidden="true">
              {model.edges.map(edge => {
                const to = headAt.get(edge.to); if (!to) return null;
                const from = edge.kind === 'lead' ? leadAt.get(edge.from) : headAt.get(edge.from);
                if (!from) return null;
                const start = edge.kind === 'lead' ? edgeStart(from.x + layout.leadWidth, from.y) : edgeStart(from.x + layout.headWidth, from.y);
                const end = edgeStart(to.x, to.y);
                const d = curve(start.x, start.y, end.x, end.y);
                return <g key={edge.id} className={`canvas-edge ${edge.kind}${edge.active ? ' active' : ''}${edge.waiting ? ' waiting' : ''}`}>
                  <path className="base" style={{ d: `path("${d}")` } as React.CSSProperties} />
                  {edge.active && <path className="flow" style={{ d: `path("${d}")` } as React.CSSProperties} />}
                </g>;
              })}
            </svg>
            {model.leads.map(lead => <div key={lead.key} className={`canvas-lead provider-${lead.provider || 'unknown'}`} style={{ transform: `translate(${lead.x}px, ${lead.y}px)` }} title={lead.label}>
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
      {isActive(menuHead) && <button role="menuitem" className="danger" onClick={() => { setMenu(undefined); onAction('helperCancel', menuHead.id); }}>Cancel head</button>}
    </div>}
  </section>;
}

function HeadNode({ item, now, fresh, from, selected, onSelect, onOpen, onMenu, onKey }: {
  item: CanvasHead; now: number; fresh: boolean; from?: CanvasLead; selected: boolean;
  onSelect: () => void; onOpen: () => void; onMenu: (x: number, y: number) => void; onKey: (event: React.KeyboardEvent) => void;
}) {
  const head = item.head, status = headStatus[head.state] || head.state, active = isActive(head);
  const passed = head.checks.filter(check => check.passed).length;
  const detail = head.state === 'blocked' ? `Asks: ${head.question || 'a question'}`
    : active ? head.progress || (head.state === 'queued' ? (head.dependsOn.length ? 'Waiting for what it depends on' : 'Waiting for a free slot') : 'Working…')
    : head.state === 'done' ? `${head.checks.length ? `${passed}/${head.checks.length} checks passed · ` : ''}${head.changedFiles} ${head.changedFiles === 1 ? 'file' : 'files'} changed`
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
      <div className="canvas-node-foot">
        <code title={head.branch || head.writeScope?.join(', ')}>{head.branch ? head.branch.replace(/^agent\//, '') : (head.writeScope || []).join(' ') || 'not started'}</code>
        <span>{elapsedLabel(head, now)}</span>
        <button className="canvas-node-more" aria-label={`More actions for ${head.title}`} onClick={event => { event.stopPropagation(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); onMenu(rect.left, rect.bottom + 4); }}>⋯</button>
      </div>
    </div>
  </div>;
}
