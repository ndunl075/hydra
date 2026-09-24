import { spawn } from 'node:child_process';
import { executableFingerprint } from './providers';
import { processLaunch, terminateProcessTree } from './process';
import { supportedCliDescription, supportedCliVersionIn, type CliProvider } from './cliVersions';

/**
 * The one-time real self-check for a provider binary (decision 5): its version is
 * in the supported range, and it actually starts and answers. Claude must answer
 * a stream-json `initialize`; Codex must print its version and `exec` help. The
 * result is remembered per exact binary (path, size, times).
 */
export interface CliCheckResult { ok: boolean; version?: string; error?: string }
const remembered = new Map<string, CliCheckResult>();

function run(executable: string, args: string[], input: string | undefined, until: (output: string) => boolean, timeoutMs: number): Promise<{ output: string; code: number | null; matched: boolean }> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    const child = spawn(launch.executable, launch.args, { env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (matched: boolean, code: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (child.exitCode === null && child.pid) void terminateProcessTree(child.pid).catch(() => child.kill());
      resolve({ output, code, matched });
    };
    const timer = setTimeout(() => finish(false, null), timeoutMs);
    const collect = (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 200_000) output = output.slice(-100_000); if (until(output)) finish(true, null); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', error => { output += String(error); finish(false, null); });
    child.on('close', code => finish(until(output), code));
    if (input !== undefined) child.stdin.write(input); else child.stdin.end();
  });
}

export async function selfCheckCli(provider: CliProvider, executable: string): Promise<CliCheckResult> {
  const key = `${provider}\0${await executableFingerprint(executable)}`;
  const known = remembered.get(key);
  if (known) return known;
  const versionRun = await run(executable, ['--version'], undefined, () => false, 30_000);
  const version = supportedCliVersionIn(provider, versionRun.output);
  let result: CliCheckResult;
  if (!version) result = { ok: false, error: `Hydra helpers need ${supportedCliDescription(provider)}; ${executable} reports "${versionRun.output.trim().slice(0, 120) || 'no version'}".` };
  else if (provider === 'claude') {
    const init = JSON.stringify({ type: 'control_request', request_id: 'hydra-self-check', request: { subtype: 'initialize' } }) + '\n';
    const answered = await run(executable, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'], init, output => /"type":"control_response"[^\n]*"request_id":"hydra-self-check"/.test(output) || /"request_id":"hydra-self-check"[^\n]*"type":"control_response"/.test(output), 45_000);
    result = answered.matched ? { ok: true, version } : { ok: false, version, error: `Claude Code ${version} did not answer Hydra's start-up check. Run \`claude\` once in a terminal to finish its setup.` };
  } else {
    const help = await run(executable, ['exec', '--help'], undefined, () => false, 30_000);
    result = help.code === 0 && /--json/.test(help.output) ? { ok: true, version } : { ok: false, version, error: `Codex ${version} did not pass Hydra's start-up check (\`codex exec --help\`).` };
  }
  if (result.ok) remembered.set(key, result);
  return result;
}
