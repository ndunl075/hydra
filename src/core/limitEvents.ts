import type { Provider } from './model';

/**
 * A provider hit its usage limit (docs/Hydra_Agent_Plan.md). Detection
 * (Claude's StopFailure hook, Codex's rate-limit snapshot, a head's CLI output)
 * produces these; the handoff builder and the "Continue in…" offer consume them.
 */
export interface LimitEvent {
  provider: Provider;
  /** A chat in the official extension, a Hydra head, or a Hydra lane (docs/Gates_Plan.md, section 2). */
  source: 'chat' | 'head' | 'lane';
  /** ISO time the limit was seen. */
  at: string;
  /** When the limit resets, if the provider said. ISO time. */
  resetsAt?: string;
  /** Provider's own words, shown as-is (never interpreted). */
  message?: string;
  /** Chats: the provider's session id, when known. */
  sessionId?: string;
  /** Chats and lanes: the working directory the session was in. */
  cwd?: string;
  /** Claude chats and lanes: the session transcript (JSONL) the hook reported. */
  transcriptPath?: string;
  /** Heads: the job that stopped. */
  jobId?: string;
  /** Lanes: which lane (its 12-hex id), tagged by the Claude hook from HYDRA_LANE_ID, or by the Codex account-limit fan-out. */
  laneId?: string;
}

/** A continuation brief, built without asking any model. */
export interface Handoff {
  /** Markdown shown to the user and given to the next agent. */
  markdown: string;
  /** Short title, e.g. the first line of the original ask. */
  title: string;
  /** Working directory the next agent should continue in. */
  cwd?: string;
}

export const otherProvider = (provider: Provider): Provider => provider === 'claude' ? 'codex' : 'claude';

/**
 * The Codex account-limit event has no cwd or lane (it comes from the account's
 * shared rate-limit snapshot, not any one session). Fan it out to one `source:
 * 'lane'` event per running Codex lane, so each lane's tile offers separately;
 * the original chat event is fired unchanged (docs/Gates_Plan.md, section 2).
 */
export function codexLaneFanout(event: LimitEvent, lanes: readonly { id: string; worktree: string }[]): LimitEvent[] {
  if (event.provider !== 'codex' || event.source !== 'chat') return [];
  return lanes.map(lane => ({ ...event, source: 'lane', laneId: lane.id, cwd: lane.worktree }));
}
