import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const usage = `Usage:
  node scripts/native-visual-acceptance.mjs --fixture [--output <record.json>]
  node scripts/native-visual-acceptance.mjs --validate <record.json>

This tool creates or validates a local human-review record. It never starts Hydra,
opens a window, installs an application, changes a profile, signs in, or starts a provider.`;

export const requiredObservations = Object.freeze([
  ['editor-agents-switching', 'Switch Editor and Agents repeatedly; the selected workspace remains correct.'],
  ['dirty-tabs-preserved', 'Switch modes with an unsaved editor tab; its text and dirty state remain intact.'],
  ['terminal-ownership', 'Switch modes with a terminal open; the terminal remains owned by the native workbench.'],
  ['keyboard-focus', 'Use keyboard-only navigation and confirm each actionable control has visible focus.'],
  ['dark-light-appearance', 'Review both Hydra dark and light appearance in the native window.'],
  ['high-contrast', 'Review the high-contrast appearance in the native window.'],
  ['reduced-motion', 'Enable reduced motion and confirm animated UI does not animate.'],
  ['onboarding', 'Review the onboarding flow without starting a provider login or model turn.'],
  ['installer-wizard', 'Review the visible installer wizard only on a disposable Windows host.']
].map(([id, instruction]) => Object.freeze({ id, instruction })));

const ids = new Set(requiredObservations.map(item => item.id));

export function pendingRecord(recordedAt = new Date().toISOString()) {
  return {
    schema: 'hydra.native-visual-acceptance/v1',
    mode: 'fixture',
    status: 'human-visual-accessibility-acceptance-pending',
    recordedAt,
    scope: {
      host: 'local VS Code/Hydra fixture only',
      providerTurn: false,
      login: false,
      install: false
    },
    nativeHydraWindowInspected: false,
    observations: requiredObservations.map(item => ({ ...item, status: 'pending', observation: null })),
    limitations: [
      'Fixture mode does not inspect a native Hydra window.',
      'Fixture mode does not run an installer or modify a profile.',
      'Fixture mode does not authenticate an account or submit a provider turn.',
      'The existing native-workflow-acceptance fixture remains pending until a real native Hydra window is inspected.'
    ]
  };
}

const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

export function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Record must be an object.');
  if (record.schema !== 'hydra.native-visual-acceptance/v1') throw new Error('Unsupported native visual acceptance schema.');
  if (!nonEmptyString(record.recordedAt)) throw new Error('Record requires recordedAt.');
  if (!Array.isArray(record.observations)) throw new Error('Record requires observations.');

  const byId = new Map();
  for (const observation of record.observations) {
    if (!observation || typeof observation !== 'object' || !ids.has(observation.id)) throw new Error('Record has an unknown observation.');
    if (byId.has(observation.id)) throw new Error(`Record duplicates observation ${observation.id}.`);
    if (!['pending', 'passed', 'failed'].includes(observation.status)) throw new Error(`Observation ${observation.id} has an invalid status.`);
    byId.set(observation.id, observation);
  }
  for (const item of requiredObservations) if (!byId.has(item.id)) throw new Error(`Record is missing required observation ${item.id}.`);

  const failed = requiredObservations.filter(item => byId.get(item.id).status === 'failed');
  const incomplete = requiredObservations.filter(item => {
    const observation = byId.get(item.id);
    return observation.status !== 'passed' || !nonEmptyString(observation.observation);
  });
  const canPass = record.nativeHydraWindowInspected === true && failed.length === 0 && incomplete.length === 0;

  if (record.status === 'passed' && !canPass) {
    const problems = [
      record.nativeHydraWindowInspected === true ? undefined : 'a real native Hydra window was not recorded as inspected',
      ...failed.map(item => `${item.id} failed`),
      ...incomplete.filter(item => !failed.includes(item)).map(item => `${item.id} is missing a passing human observation`)
    ].filter(Boolean);
    throw new Error(`Native visual acceptance cannot pass: ${problems.join('; ')}.`);
  }
  if (!['human-visual-accessibility-acceptance-pending', 'passed'].includes(record.status)) throw new Error('Record has an invalid overall status.');
  return { canPass, failed: failed.map(item => item.id), incomplete: incomplete.map(item => item.id) };
}

function options(argv) {
  const value = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--fixture') value.fixture = true;
    else if (arg === '--validate' || arg === '--output') {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a path.`);
      value[arg.slice(2)] = next;
    } else throw new Error(`Unsupported argument: ${arg}`);
  }
  const fixtureValid = value.fixture === true && (!value.validate) && Object.keys(value).every(key => key === 'fixture' || key === 'output');
  const validateValid = typeof value.validate === 'string' && Object.keys(value).length === 1;
  if (!fixtureValid && !validateValid) throw new Error(usage);
  return value;
}

export async function run(argv = process.argv.slice(2)) {
  const input = options(argv);
  if (input.validate) {
    const record = JSON.parse(await readFile(path.resolve(input.validate), 'utf8'));
    const result = validateRecord(record);
    process.stdout.write(`${result.canPass ? 'pass-ready' : 'pending'}: ${path.resolve(input.validate)}\n`);
    return result;
  }
  const record = pendingRecord();
  const rendered = JSON.stringify(record, null, 2) + '\n';
  if (input.output) {
    const destination = path.resolve(input.output);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, rendered, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(`Pending native visual acceptance record written to ${destination}\n`);
  } else process.stdout.write(rendered);
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  run().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
