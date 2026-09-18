import React, { useId, useState } from 'react';
import type { Snapshot, Task } from '../src/core/model';
import { ProviderLogo } from './ProviderLogo';
import './agent-map.css';

const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).at(-1) || value;
const providerName = (task: Task) => task.provider === 'claude' ? 'Claude Code' : 'Codex';

function taskStatus(task: Task, awaitingApproval: boolean) {
  if (task.interface === 'official-extension') return 'External · unobserved';
  if (task.state === 'external') return 'Terminal · unobserved';
  if (awaitingApproval) return 'Approval needed';
  if (task.schedule?.uncertain) return 'Reconcile writer';
  if (task.schedule && ['queued', 'starting', 'blocked'].includes(task.schedule.state)) return task.schedule.state === 'queued' ? 'Queued' : task.schedule.state === 'starting' ? 'Starting' : 'Blocked';
  return { running: 'Running', idle: 'Idle', interrupted: 'Interrupted', error: 'Error', discarded: 'Discarded' }[task.state];
}

function BranchIcon({ repository = false }: { repository?: boolean }) {
  return <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {repository ? <><path d="M7 4h16a2 2 0 0 1 2 2v22H9a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3M6 24h19M11 9h9M11 13h6" /><path d="M12 24v7l3-2 3 2v-7" /></> : <><circle cx="9" cy="6" r="3" /><circle cx="23" cy="7" r="3" /><circle cx="9" cy="26" r="3" /><path d="M9 9v14M23 10v3c0 5-14 2-14 8" /></>}
  </svg>;
}

function observedActivity(snapshot: Snapshot, task: Task) {
  // Older snapshots can still observe the selected task's session.
  const session = task.id === snapshot.selectedId ? snapshot.session : undefined;
  const activity = snapshot.taskActivity?.[task.id] ?? (session ? { active: !!session.active, awaitingApproval: !!session.approvals?.length } : undefined);
  const managedRunning = task.state === 'running' && task.interface === 'managed-cli';
  const awaitingApproval = managedRunning && !!activity?.awaitingApproval;
  return { awaitingApproval, moving: managedRunning && !!activity?.active && !awaitingApproval };
}

