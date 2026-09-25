import React from 'react';
import type { ClientMessage, HelperJobView, LaneLimitOfferView, LaneView, Provider } from '../src/core/model';
import type { Plan } from '../src/core/plans';
import type { JobCheckResult } from '../src/core/jobs';
import type { PlanJobView } from '../src/core/planRunner';
import { AgentsCanvas, type HeadAction } from './AgentsCanvas';
import { LanesView, type LaneSwitchCountdown } from './LanesView';

export type AgentsViewName = 'canvas' | 'lanes';

/**
 * The Agents tab's Canvas | Lanes switch (docs/Lanes_And_Planner_Plan.md,
 * section 2): a segmented control under the topbar, with each view getting the
 * full space. Both views stay mounted (only one is shown) so a lane's terminal
 * keeps running and its scrollback stays put while you're looking at the canvas.
 * No `acquireVsCodeApi` here, unlike index.tsx, so this renders under SSR too.
 */
export function AgentsBody({
  view, onViewChange, heads, dismissedTray, plans, lanes, planJobs, terminals, defaultProvider, laneError, laneFocus, onLaneFocused,
  laneLimits, laneSwitchCountdowns, laneGates, onAction, onPlan, onStopAll, openNewPlanAt, onOpenLane, onSend, focusHead,
}: {
  view: AgentsViewName;
  onViewChange: (view: AgentsViewName) => void;
  heads: readonly HelperJobView[];
  /** Finished heads the tray's Clear button has hidden (docs/Lanes_And_Planner_Plan.md, "Canvas tidy-up"). */
  dismissedTray?: readonly string[];
  plans?: readonly Plan[];
  lanes?: readonly LaneView[];
  /** Each plan's job statuses (docs/Plan_Lanes_Plan.md, section 4-5), by plan id. */
  planJobs?: Readonly<Record<string, readonly PlanJobView[]>>;
  terminals: boolean;
  defaultProvider?: Provider;
  laneError?: string;
  laneFocus?: string;
  onLaneFocused: () => void;
  /** Usage-limit banners and switch countdowns (docs/Gates_Plan.md, section 2), by lane id. */
  laneLimits?: Readonly<Record<string, LaneLimitOfferView>>;
  laneSwitchCountdowns?: Readonly<Record<string, LaneSwitchCountdown>>;
  /** A gates run in progress on a lane, by lane id (docs/Gates_Plan.md, "Lanes"). */
  laneGates?: Readonly<Record<string, { done: JobCheckResult[]; running?: string }>>;
  onAction: (action: HeadAction, jobId: string) => void;
  onPlan?: (message: ClientMessage) => void;
  onStopAll?: () => void;
  openNewPlanAt?: number;
  onOpenLane: (laneId: string) => void;
  onSend: (message: ClientMessage) => void;
  focusHead?: { id: string; at: number };
}) {
  return <div className="agents-body">
    <div className="agents-view-switch" role="tablist" aria-label="Agents view">
      <button role="tab" aria-selected={view === 'canvas'} className={view === 'canvas' ? 'on' : ''} onClick={() => onViewChange('canvas')}>Canvas</button>
      <button role="tab" aria-selected={view === 'lanes'} className={view === 'lanes' ? 'on' : ''} onClick={() => onViewChange('lanes')}>Lanes <span className="agents-view-count">{(lanes || []).length}</span></button>
    </div>
    <div className="agents-view-pane" hidden={view !== 'canvas'}>
      <AgentsCanvas heads={heads} dismissedTray={dismissedTray} plans={plans} lanes={lanes} planJobs={planJobs} defaultProvider={defaultProvider} onAction={onAction} onPlan={onPlan} onStopAll={onStopAll} openNewPlanAt={openNewPlanAt} onOpenLane={onOpenLane} focusHead={focusHead} />
    </div>
    <div className="agents-view-pane" hidden={view !== 'lanes'}>
      <LanesView lanes={lanes || []} terminals={terminals} defaultProvider={defaultProvider} laneError={laneError} focus={laneFocus} onSend={onSend} onFocused={onLaneFocused}
        laneLimits={laneLimits} laneSwitchCountdowns={laneSwitchCountdowns} laneGates={laneGates} />
    </div>
  </div>;
}
