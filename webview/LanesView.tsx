import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ClientMessage, LaneAction, LaneLimitOfferView, LaneOfferButtonId, LanePlanJobView, LaneView, Provider } from '../src/core/model';
import type { JobCheckResult } from '../src/core/jobs';
import { otherProvider } from '../src/core/limitEvents';
import { gateChip } from '../src/core/agentsCanvas';
import { ProviderLogo } from './ProviderLogo';
import { onLaneEvent } from './laneBus';
import '@xterm/xterm/css/xterm.css';
import './lanes.css';

/**
 * The Lanes view (docs/Lanes_And_Planner_Plan.md, "Lanes view"): a fixed grid of
 * tiles, each a real terminal (xterm.js) over a lane's `claude` or `codex`
 * process, plus the chips and actions that finish a lane. xterm is only ever
 * created in the browser (inside an effect), so this renders safely under SSR.
 */
const providerLabel = (provider: Provider) => provider === 'codex' ? 'Codex' : 'Claude Code';
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const laneStateLabel: Record<LaneView['state'], string> = { running: 'Running', exited: 'Exited', merged: 'Merged', closed: 'Closed' };
// Duplicated from src/core/lanePty.ts's `terminalsUnavailable`: that module loads
// node-pty from the host, so it must never enter this browser bundle (see the
// note in src/core/agentsCanvas.ts on the same rule for plans.ts).
const terminalsUnavailableMessage = 'Terminals aren\'t available in this build.';

/** VS Code's terminal colour variables, falling back to the editor's. */
function laneTheme(): Record<string, string> {
  const style = getComputedStyle(document.body);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const ansi = (name: string, fallback: string) => read(`--vscode-terminal-ansi${name}`, fallback);
  return {
    background: read('--vscode-terminal-background', read('--vscode-editor-background', '#141414')),
    foreground: read('--vscode-terminal-foreground', read('--vscode-editor-foreground', '#f5f5f5')),
    cursor: read('--vscode-terminalCursor-foreground', read('--vscode-editor-foreground', '#f5f5f5')),
    selectionBackground: read('--vscode-terminal-selectionBackground', 'rgba(255,255,255,.25)'),
    black: ansi('Black', '#1e1e1e'), red: ansi('Red', '#cd3131'), green: ansi('Green', '#0dbc79'), yellow: ansi('Yellow', '#e5e510'),
    blue: ansi('Blue', '#2472c8'), magenta: ansi('Magenta', '#bc3fbc'), cyan: ansi('Cyan', '#11a8cd'), white: ansi('White', '#e5e5e5'),
    brightBlack: ansi('BrightBlack', '#666666'), brightRed: ansi('BrightRed', '#f14c4c'), brightGreen: ansi('BrightGreen', '#23d18b'),
    brightYellow: ansi('BrightYellow', '#f5f543'), brightBlue: ansi('BrightBlue', '#3b8eea'), brightMagenta: ansi('BrightMagenta', '#d670d6'),
    brightCyan: ansi('BrightCyan', '#29b8db'), brightWhite: ansi('BrightWhite', '#e5e5e5'),
  };
}

/** One tile's terminal: created only in the browser, replays and appends via the lane bus, and reports its size. */
function LaneTerminal({ id, onInput, onResize }: { id: string; onInput: (data: string) => void; onResize: (cols: number, rows: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const onInputRef = useRef(onInput); onInputRef.current = onInput;
  const onResizeRef = useRef(onResize); onResizeRef.current = onResize;

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let term: import('@xterm/xterm').Terminal | undefined;
    let observer: ResizeObserver | undefined;
    const cleanups: (() => void)[] = [];
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !container.current) return;
      const fit = new FitAddon();
      term = new Terminal({
        scrollback: 5000, allowProposedApi: true, theme: laneTheme(),
        fontFamily: getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-family') || undefined,
        fontSize: parseInt(getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-size'), 10) || 13,
      });
      term.loadAddon(fit);
      term.open(container.current);
      term.onData(data => onInputRef.current(data));
      const report = () => { try { fit.fit(); onResizeRef.current(term!.cols, term!.rows); } catch { /* not laid out yet */ } };
      report();
      observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(report);
      observer?.observe(container.current);
      cleanups.push(onLaneEvent(event => {
        if (event.id !== id || !term) return;
        if (event.type === 'laneReplay') term.reset();
        term.write(event.data);
      }));
      // The tile asks for focus (a lane opened from the canvas or the Hydra panel).
      const element = container.current, focus = () => term?.focus();
      element.addEventListener('lane-focus', focus);
      cleanups.push(() => element.removeEventListener('lane-focus', focus));
    })();
    return () => { disposed = true; observer?.disconnect(); for (const cleanup of cleanups) cleanup(); term?.dispose(); term = undefined; };
  }, [id]);

  return <div className="lane-terminal" ref={container} />;
}

