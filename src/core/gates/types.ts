import type { Provider } from '../model';
import type { JobCheckResult } from '../jobs';
import type { ProbeOutput } from '../process';
import type { CheckCommandResult } from '../checkCommand';
import type { Gate } from './config';
import type { ScreenshotBrowser } from './browser';

/**
 * What a caller tells the gates about the work being checked. Heads
 * (HelperService.accept) and lanes (Merge, Run gates) both fill it in.
 */
export interface GateContext {
  /** Whose work it is. A review by "other" uses the other agent. */
  author: Provider;
  /** Where this run's logs, the reviewer's reply and the screenshots go. Created if missing. */
  logDirectory: string;
  /** What the work was for, for the reviewer: the head's title, brief and write scope, or a lane's goal. */
  title?: string;
  brief?: string;
  writeScope?: string[];
  /**
   * The provider CLI, already version-checked (HelperService's `executable`).
   * Throws a plain reason when it isn't installed or can't be used. Defaults to a PATH lookup.
   */
  executable?: (provider: Provider) => Promise<string>;
  /** A provider that is at its usage limit now; a review then uses the other one. */
  limited?: (provider: Provider) => boolean;
  /** Every process a gate starts (commands, the app, the reviewer, the browser), so none of them can act as a lead. */
  spawned?: (pid: number) => void;
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** As each gate starts and finishes, for progress on a tile ("Gates: unit ✓ · review …"). */
  onProgress?: (progress: { done: JobCheckResult[]; running?: string }) => void;
  /** Test seams: a fake reviewer, browser, clock or port. */
  runtime?: Partial<GateRuntime>;
}

export interface ReviewerSpec {
  provider: Provider;
  executable: string;
  args: string[];
  /** The prompt, written to the CLI's stdin. */
  input: string;
  /** The worktree under review; the reviewer only reads it. */
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  spawned?: (pid: number) => void;
}

/** Everything a gate does to the outside world, so tests can replace any of it. */
export interface GateRuntime {
  runCommand(command: { executable: string; args: string[] }, cwd: string, logFile: string, timeoutMs: number, signal?: AbortSignal, spawned?: (pid: number) => void): Promise<CheckCommandResult>;
  runReviewer(spec: ReviewerSpec): Promise<ProbeOutput>;
  browser: ScreenshotBrowser;
  freePort(): Promise<number>;
  fetch: typeof fetch;
  /** Kills a process and everything it started. */
  terminate(pid: number): Promise<void>;
  now(): number;
  /** How often the screenshots gate asks whether the app is ready. */
  pollMs: number;
}

/** One gate's view of the run: the context, where it runs, and what ran before it. */
export interface GateRun extends GateContext {
  /** The head's (or lane's) worktree. Gates never run anywhere else. */
  worktree: string;
  /** Where the work started: the diff under review is baseCommit..HEAD. */
  baseCommit: string;
  runtime: GateRuntime;
  earlier: JobCheckResult[];
}

export type GateRunner<G extends Gate> = (gate: G, run: GateRun) => Promise<JobCheckResult>;

/** A gate that couldn't run. It is reported with the reason and never fails the work. */
export function notRun(gate: Pick<Gate, 'id' | 'type' | 'required'>, reason: string, durationMs = 0, extra: Partial<JobCheckResult> = {}): JobCheckResult {
  return { id: gate.id, kind: gate.type, required: gate.required, state: 'notRun', passed: false, exitCode: null, durationMs, outputTail: '', summary: reason, ...extra };
}
export const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max)}…` : value;
export const tail = (value: string, max: number): string => value.length > max ? `…${value.slice(-max)}` : value;
export const providerName = (provider: Provider): string => provider === 'claude' ? 'Claude Code' : 'Codex';
