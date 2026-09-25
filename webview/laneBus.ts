/**
 * A tiny event bus for lane terminal bytes (docs/Lanes_And_Planner_Plan.md,
 * "Lanes view", Wiring). index.tsx's single `message` listener forwards
 * `laneData`/`laneReplay` here; LanesView writes straight into the matching
 * xterm instance, so a keystroke's worth of output never causes a React
 * re-render of the whole tree.
 */
export interface LaneEvent { type: 'laneData' | 'laneReplay'; id: string; data: string }
type Listener = (event: LaneEvent) => void;
const listeners = new Set<Listener>();
export function emitLaneEvent(event: LaneEvent): void { for (const listener of listeners) listener(event); }
export function onLaneEvent(listener: Listener): () => void { listeners.add(listener); return () => listeners.delete(listener); }