/** `hydra.lanes.onLimit: "switch"`'s countdown, as the extension sent it. */
export interface LaneSwitchCountdown { to: Provider; deadline: number }
const laneOfferButtonLabel: Record<LaneOfferButtonId, (other: string) => string> = {
  continueOther: other => `Continue in ${other}`, viewHandoff: () => 'View handoff', wait: () => 'Wait',
};

/** The lane tile's usage-limit banner (docs/Gates_Plan.md, section 2). Never a notification: it lives on the tile it's about. */
function LaneLimitBanner({ offer, onAction }: { offer: LaneLimitOfferView; onAction: (action: LaneOfferButtonId) => void }) {
  const other = providerLabel(otherProvider(offer.provider));
  return <div className="lane-limit-banner" role="alert">
    <p>{offer.message}</p>
    <div className="lane-limit-actions">
      {offer.buttons.map(button => <button key={button} className={button === 'continueOther' ? 'primary' : ''} onClick={() => onAction(button)}>{laneOfferButtonLabel[button](other)}</button>)}
    </div>
  </div>;
}

/** The `hydra.lanes.onLimit: "switch"` countdown: seconds left, ticking locally from the deadline the extension sent. */
function LaneSwitchCountdownBanner({ countdown, onCancel }: { countdown: LaneSwitchCountdown; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  const secondsLeft = Math.max(0, Math.ceil((countdown.deadline - now) / 1000));
  return <div className="lane-limit-banner" role="alert">
    <p>Switching to {providerLabel(countdown.to)} in {secondsLeft}s…</p>
    <div className="lane-limit-actions"><button onClick={onCancel}>Cancel</button></div>
  </div>;
}

interface NewLaneForm { name: string; provider: Provider; goal: string }

/** The inline "New lane" card at the top of the grid. */
export function NewLaneCard({ initial, error, onStart, onCancel }: { initial: NewLaneForm; error?: string; onStart: (form: NewLaneForm) => void; onCancel: () => void }) {
  const [form, setForm] = useState(initial);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onCancel]);
  return <div className="lane-new" role="dialog" aria-label="New lane">
    <label>Name<input value={form.name} maxLength={40} autoFocus onChange={event => { const name = event.target.value; setForm(current => ({ ...current, name })); }} /></label>
    {/* Not a <label>: a label forwards any click inside it to its first button, so Codex could never be chosen. */}
    <div className="lane-new-field"><span id="lane-new-agent">Agent</span>
      <div className="lane-new-provider" role="radiogroup" aria-labelledby="lane-new-agent">
        {(['claude', 'codex'] as const).map(provider => <button key={provider} type="button" role="radio" aria-checked={form.provider === provider}
          className={form.provider === provider ? 'on' : ''} onClick={() => setForm(current => ({ ...current, provider }))}>{providerLabel(provider)}</button>)}
      </div>
    </div>
    <label>Goal, optional<textarea value={form.goal} maxLength={2000} rows={2} placeholder="What should it work on? Leave empty to start without a prompt."
      onChange={event => { const goal = event.target.value; setForm(current => ({ ...current, goal })); }} /></label>
    {error && <p className="lane-new-error" role="alert">{error}</p>}
    <div className="lane-new-actions">
      <button className="primary" disabled={!form.name.trim()} onClick={() => onStart(form)}>Start lane</button>
      <button className="text-button" onClick={onCancel}>Cancel</button>
    </div>
  </div>;
}

/** A conflict/behind/merges/merged chip: colour plus a text label, never colour alone. */
function Chip({ tone, title, children }: { tone: 'warning' | 'info' | 'good' | 'neutral'; title?: string; children: React.ReactNode }) {
  return <span className={`lane-chip tone-${tone}`} title={title}>{children}</span>;
}

/**
 * A plan lane's chip (docs/Plan_Lanes_Plan.md, section 5): "Plan · Checkout ›
 * Build API", and once the job is done, a second green "Job done · a1b2c3d"
 * chip. Shown on both the tile header and the exited-lane row.
 */
