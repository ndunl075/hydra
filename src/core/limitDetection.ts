import path from 'node:path';
import type { LimitEvent } from './limitEvents';
import type { QuotaSnapshot } from './quota';

/**
 * Recognising a usage limit (docs/Hydra_Agent_Plan.md, "Detect the limit"). Pure
 * functions over what each provider reports; nothing here reads or writes files.
 */

const maxMessage = 2000;
/** Provider text shown as-is, but bounded and without control characters. */
export function cleanMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim();
  if (!text) return undefined;
  return text.length > maxMessage ? `${text.slice(0, maxMessage)}…` : text;
}
const isoTime = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};
/** Claude's older usage-limit text ends in `|<epoch seconds>`: "Claude AI usage limit reached|1712345678". */
export function claudeResetFromMessage(message: string | undefined): string | undefined {
  const match = message ? /\|(\d{10})\s*$/.exec(message) : null;
  return match ? new Date(Number(match[1]) * 1000).toISOString() : undefined;
}
const absolute = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value) && (path.isAbsolute(value) || path.win32.isAbsolute(value)) ? value : undefined;
const sessionId = (value: unknown): string | undefined => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;

// ---- Claude chats: the StopFailure hook ----

/**
 * The hook's stdin (Claude Code 2.1.270, recorded): { session_id, transcript_path,
 * cwd, prompt_id, hook_event_name: "StopFailure", error: "rate_limit",
 * last_assistant_message }. There is no reset time field.
 */
export function normaliseStopFailure(payload: unknown, now = new Date()): LimitEvent | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const data = payload as Record<string, unknown>;
  if (data.hook_event_name !== 'StopFailure' || data.error !== 'rate_limit') return undefined;
  const message = cleanMessage(data.last_assistant_message), resetsAt = claudeResetFromMessage(message);
  const id = sessionId(data.session_id), cwd = absolute(data.cwd), transcriptPath = absolute(data.transcript_path);
  return { provider: 'claude', source: 'chat', at: now.toISOString(), ...(resetsAt ? { resetsAt } : {}), ...(message ? { message } : {}), ...(id ? { sessionId: id } : {}), ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}) };
}

/** Whether `file` is inside `directory` (case-insensitive on Windows). */
export function isInside(file: string, directory: string): boolean {
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  const relative = pathApi.relative(pathApi.resolve(directory), pathApi.resolve(file));
  return !!relative && !relative.startsWith('..') && !pathApi.isAbsolute(relative);
}

export const maxEventFileBytes = 64 * 1024;
export const maxEventAgeMs = 10 * 60_000;
/**
 * An event file from the hook (untrusted: anything running as the user can write
 * there). Only a Claude chat event is accepted, every field is re-checked, and a
 * transcript outside Claude's projects folder is dropped.
 */
export function parseLimitEventFile(text: string, options: { now: number; claudeProjectsDir: string }): LimitEvent | undefined {
  if (text.length > maxEventFileBytes) return undefined;
  let data: Record<string, unknown>;
  try { const parsed = JSON.parse(text) as unknown; if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined; data = parsed as Record<string, unknown>; } catch { return undefined; }
  if (data.provider !== 'claude' || data.source !== 'chat') return undefined;
  const at = isoTime(data.at);
  if (!at) return undefined;
  const time = Date.parse(at);
  if (time < options.now - maxEventAgeMs || time > options.now + 60_000) return undefined;
  const resetsAt = isoTime(data.resetsAt), message = cleanMessage(data.message), id = sessionId(data.sessionId), cwd = absolute(data.cwd);
  const transcript = absolute(data.transcriptPath);
  const transcriptPath = transcript && transcript.endsWith('.jsonl') && isInside(transcript, options.claudeProjectsDir) ? transcript : undefined;
  return { provider: 'claude', source: 'chat', at, ...(resetsAt ? { resetsAt } : {}), ...(message ? { message } : {}), ...(id ? { sessionId: id } : {}), ...(cwd ? { cwd } : {}), ...(transcriptPath ? { transcriptPath } : {}) };
}

// ---- Heads: the CLIs' own output ----

export interface HeadLimit { message: string; resetsAt?: string }
const claudeLimitText = /usage limit|rate limit|hit your limit|limit reached|\b429\b/i;
const text = (value: unknown) => typeof value === 'string' ? value : '';
/**
 * One `claude -p --output-format stream-json` line (Claude Code 2.1.270, recorded
 * against a 429): `system/api_retry` lines with `error: "rate_limit"` while it
 * retries, then an `assistant` line with `error: "rate_limit"` and
 * `is_api_error_message`, then a `result` with `is_error` and `api_error_status: 429`.
 * Retries alone aren't a limit; the failed turn is.
 */
