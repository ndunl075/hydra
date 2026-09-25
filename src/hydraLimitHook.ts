import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { applyLaneId, normaliseStopFailure } from './core/limitDetection';

/**
 * Claude Code's StopFailure hook (matcher "rate_limit"), run as
 * `<Hydra executable> dist/hydra-limit-hook.cjs <events folder>` with
 * ELECTRON_RUN_AS_NODE=1 (see core/claudeLimitHook.ts). It reads the hook's JSON on
 * stdin and drops one event file for Hydra's windows. It never blocks or fails
 * Claude: any problem, or 5 seconds passing, ends it quietly with exit code 0.
 *
 * Inside a Hydra lane, the lane's own process (laneService.ts) sets HYDRA_LANE_ID
 * in its environment; the hook, a child of that process, inherits it and tags the
 * event as `source: "lane"` (docs/Gates_Plan.md, section 2).
 */
const maxInput = 256 * 1024;
const quit = () => process.exit(0);
setTimeout(quit, 5000);
process.on('uncaughtException', quit);

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) quit();
const chunks: Buffer[] = [];
let size = 0;
process.stdin.on('data', (chunk: Buffer) => {
  size += chunk.length;
  if (size > maxInput) quit();
  chunks.push(chunk);
});
process.stdin.on('error', quit);
process.stdin.on('end', () => {
  try {
    const raw = normaliseStopFailure(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (!raw) quit();
    const event = applyLaneId(raw!, process.env);
    mkdirSync(directory!, { recursive: true });
    const name = `${Date.now()}-${randomBytes(8).toString('hex')}`;
    const temporary = path.join(directory!, `${name}.tmp`);
    // Written aside, then renamed: a window never reads half a file.
    writeFileSync(temporary, JSON.stringify(event), { encoding: 'utf8', mode: 0o600 });
    try { renameSync(temporary, path.join(directory!, `${name}.json`)); } catch { rmSync(temporary, { force: true }); }
  } catch { /* never fail Claude */ }
  quit();
});