function PlanChip({ planJob }: { planJob: LanePlanJobView }) {
  return <>
    <Chip tone="neutral" title="Jobs after it start when you mark it done or merge it">Plan · {planJob.planTitle} › {planJob.jobTitle}</Chip>
    {planJob.state === 'done' && <Chip tone="good">Job done{planJob.commit ? ` · ${planJob.commit.slice(0, 7)}` : ''}</Chip>}
  </>;
}

/** Gate chips (docs/Gates_Plan.md, "Lanes"): "Gates: ✓ unit · … review" while running, or the last run's chips once it's done. */
function GateChips({ results, running }: { results: readonly JobCheckResult[]; running?: string }) {
  if (!results.length && !running) return null;
  return <div className="lane-gate-chips" aria-label="Gate results">
    <span className="lane-gate-chips-label">Gates:</span>
    {results.map(result => { const chip = gateChip(result); return <span key={chip.id} className={`gate-chip tone-${chip.tone}`} title={chip.title}>{chip.label}</span>; })}
    {running && <span className="gate-chip tone-neutral" title={`Running ${running}…`}>… {running}</span>}
  </div>;
}

function LaneTile({ lane, laneName, focused, limitOffer, switchCountdown, gates, onSend, onFocused }: {
  lane: LaneView; laneName: (id: string) => string | undefined; focused: boolean;
  limitOffer?: LaneLimitOfferView; switchCountdown?: LaneSwitchCountdown;
  /** A gates run in progress on this lane; undefined once it's finished (the lane's own lastGates then has the chips). */
  gates?: { done: JobCheckResult[]; running?: string };
  onSend: (message: ClientMessage) => void; onFocused: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const act = (action: LaneAction) => onSend({ type: 'laneAction', id: lane.id, action });
  const sync = lane.sync;
  const conflict = sync?.conflicts[0];
  const merges = !!sync && !sync.dirty && sync.targetConflicts.length === 0 && sync.changedFiles.length > 0 && lane.state !== 'merged';
  const lastSwitch = lane.switches?.at(-1);
  const other = otherProvider(lane.provider);

  useEffect(() => {
    if (!focused || !ref.current) return;
    ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    ref.current.querySelector('.lane-terminal')?.dispatchEvent(new CustomEvent('lane-focus'));
    onFocused();
  }, [focused]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: Event) => { if (!(event.target as HTMLElement).closest?.('.lane-menu, .lane-menu-button')) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', close); window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', escape); };
  }, [menuOpen]);

  return <section className="lane-tile" aria-label={`Lane ${lane.name}`} ref={ref as React.RefObject<HTMLElement>}>
    <header className="lane-tile-head">
      <span className={`lane-dot state-${lane.state}`} aria-hidden="true" /><span className="sr-only">{laneStateLabel[lane.state]}</span>
      <b className="lane-name" title={lane.name}>{lane.name}</b>
      <span className="lane-provider"><ProviderLogo provider={lane.provider} /></span>
      <code className="lane-branch" title={lane.branch}>{lane.branch}</code>
      {lastSwitch && <span className="lane-switched" title={`${new Date(lastSwitch.at).toLocaleString()}`}>
        {lastSwitch.reason === 'limit' ? `Continued from ${providerLabel(lastSwitch.from)} (limit)` : `Switched from ${providerLabel(lastSwitch.from)}`}
      </span>}
      <div className="lane-chips">
        {lane.planJob && <PlanChip planJob={lane.planJob} />}
        {conflict && <Chip tone="warning" title={sync!.conflicts.flatMap(item => item.files).join(', ')}>Conflicts with {laneName(conflict.laneId) || 'another lane'}{conflict.files[0] ? ` · ${conflict.files[0]}` : ''}</Chip>}
        {!!sync?.targetConflicts.length && lane.state !== 'merged' && <Chip tone="warning" title={sync.targetConflicts.join(', ')}>Conflicts with {lane.target} · {sync.targetConflicts[0]}</Chip>}
        {!!sync?.behind && lane.state !== 'merged' && <Chip tone="info">{sync.behind} behind {lane.target}</Chip>}
        {merges && <Chip tone="good">Merges cleanly</Chip>}
        {lane.state === 'merged' && <Chip tone="neutral">Merged</Chip>}
      </div>
    </header>
    <GateChips results={gates?.done ?? lane.lastGates?.results ?? []} running={gates?.running} />
    {switchCountdown
      ? <LaneSwitchCountdownBanner countdown={switchCountdown} onCancel={() => onSend({ type: 'laneCancelSwitch', id: lane.id })} />
      : limitOffer && <LaneLimitBanner offer={limitOffer} onAction={action => onSend({ type: 'laneLimitAction', id: lane.id, action })} />}
    <div className="lane-tile-body">
      <LaneTerminal id={lane.id} onInput={data => onSend({ type: 'laneInput', id: lane.id, data })} onResize={(cols, rows) => onSend({ type: 'laneResize', id: lane.id, cols, rows })} />
      {lane.state === 'exited' && <div className="lane-exited">
        <p>Session ended{lane.exitCode !== undefined ? ` (code ${lane.exitCode})` : ''}.</p>
        <div className="lane-exited-actions"><button onClick={() => act('resume')}>Resume</button><button onClick={() => act('restart')}>Start fresh</button></div>
      </div>}
    </div>
    <footer className="lane-tile-foot">
      <button className="text-button" disabled={!sync?.changedFiles.length} onClick={() => act('diff')}>{plural(sync?.changedFiles.length ?? 0, 'file')} changed</button>
      <div className="lane-tile-actions">
        <button onClick={() => act('diff')}>Diff</button>
        {/* Mark job done (docs/Plan_Lanes_Plan.md, section 5): only while no dependent has started from its result. */}
        {lane.planJob && lane.planJob.dependentsStarted === 0 && lane.state !== 'merged' && <button onClick={() => act('markJobDone')}>{lane.planJob.state === 'done' ? 'Mark job done again' : 'Mark job done'}</button>}
        <button className="primary" disabled={lane.state === 'merged' || !sync?.changedFiles.length} title={!sync?.changedFiles.length ? 'Nothing to merge yet' : undefined} onClick={() => act('merge')}>Merge</button>
        <div className="lane-menu-wrap">
          <button className="lane-menu-button" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={`More actions for lane ${lane.name}`} onClick={() => setMenuOpen(value => !value)}>⋯</button>
          {menuOpen && <div className="lane-menu" role="menu">
            {sync?.dirty && <button role="menuitem" onClick={() => { setMenuOpen(false); act('commit'); }}>Commit…</button>}
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('update'); }}>Update from {lane.target}</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('runGates'); }}>Run gates</button>
            {!!lane.lastGates?.results.length && <button role="menuitem" onClick={() => { setMenuOpen(false); act('evidence'); }}>View evidence</button>}
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('pr'); }}>Open PR</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('openWindow'); }}>Open in new window</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('resume'); }}>Resume</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('restart'); }}>Restart</button>
            <button role="menuitem" onClick={() => { setMenuOpen(false); act('switchProvider'); }}>Switch to {providerLabel(other)}</button>
            {lane.planJob && <button role="menuitem" onClick={() => { setMenuOpen(false); act('showPlan'); }}>Show plan</button>}
            {lane.planJob && <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); act('cancelJob'); }}>Cancel job…</button>}
            <button role="menuitem" className="danger" onClick={() => { setMenuOpen(false); act('close'); }}>Close lane…</button>
          </div>}
        </div>
      </div>
    </footer>
  </section>;
}