export function claudeHeadLimit(line: Record<string, unknown>): HeadLimit | undefined {
  let message: string | undefined;
  if (line.type === 'assistant' && line.error === 'rate_limit') {
    const content = (line.message as { content?: unknown } | undefined)?.content;
    message = Array.isArray(content) ? content.map(part => text((part as { text?: unknown })?.text)).join(' ') : '';
  } else if (line.type === 'result' && line.is_error === true && (line.api_error_status === 429 || claudeLimitText.test(text(line.result)))) {
    message = text(line.result);
  } else return undefined;
  const clean = cleanMessage(message) ?? 'Claude usage limit reached.', resetsAt = claudeResetFromMessage(clean);
  return { message: clean, ...(resetsAt ? { resetsAt } : {}) };
}
const codexLimitText = /usage limit|rate limit|too many requests|\b429\b/i;
/**
 * One `codex exec --json` line: a turn ends with `{ type: "error", message }` and/or
 * `{ type: "turn.failed", error: { message } }`. Codex 0.154 says "You've hit your
 * usage limit. … or try again at <time>."; exhausted 429 retries mention 429.
 */
export function codexHeadLimit(line: Record<string, unknown>): HeadLimit | undefined {
  const message = line.type === 'error' ? text(line.message) : line.type === 'turn.failed' ? text((line.error as { message?: unknown } | undefined)?.message) : '';
  if (!codexLimitText.test(message)) return undefined;
  return { message: cleanMessage(message)! };
}
export const headLimitReason = (provider: 'claude' | 'codex', limit: HeadLimit) =>
  `${provider === 'claude' ? 'Claude' : 'Codex'} usage limit reached${limit.resetsAt ? ` (resets ${limit.resetsAt})` : ''}: ${limit.message}`.slice(0, 500);

// ---- Codex chats: the account's rate-limit snapshot ----

export interface CodexLimitState { limited: boolean; resetsAt?: string; message?: string }
/** Limited when Codex says a bucket's limit is reached, or a window is fully used. */
export function codexLimitState(snapshot: QuotaSnapshot): CodexLimitState {
  const reached = snapshot.buckets.filter(bucket => bucket.reached);
  const windows = snapshot.buckets.flatMap(bucket => [bucket.primary, bucket.secondary]).filter(window => window && window.usedPercent >= 100);
  if (!reached.length && !windows.length) return { limited: false };
  // The limit lifts when the last full window resets.
  const resets = (windows.length ? windows : reached.flatMap(bucket => [bucket.primary, bucket.secondary])).map(window => window?.resetsAt).filter((value): value is number => value !== undefined);
  const resetsAt = resets.length ? new Date(Math.max(...resets) * 1000).toISOString() : undefined;
  const names = reached.map(bucket => `${bucket.name || bucket.id || 'Codex'}: ${bucket.reached}`);
  return { limited: true, ...(resetsAt ? { resetsAt } : {}), message: names.length ? `Codex reports a reached limit (${names.join(', ')}).` : 'Codex reports a usage window at 100%.' };
}
/**
 * How long until the next Codex poll: every 5 minutes; every 10 while limited (to
 * notice it clearing); doubling up to 30 after a failed read.
 */
export function codexPollDelay(previousMs: number, outcome: 'ok' | 'limited' | 'failed'): number {
  if (outcome === 'ok') return 5 * 60_000;
  if (outcome === 'limited') return 10 * 60_000;
  return Math.min(30 * 60_000, Math.max(5 * 60_000, previousMs * 2));
}
/** Emits one event when Codex becomes limited, and not again until it clears. */
export class CodexLimitTracker {
  private limited = false;
  observe(snapshot: QuotaSnapshot, now = new Date()): LimitEvent | undefined {
    const state = codexLimitState(snapshot);
    const became = state.limited && !this.limited;
    this.limited = state.limited;
    return became ? { provider: 'codex', source: 'chat', at: now.toISOString(), ...(state.resetsAt ? { resetsAt: state.resetsAt } : {}), ...(state.message ? { message: state.message } : {}) } : undefined;
  }
  get isLimited(): boolean { return this.limited; }
}
