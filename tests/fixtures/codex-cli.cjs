// A local Codex CLI fixture for the smoke test: version/help probes and the
// app-server quota read. Never contacts a model or reads provider credentials.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const args = process.argv.slice(2);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (args.includes('--version')) { console.log('codex-cli 0.154.0'); process.exit(0); }
if (args.includes('--help')) { console.log('app-server generate-ts generate-json-schema --listen'); process.exit(0); }
if (args[0] !== 'app-server') { console.error('Unsupported fixture invocation'); process.exit(2); }
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(path.join(process.cwd(), 'codex-requests.jsonl'), line + '\n');
  const reply = result => emit({ id: message.id, result });
  if (message.method === 'initialize') {
    if (message.params.capabilities.experimentalApi !== false) throw new Error('Unexpected experimental opt-in');
    reply({ userAgent: 'hydra/0.154.0 (test)', platformFamily: 'test', platformOs: 'test' });
  } else if (message.method === 'account/rateLimits/read') reply({ ordinaryUsageAllowed: null, rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1789700000 }, secondary: null }, rateLimitsByLimitId: null, accountId: 'private-fixture-account', rateLimitResetCredits: { availableCount: 1, credits: [{ id: 'private-reset-token' }] } });
  else if (message.method !== 'initialized') throw new Error(`Unexpected fixture request ${message.method}`);
});
input.on('close', () => process.exit(0));
setInterval(() => {}, 1000);