/** A view of recorded checkout relationships, never an editable dependency graph. */
export function AgentMap({ snapshot, selectedId, onSelect }: {
  snapshot: Snapshot; selectedId?: string; onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [paused, setPaused] = useState(false);
  const [zoom, setZoom] = useState(1);
  const contentId = useId();
  const legendId = useId();
  const repositories = [...new Set([...snapshot.repositories, ...snapshot.tasks.map(task => task.repository)])];
  const running = snapshot.tasks.filter(task => task.state === 'running').length;
  const groups = repositories.map(repository => ({ repository, tasks: snapshot.tasks.filter(task => task.repository === repository) }));
  const graphHeight = groups.reduce((height, group) => height + Math.max(group.tasks.length, 1) * 148 + 20, 0);
  let groupOffset = 0;

  return <section className={`agent-map${paused ? ' agent-map-paused' : ''}`} aria-label="Agent map">
    <div className="agent-map-toolbar">
      <button className="agent-map-toggle" aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" aria-hidden="true"><path d={expanded ? 'm4 6 4 4 4-4' : 'm6 4 4 4-4 4'} /></svg>
        <span>Agent orchestration</span>
        <span className="agent-map-count">All {snapshot.tasks.length} {snapshot.tasks.length === 1 ? 'task' : 'tasks'}{running > 0 && ` · ${running} running`}</span>
      </button>
      {expanded && <button className="agent-map-motion" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'Resume motion' : 'Pause motion'}</button>}
    </div>
    {expanded && <div id={contentId}>
      <div className="agent-map-viewport">
        <div className="agent-map-canvas" role="region" aria-label="Repository and agent connections" aria-describedby={legendId} tabIndex={0}>
          <div className="agent-map-scaled" style={{ width: 850 * zoom, height: graphHeight * zoom }}>
            <div className="agent-map-scene" style={{ width: 850, height: graphHeight, transform: `scale(${zoom})` }}>
              {groups.map(({ repository, tasks }) => {
                const top = groupOffset;
                const height = Math.max(tasks.length, 1) * 148 + 20;
                groupOffset += height;
                const rootY = Math.min(130, 60 + Math.max(tasks.length - 1, 0) * 74);
                return <div className="agent-map-repository" key={repository} style={{ top, height }}>
                  <svg className="agent-map-connections" width="850" height={height} fill="none" aria-hidden="true">
                    {tasks.map((task, index) => {
                      const y = 60 + index * 148;
                      const { moving } = observedActivity(snapshot, task);
                      const route = `M374 ${y} C440 ${y} 460 ${y + 16} 520 ${y + 16}`;
                      return <g key={task.id} className={`agent-map-provider-${task.provider}`}>
                        <path className="agent-map-context-link" d={`M142 ${rootY} C220 ${rootY} 230 ${y} 304 ${y}`} />
                        <path className="agent-map-context-arrow" d={`m298 ${y - 4} 6 4-6 4`} />
                        <path className="agent-map-connection" d={route} />
                        {moving && <path className="agent-map-flow" d={route} />}
                        <path className="agent-map-arrow" d={`m514 ${y + 12} 6 4-6 4`} />
                      </g>;
                    })}
                  </svg>
                  <div className="agent-map-root" style={{ top: rootY - 41 }} title={repository}>
                    <div className="agent-map-root-icon"><BranchIcon repository /><span className="agent-map-port agent-map-port-out" /></div>
                    <strong>{basename(repository)}</strong>
                    <span className="agent-map-caption">Repository · {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                  </div>
                  <ul className="agent-map-routes" aria-label={`${repository} tasks`}>
                    {tasks.map((task, index) => {
                      const y = 60 + index * 148;
                      const { moving, awaitingApproval } = observedActivity(snapshot, task);
                      const status = taskStatus(task, awaitingApproval);
                      return <li className={`agent-map-route agent-map-provider-${task.provider}${moving ? ' agent-map-route-running' : ''}`} key={task.id} style={{ top: y - 32 }}>
                        <div className="agent-map-checkout" title={`${task.branch}\n${task.worktree}`}>
                          <div className="agent-map-checkout-icon"><span className="agent-map-port agent-map-port-in" /><BranchIcon /><span className="agent-map-port agent-map-port-out" /></div>
                          <code>{task.branch}</code><span className="agent-map-caption">Worktree</span>
                        </div>
                        <button className={`agent-map-task${selectedId === task.id ? ' agent-map-task-selected' : ''}`}
                          aria-current={selectedId === task.id ? 'true' : undefined}
                          aria-label={`Open ${task.title}, ${providerName(task)}, ${status}, branch ${task.branch}`}
                          title={`${task.title}\n${providerName(task)} · ${status}`} onClick={() => onSelect(task.id)}>
                          <span className="agent-map-port agent-map-port-in" aria-hidden="true" />
                          <span className="agent-map-provider-logo"><ProviderLogo provider={task.provider} /></span>
                          <span className="agent-map-task-copy"><span className="agent-map-provider-name">{providerName(task)}</span><strong>{task.title}</strong></span>
                          <span className={`agent-map-task-status${awaitingApproval || task.state === 'error' || task.state === 'interrupted' ? ' agent-map-status-attention' : ''}`}><span className="agent-map-indicator" aria-hidden="true" />{status}</span>
                        </button>
                      </li>;
                    })}
                    {tasks.length === 0 && <li className="agent-map-empty">No task worktrees yet</li>}
                  </ul>
                </div>;
              })}
            </div>
          </div>
        </div>
        <div className="agent-map-zoom" role="group" aria-label="Map zoom">
          <button aria-label="Zoom out agent map" disabled={zoom <= .6} onClick={() => setZoom(value => Math.max(.6, +(value - .2).toFixed(1)))}>−</button>
          <button className="agent-map-zoom-reset" aria-label="Reset agent map zoom to 100 percent" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button aria-label="Zoom in agent map" disabled={zoom >= 1.4} onClick={() => setZoom(value => Math.min(1.4, +(value + .2).toFixed(1)))}>+</button>
        </div>
      </div>
      <p className="agent-map-legend" id={legendId}>
        <span><span className="agent-map-line-key" aria-hidden="true" />Repository → worktree → assigned agent</span>
        <span>Motion = observed managed task running. Lines show context, not messages or dependencies.</span>
      </p>
    </div>}
  </section>;
}
