import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runCheckCommand } from '../checkCommand';
import { terminateProcessTree } from '../process';
import { gateBlocks, gateKind, gateState, type JobCheckResult } from '../jobs';
import { loadGates, type Gate, type GatesConfig } from './config';
import { cdpBrowser } from './browser';
import { runCommandGate } from './command';
import { defaultRunReviewer, formatFinding, runReviewGate } from './review';
import { freePort, runScreenshotsGate } from './screenshots';
import { clip, notRun, providerName, type GateContext, type GateRuntime } from './types';

/**
 * Gates (docs/Gates_Plan.md, section 1): the second pass that has to prove a
 * head's work before it is accepted, or a lane's before it is merged.
 *
 * Order is fixed: command gates first (cheap), then screenshots, then the
 * review, which sees the earlier results and the screenshots. A gate with
 * `required: false` is reported but never blocks. Once a required gate fails,
 * the later ones are reported as not run instead of spending a review on work
 * that is going back anyway. Everything runs in the given worktree only.
 */
export * from './config';
export type { GateContext, GateRuntime, ReviewerSpec } from './types';
export type { ScreenshotBrowser, BrowserSession, PageCapture } from './browser';
export { findBrowser } from './browser';

const kindOrder: Readonly<Record<Gate['type'], number>> = { command: 0, screenshots: 1, review: 2 };
/** Command gates, then screenshots, then reviews; the file's order within each. */
export const gateOrder = (gates: readonly Gate[]): Gate[] => [...gates].sort((a, b) => kindOrder[a.type] - kindOrder[b.type]);

export const defaultGateRuntime = (): GateRuntime => ({
  runCommand: (command, cwd, logFile, timeoutMs, signal, spawned) => runCheckCommand(command, cwd, logFile, signal, undefined, 3000, timeoutMs, undefined, spawned),
  runReviewer: defaultRunReviewer,
  browser: cdpBrowser,
  freePort,
  fetch: (input, init) => fetch(input, init),
  terminate: terminateProcessTree,
  now: Date.now,
  pollMs: 500,
});

/** Run these gates, in order, in `worktree`. Never throws for a gate: a gate Hydra can't run is reported as not run. */
export async function runGateList(gates: readonly Gate[], worktree: string, baseCommit: string, context: GateContext): Promise<JobCheckResult[]> {
  if (!path.isAbsolute(worktree)) throw new Error('Gates need the worktree\'s absolute path.');
  const runtime: GateRuntime = { ...defaultGateRuntime(), ...context.runtime };
  const results: JobCheckResult[] = [];
  if (!gates.length) return results;
  await mkdir(context.logDirectory, { recursive: true });
  let blocker: JobCheckResult | undefined;
  // A pack's gate says so on its result, for "From the Coding pack" (docs/Packs_Plan.md).
  const fromPack = (gate: Gate, result: JobCheckResult): JobCheckResult => gate.pack ? { ...result, pack: gate.pack, ...(gate.packTitle ? { packTitle: gate.packTitle } : {}) } : result;
  for (const gate of gateOrder(gates)) {
    if (context.signal?.aborted) { results.push(fromPack(gate, notRun(gate, 'Stopped before it ran.'))); continue; }
    if (blocker) { results.push(fromPack(gate, notRun(gate, `Skipped: ${blocker.id} failed first.`))); continue; }
    context.onProgress?.({ done: [...results], running: gate.id });
    const run = { ...context, worktree, baseCommit, runtime, earlier: [...results] };
    let result: JobCheckResult;
    try {
      result = gate.type === 'command' ? await runCommandGate(gate, run)
        : gate.type === 'screenshots' ? await runScreenshotsGate(gate, run)
        : await runReviewGate(gate, run);
    } catch (error) {
      result = notRun(gate, `Hydra couldn't run it: ${error instanceof Error ? error.message : String(error)}`);
    }
    result = fromPack(gate, result);
    context.log?.(`[gates] ${gate.id} (${gate.type}): ${describeState(result)}${result.summary ? `. ${clip(result.summary, 200)}` : ''}`);
    results.push(result);
    if (gateBlocks(result)) blocker = result;
  }
  context.onProgress?.({ done: [...results] });
  return results;
}

/**
 * Where a folder's gates come from. `loadGates` reads gates.json only; the packs
 * loader (src/core/packs/gates.ts, effectiveGates) adds the active packs' gates,
 * and `notRun` results for the gates of listed packs that can't run
 * (docs/Packs_Plan.md, "When a pack is active"). Those never block.
 */
export type GatesLoader = (folder: string) => Promise<GatesConfig & { notRun?: JobCheckResult[] }>;

