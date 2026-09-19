import React from 'react';
import type { SetupRecipePreview, SetupPreviewResourceState } from '../src/core/setupRecipe';
import './task-setup-preview.css';

/**
 * Safe current-state facts supplied by the coordinator. They deliberately do
 * not include a ResourceView, command arguments, environment values, logs, or
 * release actions.
 */
const reservationText: Record<SetupPreviewResourceState['reservation'], string> = {
  reserved: 'Reserved for this task',
  conflict: 'Reservation conflict',
  unavailable: 'Reservation unavailable'
};

const backingText: Record<NonNullable<SetupPreviewResourceState['backingService']>, string> = {
  available: 'Backing service indicated by setup',
  missing: 'Backing service missing',
  unknown: 'Backing service not verified'
};

function stateFor(key: string, states: readonly SetupPreviewResourceState[]): SetupPreviewResourceState {
  return states.find(state => state.key === key) ?? { key, reservation: 'unavailable' };
}

/**
 * A passive presentation of the Feature 24 recipe. It sends no messages, so
 * opening or expanding it cannot provision a service, execute setup, or
 * release this or another task's reservation.
 */
export function TaskSetupPreview({ recipe, resources = [] }: { recipe?: SetupRecipePreview; resources?: readonly SetupPreviewResourceState[] }) {
  if (!recipe) return <section className="task-setup-preview" aria-label="Task setup preview"><header><span className="section-label">SETUP PREVIEW</span><strong>Validated recipe unavailable</strong></header><p>There is no reviewed recipe for this task. Viewing never runs setup or changes any resource reservation.</p></section>;

  return <section className="task-setup-preview" aria-label="Task setup preview">
    <header><span className="section-label">SETUP PREVIEW</span><strong>Validated recipe</strong><span>{Math.round(recipe.timeoutMs / 1000)}s per command</span></header>
    <dl className="setup-preview-identity"><div><dt>Recipe digest</dt><dd><code>{recipe.digest}</code></dd></div><div><dt>Task</dt><dd><code>{recipe.taskId}</code></dd></div></dl>
    <p className="setup-preview-note">Reservations are logical Hydra claims. They do not provision databases, services, containers, or other backing resources.</p>
    <ul className="setup-preview-resources" aria-label="Resource reservations">
      {recipe.reservations.map(reservation => {
        const state = stateFor(reservation.key, resources);
        const backing = reservation.kind === 'port' ? undefined : state.backingService ?? 'missing';
        return <li key={reservation.key} className={`setup-resource setup-reservation-${state.reservation}`}><div><strong>{reservation.kind}</strong><code>{reservation.name}</code><span>{reservation.environment}</span></div><p>{reservationText[state.reservation]}</p>{backing && <p className={`setup-backing setup-backing-${backing}`}>{backingText[backing]}</p>}</li>;
      })}
    </ul>
    {!recipe.reservations.length && <p className="quiet">This recipe has no resource reservations.</p>}
    <details className="setup-preview-details"><summary>Reviewed setup shape <span>{recipe.commands.length} command{recipe.commands.length === 1 ? '' : 's'} · {recipe.environment.length} environment name{recipe.environment.length === 1 ? '' : 's'}</span></summary><ul>{recipe.commands.map(command => <li key={command.order}><span>Step {command.order}</span><code>{command.executable}</code><span>{command.argumentCount} argument{command.argumentCount === 1 ? '' : 's'} hidden</span></li>)}</ul>{!recipe.commands.length && <p className="quiet">No setup commands are included.</p>}<p className="quiet">Environment values and command arguments are intentionally not displayed.</p></details>
    <p className="quiet">Read-only preview. It never executes setup, provisions a backing service, or releases another task’s resources.</p>
  </section>;
}
