import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore, parseJobInput } from '../src/core/jobs';
import { HelperEndpoint, callHelperEndpoint } from '../src/core/helperEndpoint';
import { HelperService, helperPrompt } from '../src/core/helperService';
import { claudeHelperArguments, claudeHelperTools, codexHelperArguments, type HelperRun, type HelperRunSpec } from '../src/core/helperRunner';
import { leadToolsWithRoles, rolesGuidance } from '../src/core/helperTools';
import { createBridge } from '../src/core/mcpBridge';
import { writeWindowRecord } from '../src/core/helperDiscovery';
import { LaneStore, lanePreamble, lanePreambleMax, laneRolePrompt, parseLaneInput, validateLane, type Lane } from '../src/core/lanes';
import { LaneService, laneLaunch } from '../src/core/laneService';
import { parseLaneMessage } from '../src/core/model';
import { validatePlanJobs } from '../src/core/plans';
import { combineGates } from '../src/core/packs/gates';
import { codexDeveloperInstructions, developerInstructionsMax, findRole, roleFirstPrompt, roleLaunch, roleSummaries, serverCommand, type ResolvedRole, type RoleLaunch } from '../src/core/packs/launch';
import { PackService } from '../src/core/packs/service';
import { fakePtyModule } from './lanePtyFake';

// ---- A test pack: a Claude builder, a Codex checker with web, and servers of each kind ----

const hydraExe = 'C:\\Program Files\\Hydra\\Hydra.exe';
const kit = (extraRoles: unknown[] = []) => ({
  version: 1, id: 'kit', title: 'Kit', description: 'Roles for tests.',
  roles: [
    { id: 'builder', title: 'Builder', description: 'Builds things with tests.', provider: 'claude', instructions: 'roles/builder.md', skills: ['test-first'], mcpServers: ['local'], model: 'opus' },
    { id: 'checker', title: 'Checker', description: 'Checks each claim against its source.', provider: 'codex', instructions: 'roles/checker.md', tools: ['web'], changes: 'optional', mcpServers: ['lookup', 'argsref', 'remote'] },
    ...extraRoles,
  ],
  gates: [{ id: 'kit-review', type: 'review', reviewer: 'other', role: 'checker', focus: 'Every claim has a source.' }],
  mcpServers: {
    local: { type: 'stdio', command: '{node}', args: ['{pack}/server.mjs'], env: { KIT_MODE: 'fast', KIT_TOKEN: '${KIT_TOKEN}' } },
    lookup: { type: 'stdio', command: 'npx', args: ['-y', 'lookup-mcp@1.2.3'], env: { LOOKUP_KEY: '${MY_LOOKUP_KEY}' } },
    argsref: { type: 'stdio', command: 'npx', args: ['-y', 'argsref@1.0.0', '--dir=${KIT_DIR}'] },
    remote: { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}', 'X-Team': 'docs' } },
    unused: { type: 'stdio', command: 'npx', args: ['-y', 'unused-mcp@1.0.0'] },
  },
});
const kitFiles = (manifest: unknown = kit(), extra: Record<string, string> = {}): Record<string, string> => ({
  'pack.json': JSON.stringify(manifest),
  'roles/builder.md': 'Read the code first.\nWrite tests before you change anything.\n',
  'roles/checker.md': 'Check every claim. Don\'t fix what you can\'t source.\n',
  'skills/test-first/SKILL.md': '---\nname: test-first\ndescription: Write a failing test first, make it pass, then tidy.\n---\n\nSteps.\n',
  'server.mjs': 'process.exit(0);\n',
  ...extra,
});
/** The variables the test pack's servers read. The values must never reach an argument or a file. */
const secrets = { KIT_TOKEN: 'secret-kit-token-1', MY_LOOKUP_KEY: 'secret-lookup-2', REMOTE_TOKEN: 'secret-remote-3', KIT_DIR: 'secret-dir-4' };
/** Heads read their environment from Hydra's own: the test pack's variables are set there while `work` runs. */
async function withSecrets<T>(work: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(secrets).map(key => [key, process.env[key]]));
  Object.assign(process.env, secrets);
  try { return await work(); }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