export interface GatesOutcome {
  /** Where the gates came from: gates.json, checks.json, or none at all. */
  source: GatesConfig['source'];
  /** gates.json's lanes policy: whether Merge runs the gates. */
  lanes: GatesConfig['lanes'];
  maxAttempts?: number;
  results: JobCheckResult[];
  /** The required gates that failed. Empty means the work may go in. */
  failed: JobCheckResult[];
}

/**
 * Run a folder's gates against a worktree: for a lane's Merge and Run gates
 * (docs/Gates_Plan.md, "Lanes"). `folder` is the main checkout the gates are
 * read from; `worktree` is where they run, never the main checkout itself;
 * `baseCommit` is where the work started (for a lane, merge-base(target, lane)),
 * so the review sees `baseCommit..HEAD`.
 */
export async function runGates(folder: string, worktree: string, baseCommit: string, context: GateContext, loader: GatesLoader = loadGates): Promise<GatesOutcome> {
  const canonical = async (value: string) => { const resolved = await realpath(value).catch(() => path.resolve(value)); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; };
  if (await canonical(folder) === await canonical(worktree)) throw new Error('Gates run in a worktree, never in the main checkout.');
  const config = await loader(folder);
  const results = [...await runGateList(config.gates, worktree, baseCommit, context), ...config.notRun ?? []];
  return { source: config.source, lanes: config.lanes, ...(config.maxAttempts !== undefined ? { maxAttempts: config.maxAttempts } : {}), results, failed: results.filter(gateBlocks) };
}

const describeState = (result: JobCheckResult): string => { const state = gateState(result); return state === 'notRun' ? 'not run' : state; };

/** A folder for one run's logs that no earlier run used: `<name>`, else `<name>-2`, `<name>-3`… */
export async function freshDirectory(parent: string, name: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  for (let index = 1; ; index++) {
    const candidate = path.join(parent, index === 1 ? name : `${name}-${index}`);
    try { await mkdir(candidate); return candidate; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || index > 999) throw error; }
  }
}

/**
 * What a head is told when gates fail: each failed required gate with its
 * findings, errors or output, and its evidence; then what failed or didn't run
 * without blocking.
 */
export function gateFailureMessage(results: readonly JobCheckResult[], ending = 'Fix them, commit, and call hydra_done again.'): string {
  const lines = ['These gates failed:'];
  for (const result of results.filter(gateBlocks)) {
    const kind = gateKind(result);
    if (kind === 'command') {
      lines.push(`- ${result.id} (command, exit ${result.exitCode ?? 'none'})${result.summary ? `: ${result.summary}` : ':'}`, result.outputTail);
    } else if (kind === 'review') {
      lines.push(`- ${result.id} (review${result.reviewer ? ` by ${providerName(result.reviewer)}` : ''}): ${result.summary ?? ''}`.trimEnd());
      for (const finding of result.findings ?? []) lines.push(`  - ${formatFinding(finding)}`);
    } else {
      lines.push(`- ${result.id} (screenshots): ${result.outputTail || result.summary || ''}`.trimEnd());
      const pictures = (result.evidence ?? []).filter(file => /\.png$/i.test(file));
      if (pictures.length) lines.push(`  Screenshots: ${pictures.join(', ')}`);
    }
  }
  const others = results.filter(result => !gateBlocks(result) && gateState(result) !== 'passed' && !/^Skipped: /.test(result.summary ?? ''));
  if (others.length) {
    lines.push('', 'Also reported, but not blocking:');
    for (const result of others) lines.push(`- ${result.id}: ${gateState(result) === 'notRun' ? 'not run' : 'failed'}${result.summary ? `. ${clip(result.summary, 300)}` : ''}`);
  }
  lines.push(ending);
  return lines.join('\n');
}

/** The failed gates, one short line each — for a lane's merge/run-gates modal, which has its own detail area and doesn't need gateFailureMessage's full output tails. */
export function summarizeGateFailures(results: readonly JobCheckResult[]): string {
  return results.filter(gateBlocks).map(result => {
    const kind = gateKind(result);
    const detail = kind === 'command' ? `exit ${result.exitCode ?? 'none'}`
      : kind === 'review' ? (result.findings?.length ? `${result.findings.length} finding${result.findings.length === 1 ? '' : 's'}` : result.summary || 'failed')
      : result.summary || 'failed';
    return `${result.id} (${kind}): ${detail}`;
  }).join('\n');
}
/** "Send to lane" (docs/Gates_Plan.md, "Merge"): gateFailureMessage flattened to one line, capped at ~1500 characters, so it fits a terminal's input line. A lane has no hydra_done. */
export function flattenGateFailureMessage(results: readonly JobCheckResult[], max = 1500): string {
  const flat = gateFailureMessage(results, 'Fix them and commit; the gates run again when the lane is merged.').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
