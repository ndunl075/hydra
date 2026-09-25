import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const usage = `Usage: node scripts/codex-acceptance.mjs --fixture [--output <evidence.json>]\n\nRuns a local fixture only. It never starts Codex, opens a browser, signs in,\nsubmits a prompt, reads credentials, or uses API billing. See docs/Codex_Live_Acceptance.md.`;

const exact = (actual, expected, name) => {
  if (actual.length !== expected.length || actual.some((method, index) => method !== expected[index])) {
    throw new Error(`${name} does not match the documented RPC ordering.`);
  }
};

/** Fixture mode never starts a provider process. */
export async function fixtureEvidence() {
  const accountRefresh = ['initialize', 'initialized', 'account/read'];
  const accountLoginCancel = ['initialize', 'initialized', 'account/login/start', 'account/login/cancel'];
  const quotaRefresh = ['initialize', 'initialized', 'account/rateLimits/read'];

  exact(accountRefresh, ['initialize', 'initialized', 'account/read'], 'account refresh');
  exact(accountLoginCancel, ['initialize', 'initialized', 'account/login/start', 'account/login/cancel'], 'account login cancellation');
  exact(quotaRefresh, ['initialize', 'initialized', 'account/rateLimits/read'], 'quota refresh');

  return {
    schema: 'hydra.codex-live-acceptance/v1',
    mode: 'fixture',
    liveAcceptance: 'pending-human-operated-run',
    provider: { id: 'codex', testedCliVersion: '0.154.0' },
    rpc: {
      accountRefresh,
      accountLoginCancel,
      quotaRefresh
    },
    assertions: {
      cancellation: { ownedChannelClosed: true, extraRequestsAfterCancellation: 0 },
      quota: { status: 'unavailable' },
      identityAndResetTokensAbsent: true
    },
    limitations: [
      'Fixture mode did not start Codex or inspect an executable.',
      'Fixture mode did not open a browser or authenticate a ChatGPT account.',
      'Fixture mode did not submit a provider turn or incur API billing.',
      'A browser opening or executable presence is not sign-in evidence.'
    ]
  };
}

export async function run(argv = process.argv.slice(2)) {
  const fixture = argv[0] === '--fixture';
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex === -1 ? undefined : argv[outputIndex + 1];
  const valid = fixture && (argv.length === 1 || (argv.length === 3 && outputIndex === 1 && typeof output === 'string' && output.length > 0));
  if (!valid) throw new Error(usage);
  const evidence = await fixtureEvidence();
  const rendered = JSON.stringify(evidence, null, 2) + '\n';
  if (output) {
    const target = path.resolve(output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, rendered, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`Fixture evidence written to ${target}\n`);
  } else process.stdout.write(rendered);
  return evidence;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
