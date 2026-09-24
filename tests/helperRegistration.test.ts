import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addClaudeAllowRule, addCodexBlock, claudeAllowRule, claudeStatus, codexStatus, connectCodex, disconnectCodex, providerPaths, removeClaudeAllowRule, removeCodexBlock, type HelperServerSpec } from '../src/core/helperRegistration';

const spec: HelperServerSpec = { command: 'C:\\Program Files\\Hydra\\Hydra.exe', args: ['C:\\Program Files\\Hydra\\resources\\app\\extensions\\hydra\\dist\\hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', HYDRA_HELPERS_DIR: 'C:\\Users\\n\\AppData\\Roaming\\Hydra\\helpers' } };

test('connecting then disconnecting Codex leaves config.toml byte-identical (LF, CRLF, no trailing newline, empty)', () => {
  const samples = [
    'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\nstartup_timeout_sec = 120\n',
    'model = "gpt-5"\r\n[shell_environment_policy]\r\ninherit = "core"\r\n',
    'model = "gpt-5"',
    '',
  ];
  for (const original of samples) {
    const connected = addCodexBlock(original, spec);
    assert.ok(connected.startsWith(original), 'the user\'s text is untouched, Hydra only appends');
    assert.match(connected, /\[mcp_servers\.hydra\]/); assert.match(connected, /tool_timeout_sec = 3600/);
    assert.match(connected, /default_tools_approval_mode = 'approve'/);
    assert.ok(!connected.slice(original.length).includes('"'), 'only literal strings');
    if (original.includes('\r\n')) assert.ok(!/[^\r]\n/.test(connected.slice(original.length)), 'a CRLF file gets CRLF lines');
    assert.equal(addCodexBlock(connected, spec), connected, 'connecting twice changes nothing');
    const removed = removeCodexBlock(connected);
    assert.equal(removed.had, true); assert.equal(removed.text, original);
  }
  assert.throws(() => addCodexBlock('[mcp_servers.hydra]\ncommand = "mine"\n', spec), /didn't add/);
  assert.throws(() => addCodexBlock("x = 1\n", { ...spec, command: "C:\\it's\\Hydra.exe" }), /quote/);
});

test('Codex connection status and file round trip', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-registration-'));
  try {
    const file = path.join(directory, 'config.toml');
    const original = 'model = "gpt-5"\r\n\r\n[features]\r\nweb = true\r\n';
    await writeFile(file, original);
    assert.deepEqual(await codexStatus(file, spec), { provider: 'codex', connected: false, current: false });
    await connectCodex(file, spec);
    assert.deepEqual(await codexStatus(file, spec), { provider: 'codex', connected: true, current: true });
    assert.equal((await codexStatus(file, { ...spec, command: 'C:\\New\\Hydra.exe' })).current, false, 'an updated Hydra path is noticed');
    await connectCodex(file, { ...spec, command: 'C:\\New\\Hydra.exe' });
    assert.equal((await codexStatus(file, { ...spec, command: 'C:\\New\\Hydra.exe' })).current, true);
    await disconnectCodex(file);
    assert.equal(await readFile(file, 'utf8'), original);
    await disconnectCodex(path.join(directory, 'missing.toml'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the Claude allow rule is inserted and removed without reformatting settings.json', () => {
  const samples = [
    '{\n  "permissions": {\n    "allow": [\n      "Bash(npm test)"\n    ],\n    "deny": []\n  },\n  "model": "opus"\n}\n',
    '{\r\n    "permissions": {\r\n        "allow": [\r\n            "Read"\r\n        ]\r\n    }\r\n}\r\n',
    '{\n  "permissions": {\n    "allow": []\n  }\n}\n',
  ];
  for (const original of samples) {
    const added = addClaudeAllowRule(original);
    assert.deepEqual(JSON.parse(added).permissions.allow.includes(claudeAllowRule), true);
    assert.equal(addClaudeAllowRule(added), added, 'adding twice changes nothing');
    assert.equal(removeClaudeAllowRule(added), original, 'removal restores the exact bytes');
  }
  assert.deepEqual(JSON.parse(addClaudeAllowRule(undefined)), { permissions: { allow: [claudeAllowRule] } });
  assert.deepEqual(JSON.parse(addClaudeAllowRule('{ "model": "opus" }')), { model: 'opus', permissions: { allow: [claudeAllowRule] } });
  assert.equal(removeClaudeAllowRule('{ "model": "opus" }'), '{ "model": "opus" }');
});

test('Claude connection status reads the user-level server entry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-registration-'));
  try {
    const paths = providerPaths({ CLAUDE_CONFIG_DIR: directory });
    assert.equal(paths.claudeJson, path.join(directory, '.claude.json'));
    assert.equal((await claudeStatus(paths, spec)).connected, false);
    await writeFile(paths.claudeJson, JSON.stringify({ mcpServers: { hydra: { type: 'stdio', command: spec.command, args: spec.args, env: spec.env } } }));
    assert.deepEqual(await claudeStatus(paths, spec), { provider: 'claude', connected: true, current: true });
    assert.equal((await claudeStatus(paths, { ...spec, args: ['other.cjs'] })).current, false);
    await writeFile(paths.claudeJson, '{ broken');
    assert.ok((await claudeStatus(paths, spec)).error);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('onboarding and Settings connect Claude Code and Codex to Hydra; Settings no longer offers Auto', async () => {
  const [onboarding, settings, view] = await Promise.all(['src/extensionOnboarding.ts', 'src/extensionSettings.ts', 'src/helperConnectionsView.ts'].map(file => readFile(file, 'utf8'))) as [string, string, string];
  for (const page of [onboarding, settings]) { assert.match(page, /connectionsSection\(/); assert.match(page, /handleConnectionsMessage\(/); }
  assert.match(onboarding, /Connect Claude Code and Codex\./);
  assert.doesNotMatch(settings, /data-delegation|Agent delegation/);
  assert.match(view, /keep their own sign-in and billing/);
  assert.match(view, /never inside a project/);
});

test('extensions install straight from Open VSX when the editor has no gallery', async () => {
  const { downloadOpenVsx, openVsxTarget } = await import('../src/core/openVsx');
  assert.equal(openVsxTarget('win32', 'x64'), 'win32-x64'); assert.equal(openVsxTarget('darwin', 'arm64'), 'darwin-arm64');
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-openvsx-'));
  try {
    const asked: string[] = [];
    const fake = (async (url: string) => {
      asked.push(url);
      if (url.includes('/api/')) return { ok: true, json: async () => ({ files: { download: 'https://open-vsx.org/file.vsix' } }) };
      return { ok: true, arrayBuffer: async () => new TextEncoder().encode('vsix-bytes').buffer };
    }) as unknown as typeof fetch;
    const vsix = await downloadOpenVsx('anthropic.claude-code', fake, directory);
    assert.equal(await readFile(vsix, 'utf8'), 'vsix-bytes');
    assert.match(asked[0]!, /open-vsx\.org\/api\/anthropic\/claude-code\/[a-z0-9]+-(x64|arm64)\/latest/);
    const missing = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
    await assert.rejects(downloadOpenVsx('openai.chatgpt', missing, directory), /not found on Open VSX/);
    await assert.rejects(downloadOpenVsx('../evil', fake, directory), /Invalid extension id/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('claude-mem counts as set up only with its plugin installed', async () => {
  const { claudeMemStatus, claudeMemPlugin } = await import('../src/core/claudeMem');
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-claudemem-'));
  try {
    assert.equal((await claudeMemStatus(directory)).plugin, false);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(directory, 'plugins'), { recursive: true });
    await writeFile(path.join(directory, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [claudeMemPlugin]: [{ scope: 'user' }] } }));
    assert.equal((await claudeMemStatus(directory)).plugin, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('one Connect button installs, connects, and sets up claude-mem', async () => {
  const view = await readFile('src/helperConnectionsView.ts', 'utf8');
  assert.doesNotMatch(view, /data-install|Install extension/);
  assert.match(view, /data-connect=/); assert.match(view, /claude-mem/);
  const extension = await readFile('src/extension.ts', 'utf8');
  assert.match(extension, /await this\.installProviderExtension\(provider\);/);
  assert.match(extension, /downloadOpenVsx\(id\)/);
  assert.match(extension, /setupClaudeMem\(claude\)/);
});