async function writeFolder(folder: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(folder, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}
async function repository(root: string, gates?: unknown): Promise<string> {
  const repo = path.join(root, 'repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  await git(root, ['init', '-q', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  if (gates) { await mkdir(path.join(repo, '.hydra'), { recursive: true }); await writeFile(path.join(repo, '.hydra', 'gates.json'), JSON.stringify(gates)); }
  await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
  return repo;
}
/** A lead folder with the kit pack built in and turned on, and the pack service that reads it. */
async function packWorld(options: { manifest?: unknown; extra?: Record<string, string>; gates?: unknown; userServers?: Partial<Record<'claude' | 'codex', string[]>> } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'hydra-roles-'));
  const repo = await repository(root, options.gates);
  await writeFolder(path.join(root, 'builtin', 'kit'), kitFiles(options.manifest, options.extra));
  const packs = new PackService({ builtin: path.join(root, 'builtin'), userFolder: () => path.join(root, 'user'), storage: path.join(root, 'storage', 'packs'), version: '0.24.0', nodeExecutable: hydraExe, userServers: async () => options.userServers ?? {} });
  const state = (await packs.state(repo)).packs.find(pack => pack.id === 'kit')!;
  assert.equal(state.state, 'off', state.reason);
  await packs.turnOn(repo, 'kit', state.pack!.hash!);
  return { root, repo, packs, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}

// ---- Naming roles ----

test('role names: the id when one active pack has it, else pack/role; unknown and ambiguous names are refused, listing the active roles', async () => {
  const summaries = roleSummaries([
    { id: 'coding', title: 'Coding', roles: [{ id: 'builder', title: 'Builder', description: 'b', provider: 'claude' }, { id: 'reviewer', title: 'Reviewer', description: 'r', provider: 'codex' }] },
    { id: 'web', title: 'Web', roles: [{ id: 'builder', title: 'Web builder', description: 'w', provider: 'claude' }] },
  ]);
  assert.deepEqual(summaries.map(role => [role.ref, role.name]), [['coding/builder', 'coding/builder'], ['coding/reviewer', 'reviewer'], ['web/builder', 'web/builder']]);
  assert.equal(findRole(summaries, 'reviewer').ref, 'coding/reviewer');
  assert.equal(findRole(summaries, 'web/builder').title, 'Web builder');
  assert.throws(() => findRole(summaries, 'builder'), /More than one active pack has a role "builder". Name it with its pack: coding\/builder, web\/builder\./);
  assert.throws(() => findRole(summaries, 'nope'), /There's no active role "nope". Active roles: coding\/builder, reviewer, web\/builder\./);
  assert.throws(() => findRole([], 'nope'), /No roles are active in this project; turn on a pack in Settings → Packs\./);

  const world = await packWorld();
  try {
    assert.deepEqual((await world.packs.roles(world.repo)).map(role => [role.name, role.provider]), [['builder', 'claude'], ['checker', 'codex']]);
    assert.equal((await world.packs.pick(world.repo, 'kit/checker')).title, 'Checker');
    await assert.rejects(world.packs.pick(world.repo, 'kit/ghost'), /The role kit\/ghost isn't available \(the Kit pack has no role "ghost"\)\. Active roles: builder, checker\./);
    await assert.rejects(world.packs.pick(world.repo, 'other/builder'), /the other pack isn't installed/);
    await world.packs.setEnabled(world.repo, 'kit', false);
    assert.deepEqual(await world.packs.roles(world.repo), []);
    await assert.rejects(world.packs.resolve(world.repo, 'kit/builder'), (error: Error & { laneNote?: string }) => {
      assert.equal(error.message, 'the role kit/builder isn\'t available (the Kit pack is off).');
      assert.equal(error.laneNote, 'Role Builder isn\'t available: the Kit pack is off.');
      return true;
    });
  } finally { await world.close(); }
});

// ---- roleLaunch: section 5's table ----

test('roleLaunch for Claude: the servers the role lists, from the checked copy, with ${NAME} kept; Skill, mcp__ and web tools; the model on its own provider', async () => {
  const world = await packWorld();
  try {
    const builder = await world.packs.resolve(world.repo, 'kit/builder');
    assert.equal(builder.copy, (await world.packs.state(world.repo)).packs[0]!.copy, 'everything points into the checked copy');
    const head = roleLaunch(builder, { provider: 'claude', target: 'head', env: secrets });
    assert.deepEqual(head.mcpServers, { 'kit-local': { type: 'stdio', command: hydraExe, args: [path.join(builder.copy, 'server.mjs')], env: { KIT_MODE: 'fast', KIT_TOKEN: '${KIT_TOKEN}', ELECTRON_RUN_AS_NODE: '1' } } }, '{node} is Hydra as Node, {pack} the copy');
    assert.deepEqual(head.allowedTools, ['Skill', 'mcp__kit-local']);
    assert.equal(head.model, 'opus');
    assert.equal(head.webSearch, 'disabled');
    assert.equal(head.systemPromptFile, undefined, 'a head hears its role in its first message');
    assert.ok(head.pluginDir && await access(path.join(head.pluginDir, 'skills', 'test-first', 'SKILL.md')).then(() => true), 'the role\'s plugin holds its skill');
    assert.equal(head.text, `Read the code first.\nWrite tests before you change anything.\n\nSkills you can use:\n- test-first: Write a failing test first, make it pass, then tidy. (${path.join(builder.copy, 'skills', 'test-first', 'SKILL.md')})\nRead the file before you use the skill.`);
    const lane = roleLaunch(builder, { provider: 'claude', target: 'lane', env: secrets });
    assert.equal(lane.systemPromptFile, path.join(builder.copy, 'roles', 'builder.md'));
    assert.equal(roleLaunch(builder, { provider: 'codex', target: 'head', env: secrets }).model, undefined, 'decision 4: the other provider keeps its default');
    for (const launch of [head, lane]) assert.doesNotMatch(JSON.stringify(launch), /secret-/, 'no value of a variable in anything Hydra passes or writes');

    const checker = await world.packs.resolve(world.repo, 'kit/checker');
    assert.deepEqual(checker.servers.map(server => server.id), ['lookup', 'argsref', 'remote'], 'decision 5: only the servers the role lists');
    const web = roleLaunch(checker, { provider: 'claude', target: 'head', env: secrets });
    assert.deepEqual(Object.keys(web.mcpServers), ['kit-lookup', 'kit-argsref', 'kit-remote'], 'a server Codex can\'t use still runs for Claude');
    assert.deepEqual(web.mcpServers['kit-remote'], { type: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer ${REMOTE_TOKEN}', 'X-Team': 'docs' } });
    assert.deepEqual(web.allowedTools, ['mcp__kit-lookup', 'mcp__kit-argsref', 'mcp__kit-remote', 'WebSearch', 'WebFetch']);
    assert.equal(web.changes, 'optional');
  } finally { await world.close(); }
});

test('roleLaunch for Codex: -c servers with env_vars and approval, variables in its own environment, web_search, and servers left out with a note', async () => {
  const world = await packWorld();
  try {
    const checker = await world.packs.resolve(world.repo, 'kit/checker');
    const codex = roleLaunch(checker, { provider: 'codex', target: 'head', env: secrets, platform: 'linux' });
    assert.deepEqual(codex.codexConfig, [
      '-c', "mcp_servers.kit-lookup.command='npx'", '-c', "mcp_servers.kit-lookup.args=['-y', 'lookup-mcp@1.2.3']",
      '-c', "mcp_servers.kit-lookup.env_vars=['LOOKUP_KEY']", '-c', 'mcp_servers.kit-lookup.startup_timeout_sec=60',
      '-c', "mcp_servers.kit-lookup.default_tools_approval_mode='approve'",
      '-c', "mcp_servers.kit-remote.url='https://example.invalid/mcp'", '-c', "mcp_servers.kit-remote.http_headers={ X-Team = 'docs' }",
      '-c', "mcp_servers.kit-remote.bearer_token_env_var='REMOTE_TOKEN'", '-c', "mcp_servers.kit-remote.default_tools_approval_mode='approve'",
    ]);
    assert.deepEqual(codex.env, { LOOKUP_KEY: secrets.MY_LOOKUP_KEY }, 'R4: the server reads LOOKUP_KEY by name, so Codex gets it in its environment');
    assert.doesNotMatch(codex.codexConfig.join(' '), /secret-|"/, 'no value on the command line, and no double quote for the shim to strip');
    assert.deepEqual(codex.notes, ['The kit-argsref server was left out: Codex can\'t use it. Codex doesn\'t fill in ${NAME} in arguments.']);
    assert.equal(codex.webSearch, 'live');
    assert.deepEqual(codex.allowedTools, [], 'Codex has no allowed-tools list');
    assert.equal(codex.model, undefined);

    // R3: a variable without a default that isn't set leaves its server out, for both CLIs.
    const unset = roleLaunch(checker, { provider: 'codex', target: 'head', env: { REMOTE_TOKEN: 'x' } });
    assert.deepEqual(unset.notes, ['The kit-lookup server was left out: ${MY_LOOKUP_KEY} isn\'t set in your environment.', 'The kit-argsref server was left out: Codex can\'t use it. Codex doesn\'t fill in ${NAME} in arguments.']);
    const builder = await world.packs.resolve(world.repo, 'kit/builder');
    assert.deepEqual(roleLaunch(builder, { provider: 'claude', target: 'lane', env: {} }).notes, ['The kit-local server was left out: ${KIT_TOKEN} isn\'t set in your environment.']);
    assert.equal(roleLaunch(builder, { provider: 'claude', target: 'lane', env: { kit_token: 'x' }, platform: 'win32' }).notes.length, 0, 'Windows names are case-insensitive');
    // Your own server with the same name wins.
    const yours: ResolvedRole = { ...builder, userServers: { claude: ['Kit-Local'] } };
    const clash = roleLaunch(yours, { provider: 'claude', target: 'head', env: secrets });
    assert.deepEqual(clash.mcpServers, {}); assert.deepEqual(clash.allowedTools, ['Skill']);
    assert.deepEqual(clash.notes, ['The kit-local server was left out: you already have a server with that name.']);
    // A variable Codex needs under another name is never set over one you have, or over one that steers the CLI.
    assert.deepEqual(roleLaunch(checker, { provider: 'codex', target: 'head', env: { ...secrets, LOOKUP_KEY: 'mine' } }).notes[0], 'The kit-lookup server was left out: LOOKUP_KEY is already set in your environment.');
    const steering: ResolvedRole = { ...checker, servers: [{ ...checker.servers[0]!, spec: { type: 'stdio', command: 'npx', args: [], env: { OPENAI_API_KEY: '${MY_LOOKUP_KEY}' } } }] };
    assert.deepEqual(roleLaunch(steering, { provider: 'codex', target: 'head', env: secrets }).notes, ['The kit-lookup server was left out: Hydra doesn\'t set OPENAI_API_KEY for Codex.']);
    // A resolved path Codex can't be given safely: the server is left out, never mis-quoted.
    const quoted: ResolvedRole = { ...builder, copy: 'C:\\Users\\O\'Brien\\kit' };
    assert.deepEqual(roleLaunch(quoted, { provider: 'codex', target: 'head', env: secrets }).notes, ['The kit-local server was left out: its settings can\'t be passed to Codex safely.']);
    // Through a .cmd shim, a path cmd.exe would misread never reaches the command line.
    const ampersand: ResolvedRole = { ...builder, plugin: 'C:\\A&B\\plugin' };
    const shimmed = roleLaunch(ampersand, { provider: 'claude', target: 'lane', env: secrets, shim: true });
    assert.equal(shimmed.pluginDir, undefined); assert.ok(!shimmed.allowedTools.includes('Skill'));
    assert.deepEqual(shimmed.notes, ['The role\'s skills were left out: its path has characters cmd.exe reads as commands.']);
  } finally { await world.close(); }
});

// ---- Heads: arguments, the first message, and the service ----

const runSpec = (extra: Partial<HelperRunSpec> = {}): HelperRunSpec => ({ provider: 'claude', executable: 'claude', worktree: 'W', prompt: 'P', maxTurns: 7, maxBudgetUsd: 2, bridge: { command: 'Hydra.exe', args: ['b.cjs'], env: { HYDRA_HELPER_TOKEN: 'tok', HYDRA_HELPER_PORT: '1' } }, logFile: 'l', ...extra });
test('head arguments: a role adds its --mcp-config file, allowed tools and --plugin-dir for Claude, and its -c servers and web_search for Codex; nothing without one', () => {
  const plain = claudeHelperArguments(runSpec());
  assert.equal(plain.filter(arg => arg.startsWith('--mcp-config')).length, 1);
  assert.equal(plain[plain.indexOf('--allowedTools') + 1], claudeHelperTools.join(','));
  for (const absent of ['--plugin-dir', '--add-dir', 'Skill', 'WebFetch']) assert.ok(!plain.join(' ').includes(absent), absent);
  const role = { mcpConfigFile: 'C:\\logs\\abc.mcp.json', pluginDir: 'C:\\cache\\kit.plugins\\builder', allowedTools: ['Skill', 'mcp__kit-local', 'WebSearch', 'WebFetch'], codexConfig: ['-c', "mcp_servers.kit-lookup.command='npx'"], webSearch: 'live' as const, env: { LOOKUP_KEY: 'v' } };
  const claude = claudeHelperArguments(runSpec({ role }));
  assert.equal(claude[claude.indexOf('--allowedTools') + 1], [...claudeHelperTools, 'Skill', 'mcp__kit-local', 'WebSearch', 'WebFetch'].join(','));
  const mcp = claude.filter(arg => arg.startsWith('--mcp-config'));
  assert.equal(mcp.length, 2); assert.match(mcp[0]!, /^--mcp-config=\{.*tok/, 'Hydra\'s token stays inline'); assert.equal(mcp[1], '--mcp-config=C:\\logs\\abc.mcp.json');
  assert.ok(claude.indexOf('--strict-mcp-config') > claude.indexOf(mcp[1]!), 'still strict: only these servers');
  assert.deepEqual(claude.slice(claude.indexOf('--plugin-dir'), claude.indexOf('--plugin-dir') + 2), ['--plugin-dir', role.pluginDir]);
  assert.ok(!claude.includes('--add-dir'), 'R8: Read reaches the copy without --add-dir');

  const codexPlain = codexHelperArguments(runSpec({ provider: 'codex' }));
  assert.ok(codexPlain.includes("web_search='disabled'"), 'R7: a head without a role doesn\'t search');
  assert.ok(!codexPlain.some(arg => arg.startsWith('mcp_servers.kit-')));
  const codex = codexHelperArguments(runSpec({ provider: 'codex', role }), 'thread-1');
  assert.deepEqual(codex.slice(0, 3), ['exec', 'resume', '--json'], 'a follow-up keeps the role\'s servers: they are this process\'s config');
  assert.ok(codex.includes("mcp_servers.kit-lookup.command='npx'")); assert.ok(codex.includes("web_search='live'"));
  assert.ok(!codex.includes("web_search='disabled'")); assert.ok(!codex.join(' ').includes('"'));
});

test('helperPrompt: "Your role", its instructions and skill index come first; an optional-changes role hears its summary can be the result', async () => {
  const world = await packWorld();
  try {
    const builder = roleLaunch(await world.packs.resolve(world.repo, 'kit/builder'), { provider: 'claude', target: 'head', env: secrets });
    const job = { id: 'a'.repeat(12), title: 'Build the cart API', brief: 'Add the cart endpoints.', writeScope: ['src/'], worktree: 'W', branch: 'b', baseCommit: 'c' };
    const prompt = helperPrompt(job, undefined, 'heads', builder);
    assert.ok(prompt.startsWith(`You are a Hydra head (job ${job.id}): Build the cart API\n\nYour role: Builder (Kit pack)\nRead the code first.\nWrite tests before you change anything.\n\nSkills you can use:\n- test-first: Write a failing test first, make it pass, then tidy. (`), prompt);
    assert.match(prompt, /SKILL\.md\)\nRead the file before you use the skill\.\n\nAdd the cart endpoints\.\n\nHow to work:/);
    assert.doesNotMatch(prompt, /summary is the result/);
    const checker = roleLaunch(await world.packs.resolve(world.repo, 'kit/checker'), { provider: 'codex', target: 'head', env: secrets });
    assert.match(helperPrompt(job, undefined, 'heads', checker), /Your role may finish without changing any file: then your summary is the result/);
    assert.doesNotMatch(helperPrompt(job), /Your role/, 'nothing without a role');
  } finally { await world.close(); }
});

test('parseJobInput: role names are checked, and a missing provider stays missing so the role\'s can apply', () => {
  const base = { title: 'T', brief: 'B', write_scope: ['src/'], idempotency_key: 'k' };
  assert.equal(parseJobInput(base).provider, undefined);
  assert.equal(parseJobInput({ ...base, provider: 'codex' }).provider, 'codex');
  assert.equal(parseJobInput({ ...base, role: 'builder' }).role, 'builder');
  assert.equal(parseJobInput({ ...base, role: 'coding/builder' }).role, 'coding/builder');
  for (const role of ['Builder', 'a/b/c', '../x', '', 7]) assert.throws(() => parseJobInput({ ...base, role }), /role must be a role's name/);
  assert.equal(parseJobInput({ ...base, jobRole: { ref: 'x/y', title: 'Y', packTitle: 'X' } } as never).jobRole, undefined, 'only Hydra records the resolved role');
});

type Script = (helper: { spec: HelperRunSpec; call: (tool: string, args?: Record<string, unknown>) => Promise<{ ok: boolean; result?: any; error?: string }>; exit: (code: number) => void; commit: (file: string, text: string) => Promise<void> }) => Promise<void>;
async function headWorld(script: Script, options: { gates?: unknown; noPacks?: boolean } = {}) {
  const world = await packWorld({ gates: options.gates });
  const store = new JobStore(path.join(world.root, 'jobs')); await store.load();
  let service!: HelperService;
  const endpoint = new HelperEndpoint((caller, tool, args, signal) => service.handle(caller, tool, args, signal));
  const port = await endpoint.start();
  const runs: HelperRunSpec[] = [];
  const mcpFiles: { file: string; text: string; exists: boolean }[] = [];
  /** Assertions that failed inside a head's script. */
  const problems: unknown[] = [];
  service = new HelperService({
    store, endpoint, leadFolder: world.repo, leadKey: 'window', worktreeRoot: () => path.join(world.root, 'worktrees'),
    executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: ['hydra-mcp.cjs'] },
    logDirectory: path.join(world.root, 'logs'), maxConcurrent: () => 2, watchdogMs: 20,
    ...(options.noPacks ? {} : { roles: world.packs }),
    startRun: spec => {
      runs.push(spec);
      if (spec.role?.mcpConfigFile) mcpFiles.push({ file: spec.role.mcpConfigFile, text: '', exists: false });
      let exit!: (code: number) => void; let stopped = false;
      const exited = new Promise<{ code: number | null }>(resolve => { exit = code => { if (!stopped) { stopped = true; resolve({ code }); } }; });
      const run: HelperRun = { onTurnEnd: () => undefined, exited, send: async () => !stopped, stop: async () => exit(137) };
      const token = spec.bridge.env.HYDRA_HELPER_TOKEN!;
      setTimeout(() => void (async () => {
        const entry = mcpFiles.find(item => item.file === spec.role?.mcpConfigFile);
        if (entry) { entry.text = await readFile(entry.file, 'utf8'); entry.exists = true; }
        await script({
          spec, exit,
          call: (tool, args = {}) => callHelperEndpoint(Number(spec.bridge.env.HYDRA_HELPER_PORT), token, tool, args),
          commit: async (file, text) => { await mkdir(path.dirname(path.join(spec.worktree, file)), { recursive: true }); await writeFile(path.join(spec.worktree, file), text); await git(spec.worktree, ['add', '.']); await git(spec.worktree, ['commit', '-qm', `head: ${file}`]); },
        });
      })().catch(error => { problems.push(error); }), 0);
      return run;
    },
  });
  const lead = endpoint.issue({ role: 'lead', leadKey: 'window' });
  const call = (tool: string, args: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> => callHelperEndpoint(port, lead, tool, args);
  const start = (key: string, extra: Record<string, unknown> = {}) => call('hydra_start_head', { title: `Job ${key}`, brief: 'Do the thing.', write_scope: ['src/'], idempotency_key: key, ...extra });
  const wait = async (ids: string[]) => (await call('hydra_wait_for_heads', { job_ids: ids, max_wait_s: 90 })).result;
  return { ...world, store, service, runs, mcpFiles, problems, call, start, wait, close: async () => { await service.dispose(); await endpoint.close(); await world.close(); } };
}

const failingGate = { gates: [{ id: 'always-fails', type: 'command', command: [process.execPath, '-e', 'process.exit(1)'], timeoutSeconds: 60 }] };

test('heads: a role\'s agent when no provider is given; changes "optional" is accepted with nothing changed and runs no gates; "required" still refuses', () => withSecrets(async () => {
  const f = await headWorld(async helper => {
    const first = await helper.call('hydra_done', { summary: 'Every claim checks out.' });
    if (helper.spec.provider === 'claude') {
      // A required-changes role (the builder, on Claude) must change something first.
      assert.equal(first.result.accepted, false); assert.match(first.result.message, /You have not changed anything yet/);
      await helper.commit('src/b.ts', 'export const b = 2;\n');
      const checked = await helper.call('hydra_done', { summary: 'Added b.' });
      assert.equal(checked.result.accepted, false); assert.match(checked.result.message, /always-fails/);
    } else assert.equal(first.result.accepted, true, first.result.message);
    helper.exit(0);
  }, { gates: failingGate });
  try {
    const checker = await f.start('check', { role: 'checker' });
    assert.equal(checker.ok, true, checker.error);
    assert.equal(checker.result.provider, 'codex', 'the role\'s agent'); assert.equal(checker.result.role, 'kit/checker');
    const [checked] = (await f.wait([checker.result.job_id])).heads;
    assert.equal(checked.state, 'done'); assert.equal(checked.summary, 'Every claim checks out.');
    assert.deepEqual(checked.changed_files, []); assert.deepEqual(checked.checks, [], 'nothing to check, so no gate ran');
    assert.equal(checked.role, 'kit/checker'); assert.equal(checked.role_title, 'Checker');
    const codexRun = f.runs.find(run => run.provider === 'codex')!;
    assert.equal(codexRun.role!.webSearch, 'live'); assert.ok(codexRun.role!.codexConfig.some(pair => pair.startsWith('mcp_servers.kit-lookup.command=')));
    assert.deepEqual(codexRun.role!.env, { LOOKUP_KEY: secrets.MY_LOOKUP_KEY });
    assert.match(codexRun.prompt, /\n\nYour role: Checker \(Kit pack\)\nCheck every claim\./);

    const builder = await f.start('build', { role: 'builder', provider: 'claude' });
    const [built] = (await f.wait([builder.result.job_id])).heads;
    assert.equal(built.state, 'failed', 'a required-changes head is checked as usual: its failing gate sent it back, and it stopped');
    const claudeRun = f.runs.find(run => run.provider === 'claude')!;
    assert.deepEqual(claudeRun.role!.allowedTools, ['Skill', 'mcp__kit-local']);
    assert.equal(claudeRun.model, 'opus', 'decision 4: the role\'s model on its own agent');
    assert.deepEqual(f.problems, []);
  } finally { await f.close(); }
}));

test('heads: the role\'s --mcp-config file holds only references, and is removed when the head ends; an unknown role is refused; a role that went away fails the head before it starts', async () => {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const f = await headWorld(async helper => {
    if (helper.spec.prompt.includes('): Job first')) await released;
    await helper.commit(`src/${helper.spec.prompt.includes('): Job first') ? 'first' : 'other'}.ts`, 'x\n');
    const done = await helper.call('hydra_done', { summary: 'Done.' });
    assert.equal(done.result.accepted, true, done.result.message);
    helper.exit(0);
  });
  await withSecrets(async () => {
    try {
      const refused = await f.start('nope', { role: 'nope' });
      assert.equal(refused.ok, false); assert.match(refused.error!, /There's no active role "nope". Active roles: builder, checker\./);
      const roles = await f.call('hydra_active_roles');
      assert.deepEqual(roles.result.roles.map((role: { name: string }) => role.name), ['builder', 'checker']);

      const first = await f.start('first', { role: 'builder' });
      assert.equal(first.result.provider, 'claude');
      assert.equal((await f.call('hydra_get_head', { job_id: first.result.job_id })).result.role, 'kit/builder');
      // A second builder waits for the first; the pack is turned off before it starts.
      const second = await f.start('second', { role: 'builder', depends_on: [first.result.job_id] });
      assert.equal(second.ok, true, second.error);
      await f.packs.setEnabled(f.repo, 'kit', false);
      for (let tries = 0; tries < 500 && !f.mcpFiles[0]?.exists; tries++) await new Promise(resolve => setTimeout(resolve, 20));
      release();
      const heads = (await f.wait([first.result.job_id, second.result.job_id])).heads;
      assert.equal(heads[0].state, 'done');
      assert.equal(heads[1].state, 'failed');
      assert.equal(heads[1].reason, 'Could not start: the role kit/builder isn\'t available (the Kit pack is off).');
      assert.equal(f.runs.length, 1, 'the second head never started a process');

      const [file] = f.mcpFiles;
      assert.ok(file?.exists, 'the file was there while the head ran');
      assert.equal(file!.file, path.join(f.root, 'logs', `${first.result.job_id}.mcp.json`));
      assert.deepEqual(Object.keys(JSON.parse(file!.text).mcpServers), ['kit-local']);
      assert.match(file!.text, /\$\{KIT_TOKEN\}/); assert.doesNotMatch(file!.text, /secret-/, 'references only, never values');
      for (let tries = 0; tries < 100 && await access(file!.file).then(() => true, () => false); tries++) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await access(file!.file).then(() => true, () => false), false, 'removed when the head ended');
      assert.deepEqual(f.problems, []);
    } finally { await f.close(); }
  });
});

test('heads without packs: a role is refused, and nothing else changes', async () => {
  const f = await headWorld(async helper => { await helper.commit('src/c.ts', 'c\n'); await helper.call('hydra_done', { summary: 'c' }); helper.exit(0); }, { noPacks: true });
  try {
    const refused = await f.start('r', { role: 'builder' });
    assert.match(refused.error!, /packs aren't available in this Hydra window/);
    assert.deepEqual((await f.call('hydra_active_roles')).result, { roles: [] });
    const plain = await f.start('plain');
    await f.wait([plain.result.job_id]);
    assert.equal(f.runs[0]!.role, undefined); assert.equal(f.runs[0]!.provider, 'claude');
    // A plan head: the job's provider, then the role's, then hydra.defaultProvider.
    const planned = await f.service.startForPlan({ title: 'P', brief: 'B', write_scope: ['src/'], idempotency_key: 'plan-x' }, 'plan-abc', [], 'codex') as { provider: string };
    assert.equal(planned.provider, 'codex');
  } finally { await f.close(); }
});

// ---- The lead hears of the roles ----

test('the lead\'s bridge asks for the active roles when it starts: its instructions list them, and hydra_start_head\'s role is their enum', async () => {
  const roles = [{ name: 'builder', title: 'Builder', packTitle: 'Coding', description: 'Builds a feature with tests.', provider: 'claude' as const }, { name: 'reviewer', title: 'Reviewer', packTitle: 'Coding', description: 'Reads the diff.', provider: 'codex' as const }];
  assert.equal(rolesGuidance([]), undefined);
  assert.match(rolesGuidance(roles)!, /^Roles from this project's packs: pass one as `role` to hydra_start_head[^\n]*\n- builder: Builder \(Coding pack, Claude\)\. Builds a feature with tests\.\n- reviewer: Reviewer \(Coding pack, Codex\)\. Reads the diff\.$/);
  const plain = leadToolsWithRoles([]).find(tool => tool.name === 'hydra_start_head')!;
  assert.equal('role' in (plain.inputSchema as { properties: object }).properties, false, 'no roles: no role parameter');
  assert.ok(!leadToolsWithRoles([]).some(tool => tool.name === 'hydra_active_roles'), 'the lookup is never listed');
  const withRoles = leadToolsWithRoles(roles).find(tool => tool.name === 'hydra_start_head')!;
  assert.deepEqual(((withRoles.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties.role)!.enum, ['builder', 'reviewer']);

  const root = await mkdtemp(path.join(tmpdir(), 'hydra-roles-bridge-'));
  const repo = path.join(root, 'repo'); await mkdir(repo, { recursive: true });
  const window = new HelperEndpoint(async (_caller, tool) => tool === 'hydra_active_roles' ? { roles: [...roles, { name: 'Bad Name', title: 'x', packTitle: 'y', description: 'z', provider: 'claude' }] } : { tool }, { leadKey: 'A', verifyLead: async () => ({ ok: true }) });
  const port = await window.start();
  try {
    await writeWindowRecord(root, { port, pid: process.pid, folders: [repo] });
    const lead = createBridge({ env: { HYDRA_HELPERS_DIR: root }, cwd: repo, version: 'test' });
    const init = await lead.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as { result: { instructions: string } };
    assert.match(init.result.instructions, /hydra_start_head[\s\S]*Roles from this project's packs[\s\S]*- reviewer: Reviewer \(Coding pack, Codex\)/);
    assert.doesNotMatch(init.result.instructions, /Bad Name/, 'a malformed role from the window is dropped');
    const listed = await lead.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as { result: { tools: { name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }[] } };
    assert.deepEqual(listed.result.tools.find(tool => tool.name === 'hydra_start_head')!.inputSchema.properties.role!.enum, ['builder', 'reviewer']);
    assert.ok(!listed.result.tools.some(tool => tool.name === 'hydra_active_roles'));
    const hidden = await lead.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'hydra_active_roles', arguments: {} } }) as { result: { isError?: boolean } };
    assert.equal(hidden.result.isError, true, 'the model can\'t call the lookup');
    const lost = createBridge({ env: { HYDRA_HELPERS_DIR: root }, cwd: path.join(root, 'elsewhere'), version: 'test' });
    const alone = await lost.handle({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }) as { result: { instructions: string } };
    assert.doesNotMatch(alone.result.instructions, /Roles from/, 'no window, no roles, and the bridge still starts');
  } finally { await window.close(); await rm(root, { recursive: true, force: true }); }
});

// ---- Lanes ----

const laneBase = (role: RoleLaunch | undefined, extra: Partial<Parameters<typeof laneLaunch>[0]> = {}): Parameters<typeof laneLaunch>[0] => ({
  lane: { id: 'abcdefabcdef', name: 'Lane 1', branch: 'lane/lane-1-abcdefabcdef', provider: 'claude' }, executable: 'C:\\bin\\claude.exe', resume: false, connected: true,
  bridge: { command: 'C:\\Hydra\\Hydra.exe', args: ['C:\\Hydra\\hydra-mcp.cjs'], env: { HYDRA_HELPERS_DIR: 'C:\\h' } }, mcpConfigFile: 'C:\\s\\lane.mcp.json', helpersDir: 'C:\\h',
  env: { PATH: 'C:\\bin', ...secrets }, platform: 'win32', ...(role ? { role } : {}), ...extra,
});

test('laneLaunch: Claude gets the role\'s flags on every launch, and a --mcp-config file with its servers even when connected', async () => {
  const world = await packWorld();
  try {
    const builder = roleLaunch(await world.packs.resolve(world.repo, 'kit/builder'), { provider: 'claude', target: 'lane', env: secrets });
    const roleArgs = ['--append-system-prompt-file', builder.systemPromptFile!, '--plugin-dir', builder.pluginDir!, '--model', 'opus'];
    const fresh = laneLaunch(laneBase(builder, { prompt: 'Go' }));
    assert.deepEqual(fresh.args, [...roleArgs, '--mcp-config', 'C:\\s\\lane.mcp.json', 'Go']);
    assert.deepEqual(Object.keys(JSON.parse(fresh.mcpConfig!).mcpServers), ['kit-local'], 'connected: only the role\'s servers; Claude\'s own Hydra entry serves the lane');
    assert.doesNotMatch(fresh.mcpConfig!, /secret-/);
    assert.deepEqual(laneLaunch(laneBase(builder, { resume: true })).args, ['--continue', ...roleArgs, '--mcp-config', 'C:\\s\\lane.mcp.json'], 'Resume passes them again');
    const alone = laneLaunch(laneBase(builder, { connected: false }));
    assert.deepEqual(Object.keys(JSON.parse(alone.mcpConfig!).mcpServers), ['hydra', 'kit-local']);
    const noServers: RoleLaunch = { ...builder, mcpServers: {} };
    assert.equal(laneLaunch(laneBase(noServers)).mcpConfig, undefined, 'connected and no role servers: no file, as before');
    assert.deepEqual(laneLaunch(laneBase(undefined)).args, [], 'no role: nothing added');
  } finally { await world.close(); }
});

test('laneLaunch: Codex gets the role\'s -c servers every time, and developer instructions (one shim-safe line) only on a fresh thread', async () => {
  const world = await packWorld();
  try {
    const checker = roleLaunch(await world.packs.resolve(world.repo, 'kit/checker'), { provider: 'codex', target: 'lane', env: secrets });
    const codexLane = { id: 'abcdefabcdef', name: 'Lane 1', branch: 'lane/lane-1-abcdefabcdef', provider: 'codex' as const };
    const shim = laneLaunch(laneBase(checker, { lane: codexLane, executable: 'C:\\npm\\codex.cmd', prompt: 'Check the "facts" & more' }));
    const developer = shim.args[shim.args.indexOf("mcp_servers.kit-remote.default_tools_approval_mode='approve'") + 2]!;
    const apostrophe = String.fromCharCode(0x2019);
    assert.equal(developer, `developer_instructions='Check every claim. Don${apostrophe}t fix what you can${apostrophe}t source.'`, 'straight quotes become typographic ones: one TOML literal');
    assert.ok(shim.args.includes("mcp_servers.kit-lookup.env_vars=['LOOKUP_KEY']"));
    assert.equal(shim.args.at(-1), 'Check the \'facts\' more');
    assert.equal(shim.env.LOOKUP_KEY, secrets.MY_LOOKUP_KEY, 'the variable is in Codex\'s own environment');
    assert.doesNotMatch(shim.args.join(' '), /secret-|"/);
    const resumed = laneLaunch(laneBase(checker, { lane: codexLane, executable: 'C:\\bin\\codex.exe', resume: true }));
    assert.deepEqual(resumed.args.slice(-2), ['resume', '--last']);
    assert.ok(resumed.args.some(arg => arg.startsWith('mcp_servers.kit-lookup.command=')), 'servers on resume too');
    assert.ok(!resumed.args.some(arg => arg.startsWith('developer_instructions=')), 'a resumed thread keeps the instructions it started with (R2)');
    assert.ok(!laneLaunch(laneBase(undefined, { lane: codexLane, executable: 'C:\\bin\\codex.exe' })).args.some(arg => arg.startsWith('developer_instructions=') || arg.startsWith('mcp_servers.kit-')));

    // The instructions as developer instructions, and when they can't pass.
    assert.equal(codexDeveloperInstructions('A\n\n"B" 100% & C | D', true), `A ${apostrophe}B${apostrophe} 100 C D`);
    assert.equal(codexDeveloperInstructions('x'.repeat(developerInstructionsMax + 1), false), undefined);
    const long: RoleLaunch = { ...checker, text: 'y'.repeat(3000) };
    const pointer = roleFirstPrompt(long, 500);
    assert.match(pointer, /^Read your role's instructions in .*checker\.md before you start, and follow them\.$/);
    assert.equal(roleFirstPrompt(checker, 500), `Your role's instructions: ${checker.text.replace(/\s+/g, ' ').trim()}`);
  } finally { await world.close(); }
});

test('lanePreamble: "Your role" after its first sentence; one line under the cap even with a plan, a long goal and a role in the prompt', () => {
  const plain = lanePreamble({ name: 'Lane 1', branch: 'lane/x', goal: 'Review the cart.' }, []);
  const withRole = lanePreamble({ name: 'Lane 1', branch: 'lane/x', goal: 'Review the cart.', promptRole: { label: 'Reviewer (Coding pack)' } }, []);
  assert.equal(withRole, plain.replace('on branch lane/x.', 'on branch lane/x. Your role: Reviewer (Coding pack).'));
  const crowded = Array.from({ length: 20 }, (_, index) => ({ name: `Lane ${index}`, provider: 'codex' as const, goal: 'g'.repeat(500), files: Array.from({ length: 50 }, (_, file) => `src/${'deep/'.repeat(30)}file-${file}.ts`) }));
  const plan = { planId: 'abcdefabcdef', jobKey: 'k', planTitle: 'P'.repeat(200), jobTitle: 'J'.repeat(80), writeScope: Array.from({ length: 32 }, () => 'x'.repeat(300)) };
  const role = { label: 'Checker (Kit pack)', text: (max: number) => roleFirstPrompt({ text: 'z '.repeat(4000), instructionsFile: 'C:\\cache\\kit\\roles\\checker.md', skills: [] }, max) };
  const full = lanePreamble({ name: 'Lane 1', branch: 'lane/x', goal: 'G'.repeat(1500), plan, promptRole: role }, crowded);
  assert.ok(full.length <= lanePreambleMax, String(full.length)); assert.doesNotMatch(full, /[\r\n]/);
  assert.match(full, /Your role: Checker \(Kit pack\)\. Read your role's instructions in C:\\cache\\kit\\roles\\checker\.md before you start/);
  assert.match(full, /Your task: G+$/, 'the task survives');
  const waiting = laneRolePrompt({ label: 'Checker (Kit pack)', text: max => roleFirstPrompt({ text: 'Check it.', instructionsFile: 'f', skills: [] }, max) });
  assert.equal(waiting, 'Your role: Checker (Kit pack). Your role\'s instructions: Check it. Wait for the user\'s first request.');
});

test('lanes: the record, the form, hydra.lanes.start and plan jobs name a role as pack/role', () => {
  assert.deepEqual(parseLaneInput({ name: 'L', provider: 'codex', role: 'coding/reviewer' }).role, { pack: 'coding', role: 'reviewer' });
  assert.equal(parseLaneInput({ name: 'L', provider: 'codex', role: '' }).role, undefined);
  for (const role of ['reviewer', 'a/b/c', 'Coding/Reviewer', 7]) assert.throws(() => parseLaneInput({ name: 'L', provider: 'codex', role }), /Name the lane's role with its pack/);
  assert.deepEqual(parseLaneMessage({ type: 'laneNew', name: 'L', provider: 'codex', role: 'coding/reviewer' }, 'laneNew'), { type: 'laneNew', name: 'L', provider: 'codex', role: 'coding/reviewer' });
  assert.throws(() => parseLaneMessage({ type: 'laneNew', name: 'L', provider: 'codex', role: 'reviewer' }, 'laneNew'), /Invalid lane role/);
  const id = 'abcdefabcdef';
  const lane: Lane = { id, name: 'L', provider: 'codex', repository: path.resolve('/repo'), worktree: path.resolve('/wt', `lane-${id}`), branch: `lane/l-${id}`, baseCommit: 'a'.repeat(40), target: 'main', createdAt: new Date(0).toISOString(), state: 'running', role: { pack: 'coding', role: 'reviewer' } };
  assert.deepEqual(validateLane(lane).role, { pack: 'coding', role: 'reviewer' });
  assert.throws(() => validateLane({ ...lane, role: { pack: 'coding' } }), /invalid role/);
  assert.throws(() => validateLane({ ...lane, role: 'coding/reviewer' }), /invalid role/);
  const job = { key: 'a', title: 'A', brief: 'B', dependsOn: [] };
  validatePlanJobs([{ ...job, role: 'coding/builder' }]);
  assert.throws(() => validatePlanJobs([{ ...job, role: 'builder' }]), /names its role as "pack\/role"/);
});

test('lane service: a role reaches every launch; a Codex role that can\'t pass goes in the first prompt; a role that is gone leaves a note and the lane runs without it', async () => {
  const longRole = { id: 'long', title: 'Long', description: 'Long instructions.', provider: 'codex', instructions: 'roles/long.md', skills: ['test-first'] };
  const world = await packWorld({ manifest: kit([longRole]), extra: { 'roles/long.md': `${'Check the work carefully. '.repeat(200)}\n` } });
  const store = new LaneStore(path.join(world.root, 'lanes')); await store.load();
  const pty = fakePtyModule();
  const service = new LaneService({
    store, repository: world.repo, worktreeRoot: () => path.join(world.root, 'worktrees'), pty,
    executable: async provider => `C:\\bin\\${provider}.exe`, connected: async () => true,
    bridge: provider => ({ command: 'hydra.exe', args: ['hydra-mcp.cjs'], env: { HYDRA_LEAD_PROVIDER: provider } }),
    helpersDir: path.join(world.root, 'helpers'), configDirectory: path.join(world.root, 'lanes', 'cfg'), syncIntervalMs: 60_000,
    env: () => ({ PATH: 'x', ...secrets }), roles: world.packs,
  });
  try {
    const claude = await service.create({ name: 'Build', provider: 'claude', role: 'kit/builder', goal: 'Build the cart.' });
    const claudeArgs = pty.spawned[0]!.args;
    assert.ok(claudeArgs.includes('--append-system-prompt-file') && claudeArgs.includes('--plugin-dir'));
    assert.match(claudeArgs.at(-1)!, /on branch [^ ]+\. Your role: Builder \(Kit pack\)\./);
    const file = path.join(world.root, 'lanes', 'cfg', `${claude.id}.mcp.json`);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8')).mcpServers), ['kit-local']);
    await pty.spawned[0]!.exit(0); await new Promise(resolve => setTimeout(resolve, 20));
    await service.resume(claude.id);
    assert.equal(pty.spawned[1]!.args[0], '--continue'); assert.ok(pty.spawned[1]!.args.includes('--append-system-prompt-file'), 'Resume resolves the role again');

    const long = await service.create({ name: 'Long', provider: 'codex', role: 'kit/long' });
    const longArgs = pty.spawned[2]!.args;
    assert.ok(!longArgs.some(arg => arg.startsWith('developer_instructions=')), 'too long for one argument');
    assert.match(longArgs.at(-1)!, /^Your role: Long \(Kit pack\)\. Read your role's instructions in .*long\.md before you start, and follow them\. Skills you can use.*test-first \(.*SKILL\.md\)\. Wait for the user's first request\.$/);

    const short = await service.create({ name: 'Check', provider: 'codex', role: 'kit/checker' });
    const shortArgs = pty.spawned[3]!.args;
    assert.ok(shortArgs.some(arg => arg.startsWith('developer_instructions=')));
    assert.ok(!shortArgs.at(-1)!.startsWith('Your role'), 'no goal and instructions that pass: no first prompt, as before');
    assert.equal(pty.spawned[3]!.options?.env?.LOOKUP_KEY, secrets.MY_LOOKUP_KEY);

    const ghost = await service.create({ name: 'Ghost', provider: 'codex', role: 'kit/ghost' });
    assert.equal(service.views().find(view => view.id === ghost.id)!.roleNote, 'Role ghost isn\'t available: the Kit pack has no role "ghost".');
    assert.ok(!pty.spawned[4]!.args.some(arg => arg.startsWith('developer_instructions=') || arg.startsWith('mcp_servers.kit-')));
    const described = await service.describe() as { lanes: { id: string; role?: string; roleNote?: string }[] };
    assert.equal(described.lanes.find(lane => lane.id === claude.id)!.role, 'kit/builder');
    assert.match(described.lanes.find(lane => lane.id === ghost.id)!.roleNote!, /isn't available/);
    assert.equal(service.views().find(view => view.id === claude.id)!.roleNote, undefined);
  } finally { await service.dispose(); await world.close(); }
});

// ---- Review gates with a web role (R9) ----

test('a pack review gate whose role has "web" marks its reviewer for the web; others don\'t', () => {
  const manifest = kit();
  const pack = { id: 'kit', title: 'Kit', state: 'on' as const, copy: 'C:\\cache\\kit', notes: [], entry: { id: 'kit' }, pack: { id: 'kit', source: 'builtin' as const, folder: 'x', valid: { manifest: { ...manifest, gates: [
    { id: 'web-review', type: 'review' as const, reviewer: 'other' as const, focus: 'f', required: true, role: 'checker' },
    { id: 'plain-review', type: 'review' as const, reviewer: 'other' as const, focus: 'f', required: true, role: 'builder' },
  ], roles: (manifest.roles as Record<string, unknown>[]).map(role => ({ skills: [], mcpServers: [], tools: [], changes: 'required', ...role })) } as never, skills: [], instructions: { checker: 'Check.', builder: 'Build.' }, servers: {} } } };
  const gates = combineGates({ source: 'none', lanes: 'onMerge', gates: [] }, [pack as never], hydraExe).gates as { id: string; reviewerRole?: { web?: boolean } }[];
  assert.equal(gates.find(gate => gate.id === 'web-review')!.reviewerRole!.web, true);
  assert.equal(gates.find(gate => gate.id === 'plain-review')!.reviewerRole!.web, undefined);
});

test('on Windows a bare command such as npx starts through cmd.exe; an absolute one starts as it is; cmd syntax leaves the server out', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const cmd = 'C:\\Windows\\System32\\cmd.exe';
  assert.deepEqual(serverCommand(['npx', '-y', '@playwright/mcp@0.0.82', '--headless'], 'win32', env), { command: cmd, args: ['/d', '/c', 'npx', '-y', '@playwright/mcp@0.0.82', '--headless'] });
  assert.deepEqual(serverCommand(['pnpm.cmd', 'dlx', 'x'], 'win32', env), { command: cmd, args: ['/d', '/c', 'pnpm.cmd', 'dlx', 'x'] });
  const hydra = 'C:\\Hydra\\Hydra.exe', script = 'C:\\cache\\server.mjs';
  assert.deepEqual(serverCommand([hydra, script], 'win32', env), { command: hydra, args: [script] }, '{node} and full paths start as they are');
  assert.deepEqual(serverCommand(['uvx.exe', 'x'], 'win32', env), { command: 'uvx.exe', args: ['x'] });
  assert.deepEqual(serverCommand(['npx', '-y', 'x'], 'linux', env), { command: 'npx', args: ['-y', 'x'] });
  assert.match((serverCommand(['npx', 'a&calc'], 'win32', env) as { skip: string }).skip, /cmd\.exe/);
});
