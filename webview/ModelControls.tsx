import React, { useEffect, useState } from 'react';
import type { ClientMessage, SessionView, Task, Turn } from '../src/core/model';
import type { ModelCatalog, ModelSelection } from '../src/core/modelSelection';
import { canEditBrief } from '../src/core/taskContext';

export function TurnModelLabel({ turn }: { turn: Turn }) {
  const settings = turn.modelSettings;
  if (!settings) return null;
  return <div className="session-note">{settings.requested && <p>Requested: {settings.requested.model} · {settings.requested.effort}</p>}<p>Provider reported: {settings.effective ? `${settings.effective.model} · ${settings.effective.effort ?? 'effort unavailable'}` : 'Not acknowledged'}</p>{settings.rerouted && <p role="status">Provider reroute: {settings.rerouted.from} → {settings.rerouted.to} ({settings.rerouted.reason}). The previous effort acknowledgement no longer applies.</p>}</div>;
}
export function ModelControls({ task, session, catalog, busy, send }: { task: Task; session?: SessionView; catalog?: ModelCatalog; busy: boolean; send: (message: ClientMessage) => void }) {
  const [selection, setSelection] = useState<ModelSelection | null>(task.modelSelection || null);
  const saved = JSON.stringify(task.modelSelection || null);
  useEffect(() => setSelection(task.modelSelection || null), [task.id, saved]);
  const editable = canEditBrief(task, session), models = catalog?.models || [], selected = models.find(model => model.model === selection?.model);
  const supported = !selection || !!selected?.efforts.includes(selection.effort);
  const astra = models.find(model => model.model === 'gpt-6-astra' && model.efforts.includes('high'));
  const dirty = JSON.stringify(selection) !== saved;
  return <details className="context-details"><summary>Model and effort <span>{task.modelSelection ? `${task.modelSelection.model} · ${task.modelSelection.effort}` : 'Official provider defaults'}</span></summary>
    <>
      <p className="form-note">These settings apply to managed {task.provider === 'claude' ? 'Claude' : 'Codex'} tasks. Discovery reads model metadata without submitting a prompt. The provider verifies access when you run the task.</p>
      <button className="secondary" disabled={busy || catalog?.status === 'checking'} onClick={() => send({ type: 'checkModels', id: task.id })}>{catalog?.status === 'checking' ? 'Loading models…' : 'Load available models'}</button>
      {catalog?.error && <p role="status" className="session-error">{catalog.error}</p>}
      <form className="model-controls" onSubmit={event => { event.preventDefault(); send({ type: 'saveModelSelection', id: task.id, selection }); }}>
        <label>Model<select disabled={busy || !editable || catalog?.status !== 'ready'} value={selection?.model || ''} onChange={event => { const model = models.find(model => model.model === event.target.value); setSelection(model ? { model: model.model, effort: task.provider === 'claude' ? '' : model.efforts.includes(model.defaultEffort) ? model.defaultEffort : model.efforts[0] || '' } : null); }}><option value="">Official provider defaults</option>{selection && !selected && <option value={selection.model}>{selection.model} · refresh to verify</option>}{models.map(model => <option value={model.model} key={model.model} disabled={!model.efforts.length || task.provider === 'claude' && !model.canonicalModel}>{model.displayName} · {model.model}{!model.efforts.length ? ' · effort unavailable' : ''}</option>)}</select></label>
        {selection && <label>Reasoning effort<select disabled={busy || !editable || !selected} value={selection.effort} onChange={event => setSelection({ ...selection, effort: event.target.value })}>{!selection.effort && <option value="">Choose effort</option>}{selection.effort && !selected?.efforts.includes(selection.effort) && <option value={selection.effort}>{selection.effort} · unavailable</option>}{selected?.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></label>}
        <div className="task-actions"><button type="submit" className="secondary" disabled={busy || !editable || !supported || !dirty}>Save model settings</button>{task.provider === 'codex' && <button type="button" className="secondary" disabled={busy || !editable || !astra} onClick={() => setSelection({ model: astra!.model, effort: 'high' })}>Astra High</button>}{selection && editable && <button type="button" className="text-button" disabled={busy} onClick={() => setSelection(null)}>Use provider defaults</button>}</div>
      </form>
      {task.provider === 'codex' && !astra && <p className="form-note">Astra High is available only when this runtime advertises exactly gpt-6-astra with high effort. No substitute is selected.</p>}
      <p className="form-note">{editable ? 'Save settings before starting. Explicit selections lock when launched and are rechecked on resume.' : 'Settings are locked for this task. Follow-ups reapply its saved selection.'} No selection leaves provider configuration unchanged. {task.provider === 'codex' ? 'A later provider reroute is reported; an explicitly configured run is stopped.' : 'Effective settings describe the next root request; they do not guarantee every internal call.'}</p>
    </>
  </details>;
}