/** An exited lane's compact row (docs/Lanes_And_Planner_Plan.md, "Lanes view"): name, provider, branch, chips and its actions, instead of a full terminal tile. "Show terminal" expands it into the ordinary tile. */
function ExitedLaneRow({ lane, laneName, expanded, onToggle, onSend }: {
  lane: LaneView; laneName: (id: string) => string | undefined; expanded: boolean; onToggle: () => void; onSend: (message: ClientMessage) => void;
}) {
  const act = (action: LaneAction) => onSend({ type: 'laneAction', id: lane.id, action });
  const sync = lane.sync;
  const conflict = sync?.conflicts[0];
  return <div className="lane-row" aria-label={`Lane ${lane.name}, exited`}>
    <span className="lane-dot state-exited" aria-hidden="true" />
    <b className="lane-name" title={lane.name}>{lane.name}</b>
    <span className="lane-provider"><ProviderLogo provider={lane.provider} /></span>
    <code className="lane-branch" title={lane.branch}>{lane.branch}</code>
    <div className="lane-chips">
      {lane.planJob && <PlanChip planJob={lane.planJob} />}
      {conflict && <Chip tone="warning" title={sync!.conflicts.flatMap(item => item.files).join(', ')}>Conflicts with {laneName(conflict.laneId) || 'another lane'}</Chip>}
      {lane.exitCode !== undefined && <Chip tone="neutral">Exited (code {lane.exitCode})</Chip>}
    </div>
    <div className="lane-row-actions">
      <button onClick={() => act('resume')}>Resume</button>
      <button onClick={() => act('restart')}>Start fresh</button>
      <button disabled={!sync?.changedFiles.length} onClick={() => act('merge')}>Merge</button>
      <button className="danger" onClick={() => act('close')}>Close lane…</button>
      <button className="lane-row-toggle" aria-expanded={expanded} onClick={onToggle}>{expanded ? 'Hide terminal' : 'Show terminal'}</button>
    </div>
  </div>;
}

