import React, { useState } from 'react';
import type { ClientMessage, Provider, Task } from '../src/core/model';
import type { BudgetObservation, BudgetSettings, SoftBudget } from '../src/core/budgets';

function BudgetEditor({ task, scope, saved, busy, send }: { task: Task; scope: 'task' | 'project'; saved: SoftBudget[]; busy: boolean; send(message: ClientMessage): void }) {
  const [provider, setProvider] = useState<Provider>(task.provider);
  const current = saved.find(item => item.provider === provider);
  // The keyed form resets on provider/scope or saved configuration changes, never on usage updates.
  return <><label>Budget provider<select disabled={busy} value={provider} onChange={event => setProvider(event.target.value as Provider)}><option value="claude">Claude</option><option value="codex">Codex</option></select></label><BudgetForm key={`${provider}-${JSON.stringify(current)}`} provider={provider} current={current} disabled={busy} onSave={budget => send({ type: 'saveBudgets', id: task.id, scope, budgets: [...saved.filter(item => item.provider !== provider), ...(budget ? [budget] : [])] })} /></>;
}
function BudgetForm({ provider, current, disabled, onSave }: { provider: Provider; current?: SoftBudget; disabled: boolean; onSave(budget?: SoftBudget): void }) {
  const [tokens, setTokens] = useState(current?.inputOutputTokens?.toString() || '');
  const [money, setMoney] = useState(current?.estimatedUsd?.toString() || '');
  const [action, setAction] = useState<'warn' | 'hold'>(current?.action || 'warn');
  const valid = (!tokens || Number.isSafeInteger(Number(tokens)) && Number(tokens) > 0) && (!money || Number.isFinite(Number(money)) && Number(money) > 0 && Number(money) <= 1e9);
  return <form onSubmit={event => { event.preventDefault(); if (valid) onSave(tokens || money ? { provider, action, ...(tokens ? { inputOutputTokens: Number(tokens) } : {}), ...(money ? { estimatedUsd: Number(money) } : {}) } : undefined); }}><fieldset disabled={disabled}>
    <legend>{provider === 'claude' ? 'Claude' : 'Codex'} soft limits</legend>
    <label>Reported input + output tokens<input type="number" min="1" max={Number.MAX_SAFE_INTEGER} step="1" placeholder="Off" value={tokens} onChange={event => setTokens(event.target.value)} /></label>
    {provider === 'claude' && <label>Reported API estimate (USD)<input type="number" min="0.000001" max="1000000000" step="any" placeholder="Off" value={money} onChange={event => setMoney(event.target.value)} /></label>}
    <label>When a reported limit is reached<select value={action} onChange={event => setAction(event.target.value as 'warn' | 'hold')}><option value="warn">Warn and allow new work</option><option value="hold">Hold new launches and turns</option></select></label>
    <div className="task-actions"><button className="secondary" type="submit" disabled={!valid}>Save {provider} budget</button>{current && <button className="secondary" type="button" onClick={() => onSave()}>Remove {provider} budget</button>}</div>
  </fieldset></form>;
}
export function BudgetControls({ task, settings, observations = [], busy, send }: { task: Task; settings?: BudgetSettings; observations?: BudgetObservation[]; busy: boolean; send(message: ClientMessage): void }) {
  const [scope, setScope] = useState<'task' | 'project'>('task');
  const saved = (scope === 'task' ? settings?.tasks[task.id] : settings?.projects[task.repository]) || [];
  const reached = observations.filter(item => item.provider === task.provider && item.reached);
  return <section className="budget-controls" aria-label="Soft budgets">
    {reached.length > 0 && <div className="inline-notice" role="status">{reached.some(item => item.action === 'hold') ? 'A reported budget is reached. New work will be held.' : 'Budget warning: a reported limit is reached. New work remains allowed.'}</div>}
    <details className="context-details"><summary>Soft budgets <span>{observations.length ? `${observations.length} configured limits` : 'Off'}</span></summary>
      <p className="form-note">Uses recorded history in this Hydra workspace. Active turns continue; these limits do not cap spending or reserve allowance for queued work. Terminal and external activity cannot be measured or controlled after launch.</p>
      <div className="usage-scopes" aria-label="Budget scope"><button className="secondary" aria-pressed={scope === 'task'} onClick={() => setScope('task')}>This task budget</button><button className="secondary" aria-pressed={scope === 'project'} onClick={() => setScope('project')}>This project budget</button></div>
      {scope === 'project' && <p className="form-note">Includes retained discarded tasks in <code>{task.repository}</code>. Other windows and unrecorded provider activity are outside this total.</p>}
      <BudgetEditor key={scope} task={task} scope={scope} saved={saved} busy={busy || !settings} send={send} />
      {observations.map(item => <p key={`${item.scope}-${item.provider}-${item.metric}`} className="form-note">{item.scope} · {item.provider} · {item.metric === 'estimatedUsd' ? 'API estimate USD' : 'input + output tokens'}: {item.observed === undefined ? 'Unavailable' : item.observed.toLocaleString()} / {item.limit.toLocaleString()} · {item.reached ? item.action === 'hold' ? 'hold reached' : 'warning reached' : 'not reported as reached'}{item.partial ? ' · incomplete coverage' : ''}</p>)}
      <p className="form-note">Unknown measurements never become zero and cannot trigger a hold. Codex input includes cached tokens; Claude cache is separate and excluded from this token limit. API estimates are not subscription bills, quotas or remaining credit. Limits apply to the selected provider; either a task or project hold can stop its new work. Changing limits does not automatically resume held work.</p>
    </details>
  </section>;
}
