import type { Provider } from './model';

/**
 * A provider hit its usage limit (docs/Hydra_Agent_Plan.md). Detection
 * (Claude's StopFailure hook, Codex's rate-limit snapshot, a head's CLI output)
 * produces these; the handoff builder and the "Continue in…" offer consume them.
 */
export interface LimitEvent {
  provider: Provider;
  /** A chat in the official extension, or a Hydra head. */
  source: 'chat' | 'head';
  /** ISO time the limit was seen. */
  at: string;
  /** When the limit resets, if the provider said. ISO time. */
  resetsAt?: string;
  /** Provider's own words, shown as-is (never interpreted). */
  message?: string;
  /** Chats: the provider's session id, when known. */
  sessionId?: string;
  /** Chats: the working directory the chat was in. */
  cwd?: string;
  /** Claude chats: the session transcript (JSONL) the hook reported. */
  transcriptPath?: string;
  /** Heads: the job that stopped. */
  jobId?: string;
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
