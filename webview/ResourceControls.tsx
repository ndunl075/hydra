import { useState } from 'react';
import type { ClientMessage, Task } from '../src/core/model';
import type { ResourceView } from '../src/core/resourceModel';

export function ResourceControls({ task, saved, busy, send }: { task: Task; saved?: ResourceView; busy: boolean; send(message: ClientMessage): void }) {
  const [port, setPort] = useState(() => saved?.config.port?.toString() || '');
  const [database, setDatabase] = useState(() => saved?.config.database || '');
  const [service, setService] = useState(() => saved?.config.service || '');
  const [commands, setCommands] = useState(() => JSON.stringify(saved?.config.commands || [], null, 2));
  const [timeout, setTimeout] = useState(() => (saved?.config.timeoutMs || 120000) / 1000);
  const [error, setError] = useState('');
  const running = saved?.status === 'running', uncertain = !!saved?.uncertain;
  const queued = !!task.schedule?.request || ['queued', 'starting', 'waiting-for-dependencies'].includes(task.schedule?.state || '');
  const blocked = busy || queued || task.state === 'running' || task.state === 'external' || running || uncertain;
  const editable = !blocked && !task.contextLockedAt && !task.sessionId && task.state !== 'discarded';
  const action = (type: 'runSetup' | 'stopSetup' | 'showSetupLog' | 'releaseResources' | 'reacquireResources' | 'reconcileSetup') => send({ type, id: task.id });
  return <details className="context-details"><summary>Resources and setup <span>{saved ? `${saved.reserved ? 'Reserved' : 'Released'} · ${saved.status}` : 'Optional'}</span></summary>
    <form onSubmit={event => event.preventDefault()}>
    <p className="quiet">Assign distinct resources for this task. Database and service names reserve identifiers in Hydra; your commands must create and configure the backing resources. Ports are checked when assigned.</p>
    <label>Task port<input type="number" min={1024} max={65535} value={port} disabled={!editable} onChange={event => setPort(event.target.value)} /></label>
    <label>Database identifier<input value={database} disabled={!editable} onChange={event => setDatabase(event.target.value)} /></label>
    <label>Service identifier<input value={service} disabled={!editable} onChange={event => setService(event.target.value)} /></label>
    <label>Setup commands (JSON executable and args)<textarea rows={5} value={commands} disabled={!editable} onChange={event => setCommands(event.target.value)} spellCheck={false} /></label>
    <label>Timeout per command (seconds)<input type="number" min={1} max={600} value={timeout} disabled={!editable} onChange={event => setTimeout(Number(event.target.value))} /></label>
    <p className="quiet">Commands run explicitly in the task checkout. Use foreground commands. Saved values are available as HYDRA_TASK_PORT, HYDRA_TASK_DATABASE and HYDRA_TASK_SERVICE; arguments support {'{{HYDRA_TASK_PORT}}'} placeholders.</p>
    {error && <p role="alert">{error}</p>}
    <div className="task-actions">
      <button disabled={!editable} onClick={() => { try { const parsed: unknown = JSON.parse(commands); if (!Array.isArray(parsed)) throw new Error('Enter an array of commands.'); setError(''); send({ type: 'saveResources', id: task.id, config: { ...(port ? { port: Number(port) } : {}), ...(database ? { database } : {}), ...(service ? { service } : {}), commands: parsed, timeoutMs: timeout * 1000 } }); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } }}>Save resources</button>
      <button disabled={blocked || task.state === 'discarded' || !saved?.reserved || !saved.config.commands.length} onClick={() => action('runSetup')}>Run saved setup</button>
      {running && <button onClick={() => action('stopSetup')}>Stop setup</button>}
      {uncertain && <button disabled={busy || running} onClick={() => action('reconcileSetup')}>I stopped setup</button>}
      {saved && !saved.reserved && <button disabled={blocked || task.state === 'discarded'} onClick={() => action('reacquireResources')}>Reacquire saved resources</button>}
      {saved?.reserved && <button disabled={blocked || !!task.contextLockedAt && task.state !== 'discarded'} onClick={() => action('releaseResources')}>Release reservations</button>}
      {saved?.log && <button onClick={() => action('showSetupLog')}>Setup diagnostics</button>}
    </div>
    {saved?.checks.map((check, index) => <p className="quiet" key={index}><code>{check.executable}</code> · {check.status}{check.exitCode !== undefined && ` · exit ${check.exitCode}`}{check.error && ` · ${check.error}`}</p>)}
    </form>
  </details>;
}
