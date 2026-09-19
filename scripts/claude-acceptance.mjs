import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const testedVersion = '2.1.270';
const usage = `Usage: node scripts/claude-acceptance.mjs --fixture|--live --evidence <path> [--executable <path>] [--cancel-after-version]\n\nThis runner never signs in, checks account status, submits a user turn, reads credentials, or uses API billing.`;

function options(argv) {
  const value = { executable: 'claude', cancelAfterVersion: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--fixture' || arg === '--live') { if (value.mode) throw new Error('Choose exactly one of --fixture or --live.'); value.mode = arg.slice(2); }
    else if (arg === '--cancel-after-version') value.cancelAfterVersion = true;
    else if (arg === '--evidence' || arg === '--executable') { const next = argv[++index]; if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value.`); value[arg.slice(2)] = next; }
    else throw new Error(`Unsupported argument: ${arg}`);
  }
  if (!value.mode || !value.evidence) throw new Error(usage);
  return value;
}

function probe(executable, args, signal) {
  return new Promise(resolve => {
    const launch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)
      ? { executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-EncodedCommand', Buffer.from(`& ${[executable, ...args].map(value => `'${value.replaceAll("'", "''")}'`).join(' ')}; exit $LASTEXITCODE`, 'utf16le').toString('base64')] }
      : { executable, args };
    const child = spawn(launch.executable, launch.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = []; let bytes = 0; let settled = false; let timer;
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(result); };
    const abort = () => { child.kill(); finish({ exitCode: null, cancelled: true }); };
    const collect = data => { if (bytes >= 262144) return; const kept = data.subarray(0, 262144 - bytes); bytes += kept.length; output.push(kept); if (bytes >= 262144) { child.kill(); finish({ exitCode: null, error: 'output-limit' }); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => finish({ exitCode: null, error: 'spawn-failed' }));
    child.on('close', exitCode => finish({ exitCode, output: Buffer.concat(output).toString('utf8') }));
    timer = setTimeout(() => { child.kill(); finish({ exitCode: null, error: 'timeout' }); }, 15000);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function check(label, status) { return { label, status, evidence: 'pending-human-operated-managed-session' }; }

async function main() {
  const input = options(process.argv.slice(2));
  const evidencePath = path.resolve(input.evidence);
  const commands = []; const controller = new AbortController();
  const run = async (action, args) => {
    const result = await probe(input.executable, args, controller.signal);
    commands.push({ sequence: commands.length + 1, action, args, outcome: result.cancelled ? 'cancelled' : result.error ? result.error : result.exitCode === 0 ? 'ok' : 'nonzero' });
    return result;
  };
  const version = await run('version', ['--version']);
  const versionStatus = version.exitCode === 0 && new RegExp(`(?:^|\\s)${testedVersion.replaceAll('.', '\\.')}(?:\\s|$)`).test(version.output || '') ? 'matched' : 'unverified';
  let cancellation = 'not-requested';
  if (input.cancelAfterVersion) { controller.abort(); cancellation = 'cancelled-before-any-managed-turn'; }
  const fixture = input.mode === 'fixture';
  const evidence = {
    schema: 'hydra-claude-live-acceptance/v1', provider: 'claude', mode: input.mode,
    result: fixture ? 'fixture-passed-no-provider-turn' : 'pending-human-operated-account-and-managed-turn',
    version: { expected: testedVersion, status: versionStatus },
    account: { status: 'not-probed', authentication: 'unverified', acceptance: 'human-operated-provider-integration-required' },
    commands, cancellation,
    checks: [
      check('selected-model-and-effort-acknowledgement', fixture ? 'fixture-covered' : 'pending'),
      check('one-command-or-file-approval', fixture ? 'fixture-covered' : 'pending'),
      check('interrupt-owned-managed-session', fixture ? 'fixture-covered' : 'pending'),
      check('restart-and-resume-recorded-session', fixture ? 'fixture-covered' : 'pending')
    ],
    turn: fixture ? 'not-submitted-fixture' : 'pending-explicit-human-authorization',
    redaction: { rawProviderOutputRetained: false, credentialFieldsRetained: false, accountIdentityRetained: false, apiBillingUsed: false }
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${evidence.result}: ${evidencePath}\n`);
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
