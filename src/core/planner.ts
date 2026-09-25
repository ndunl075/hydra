import { runProbe, type ProbeOutput } from './process';
import { parsePlannerOutput, type PlanJob } from './plans';
import type { Provider } from './model';

/**
 * Drafting a plan from a brief (docs/Lanes_And_Planner_Plan.md, "Planning a
 * brief"). Claude or Codex reads the repository read-only and replies with
 * JSON; Hydra never lets it write anything. Runs through processLaunch (via
 * runProbe, which already spawns that way, applies the timeout, and cancels
 * cleanly on abort) so this file stays about the prompt, the arguments and
 * the reply, not about spawning.
 */
export const plannerTimeoutMs = 4 * 60_000;
const maxPlannerOutputBytes = 4 * 1024 * 1024;
const clip = (value: string, max = 4000) => value.length > max ? `${value.slice(0, max)}…` : value;

/** What the planner is asked for: JSON only, 2-8 independently doable jobs, the same rules as heads. */
export function plannerPrompt(brief: string): string {
  return [
    'You are drafting a Hydra plan: a small graph of jobs that will each run as a separate, independent Hydra head. Read the repository first.',
    'Reply with JSON only: no prose, no markdown code fences, nothing before or after the object.',
    '{"jobs": [{"key": "kebab-case-id", "title": "...", "brief": "...", "provider": "claude" | "codex" (optional), "dependsOn": ["other-key"], "writeScope": ["path/"]}]}',
    'Return 2 to 8 jobs. Each job must be independently doable, the same rules Hydra heads follow:',
    '- Give it a complete brief: everything a fresh agent needs, since it will not see this conversation.',
    '- Give it a narrow write scope: the repository paths it may change. Other jobs may be touching the rest of the repository at the same time.',
    '- Keys are lowercase kebab-case, at most 24 characters, and unique. dependsOn lists the keys of jobs that must finish first; leave it [] when a job has no dependency.',
    '',
    'Brief:',
    brief,
  ].join('\n');
}

/** The exact CLI invocation for a planning run (unit-tested directly; nothing here spawns anything). */
export function plannerArguments(provider: Provider, prompt: string): string[] {
  return provider === 'codex' ? ['exec', '--json', '--sandbox', 'read-only', prompt] : ['-p', '--output-format', 'json', '--permission-mode', 'plan', prompt];
}

/**
 * Pull the model's final reply text out of the CLI's own JSON wrapper, so
 * parsePlannerOutput only has to deal with what the model wrote (which may
 * still be fenced or have prose around the plan JSON).
 * - Claude `-p --output-format json` prints one JSON object whose "result"
 *   field is the final message text.
 * - Codex `exec --json` streams one JSON object per line; the last agent
 *   message is the reply.
 * Falls back to the raw text when a provider's own envelope isn't there, so
 * parsePlannerOutput's own scan is still the safety net.
 */
export function plannerResultText(provider: Provider, stdout: string): string {
  if (provider === 'claude') {
    try {
      const envelope = JSON.parse(stdout) as { result?: unknown };
      if (typeof envelope.result === 'string') return envelope.result;
    } catch { /* not a single JSON envelope; fall back to the raw text below */ }
    return stdout;
  }
  let last: string | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { item?: { type?: string; text?: string }; msg?: { type?: string; message?: string } };
      const text = event.item?.type === 'agent_message' ? event.item.text : event.msg?.type === 'agent_message' ? event.msg.message : undefined;
      if (typeof text === 'string') last = text;
    } catch { /* not a JSON line (or unrelated); ignore it */ }
  }
  return last ?? stdout;
}

export interface PlanBriefSpec {
  provider: Provider;
  /** The already version-checked provider CLI (see Manager.helperExecutable). */
  executable: string;
  /** The repository the planner reads; it never writes here. */
  repository: string;
  brief: string;
  signal?: AbortSignal;
}
export type PlanBriefResult = { ok: true; jobs: PlanJob[] } | { ok: false; error: string };

/** Run the planner CLI and return its raw output alongside the extracted reply text. */
export async function runPlanner(spec: PlanBriefSpec): Promise<{ output: ProbeOutput; text: string }> {
  const prompt = plannerPrompt(spec.brief);
  const output = await runProbe(spec.executable, plannerArguments(spec.provider, prompt), spec.repository, { timeoutMs: plannerTimeoutMs, maxBytes: maxPlannerOutputBytes, signal: spec.signal });
  return { output, text: plannerResultText(spec.provider, output.stdout) };
}

/** Draft a plan from a brief: run the planner, then parse its reply. Never throws; a failure comes back as `{ ok: false, error }`. */
export async function planBrief(spec: PlanBriefSpec): Promise<PlanBriefResult> {
  const { output, text } = await runPlanner(spec);
  if (output.error) return { ok: false, error: output.error };
  if (output.exitCode !== 0) {
    const name = spec.provider === 'codex' ? 'Codex' : 'Claude';
    return { ok: false, error: `${name} exited with code ${output.exitCode ?? 'unknown'}.${output.stderr.trim() ? ` ${clip(output.stderr.trim())}` : ''}` };
  }
  try { return { ok: true, jobs: parsePlannerOutput(text) }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
}