export function LanesView({ lanes, terminals, defaultProvider, laneError, focus, laneLimits, laneSwitchCountdowns, laneGates, onSend, onFocused }: {
  lanes: readonly LaneView[]; terminals: boolean; defaultProvider?: Provider; laneError?: string; focus?: string;
  laneLimits?: Readonly<Record<string, LaneLimitOfferView>>; laneSwitchCountdowns?: Readonly<Record<string, LaneSwitchCountdown>>;
  laneGates?: Readonly<Record<string, { done: JobCheckResult[]; running?: string }>>;
  onSend: (message: ClientMessage) => void; onFocused: () => void;
}) {
  const [showForm, setShowForm] = useState(false);
  // The form closes once the lane it started shows up; an error keeps it open.
  const starting = useRef<number | undefined>(undefined);
  useEffect(() => { if (starting.current !== undefined && lanes.length > starting.current) { starting.current = undefined; setShowForm(false); } }, [lanes.length]);
  const mounted = useRef(false);
  useEffect(() => { if (!mounted.current) { mounted.current = true; onSend({ type: 'laneAttach' }); } }, []);
  const laneName = (id: string) => lanes.find(lane => lane.id === id)?.name;
  const nextName = useMemo(() => {
    const taken = new Set(lanes.map(lane => lane.name.toLowerCase()));
    let index = lanes.length + 1;
    while (taken.has(`lane ${index}`)) index++;
    return `Lane ${index}`;
  }, [lanes]);
  // Running lanes first, exited lanes after, as compact rows unless expanded to "Show terminal".
  const running = lanes.filter(lane => lane.state !== 'exited');
  const exited = lanes.filter(lane => lane.state === 'exited');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) => setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return <section className="lanes-view" aria-label="Lanes">
    <div className="lanes-toolbar">
      <div className="lanes-title"><strong>Lanes</strong><span>{lanes.length}</span></div>
      <div className="lanes-controls">
        <button className="canvas-button" disabled={!terminals} onClick={() => setShowForm(true)}>New lane</button>
        <button className="canvas-button" disabled={!lanes.length} onClick={() => onSend({ type: 'laneAction', id: lanes[0]!.id, action: 'refresh' })}>Refresh</button>
      </div>
    </div>
    {!terminals
      ? <div className="lanes-empty" role="status">{terminalsUnavailableMessage}</div>
      : <div className="lanes-grid">
        {showForm && <NewLaneCard initial={{ name: nextName, provider: defaultProvider === 'codex' ? 'codex' : 'claude', goal: '' }} error={laneError}
          onCancel={() => setShowForm(false)}
          onStart={form => { starting.current = lanes.length; onSend({ type: 'laneNew', name: form.name.trim(), provider: form.provider, ...(form.goal.trim() ? { goal: form.goal.trim() } : {}) }); }} />}
        {running.map(lane => <LaneTile key={lane.id} lane={lane} laneName={laneName} focused={focus === lane.id} limitOffer={laneLimits?.[lane.id]} switchCountdown={laneSwitchCountdowns?.[lane.id]} gates={laneGates?.[lane.id]} onSend={onSend} onFocused={onFocused} />)}
        {exited.map(lane => expanded.has(lane.id)
          ? <LaneTile key={lane.id} lane={lane} laneName={laneName} focused={focus === lane.id} limitOffer={laneLimits?.[lane.id]} switchCountdown={laneSwitchCountdowns?.[lane.id]} gates={laneGates?.[lane.id]} onSend={onSend} onFocused={onFocused} />
          : <ExitedLaneRow key={lane.id} lane={lane} laneName={laneName} expanded={false} onToggle={() => toggle(lane.id)} onSend={onSend} />)}
        {!lanes.length && !showForm && <p className="lanes-empty-hint">No lanes yet. Start one to run a real Claude Code or Codex terminal in its own worktree. <button className="text-button" onClick={() => onSend({ type: 'learn' })}>Learn how</button></p>}
      </div>}
  </section>;
}
