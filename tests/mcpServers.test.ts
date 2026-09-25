import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { addCodexBlock, type HelperServerSpec } from '../src/core/helperRegistration';
import {
  addCodexServer, addMcpServer, claudeAddJsonArgs, codexServerBlock, configuredSpec, enableMcpServerFor, hydraCodexBlocks, listMcpServers,
  looksLikeSecret, maskSecret, maskSpec, mergeEnv, parseToml, readClaudeServers, readCodexServers, removeCodexServer, removeMcpServer,
  resolveCommand, testMcpServer, tomlString, validateServerName, validateServerSpec, type McpContext, type McpServerSpec,
} from '../src/core/mcpServers';

// Git may check fixtures out with CRLF; every variant below is derived from the LF text.
const fixture = async (name: string) => (await readFile(path.resolve('tests/fixtures/mcp', name), 'utf8')).replace(/\r\n/g, '\n');
const variants = (lf: string): [string, string][] => [
  ['LF', lf], ['CRLF', lf.replace(/\n/g, '\r\n')], ['no trailing newline', lf.replace(/\n+$/, '')], ['CRLF, no trailing newline', lf.replace(/\n+$/, '').replace(/\n/g, '\r\n')],
];
const stdio: McpServerSpec = { type: 'stdio', command: 'C:\\Tools\\my "server".exe', args: ['--root', 'C:\\work\\ünï', 'line\nbreak', "it's"], env: { API_TOKEN: 'secret "value" \\ with\ttab', PLAIN: 'Ω' } };
const http: McpServerSpec = { type: 'http', url: 'https://mcp.example.com/mcp?x=1', headers: { Authorization: 'Bearer abc"def\\ghi', 'X-Region': 'eu' }, bearerTokenEnvVar: 'EXAMPLE_TOKEN' };
const helperSpec: HelperServerSpec = { command: 'C:\\Program Files\\Hydra\\Hydra.exe', args: ['C:\\hydra-mcp.cjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };

test('add then remove leaves every config.toml fixture byte-identical', async () => {
  const bases = [
    ['user servers', await fixture('user-servers.toml')], ['Hydra blocks', await fixture('hydra-blocks.toml')],
    ['helper block last', addCodexBlock('model = "gpt-5"\n', helperSpec)], ['empty', ''], ['only a comment', '# nothing yet\n'],
  ] as const;
  for (const [label, lf] of bases) {
    for (const [ending, original] of label === 'empty' ? [['empty', ''] as [string, string]] : variants(lf)) {
      const what = `${label} / ${ending}`;
      const one = addCodexServer(original, 'alpha', stdio);
      assert.ok(one.startsWith(original), `${what}: Hydra only appends`);
      if (original.includes('\r\n')) assert.ok(!/[^\r]\n/.test(one.slice(original.length)), `${what}: CRLF file gets CRLF lines`);
      else assert.ok(!one.slice(original.length).includes('\r'), `${what}: LF file gets LF lines`);
      const two = addCodexServer(one, 'beta', http);
      const parsed = readCodexServers(two, 'config.toml');
      assert.deepEqual(parsed.get('alpha')?.spec, stdio, `${what}: reads back exactly`);
      assert.deepEqual(parsed.get('beta')?.spec, http, `${what}: reads back exactly`);
      assert.equal(parsed.get('alpha')?.managedByHydra, true);
      // Either order of removal restores the file exactly.
      assert.equal(removeCodexServer(removeCodexServer(two, 'alpha').text, 'beta').text, original, `${what}: alpha then beta`);
      assert.equal(removeCodexServer(removeCodexServer(two, 'beta').text, 'alpha').text, original, `${what}: beta then alpha`);
      assert.equal(removeCodexServer(two, 'beta').text, one, `${what}: removing the last add undoes just it`);
      assert.deepEqual(removeCodexServer(original, 'alpha'), { text: original, had: false }, `${what}: removing nothing is a no-op`);
    }
  }
});

test('a block survives the user appending after it, and is cut out without touching their lines', () => {
  const original = 'model = "gpt-5"\r\n';
  const added = addCodexServer(original, 'alpha', stdio) + '\r\n[profiles.x]\r\nmodel = "o3"\r\n';
  assert.equal(removeCodexServer(added, 'alpha').text, original + '\r\n[profiles.x]\r\nmodel = "o3"\r\n');
  assert.deepEqual(hydraCodexBlocks(added), ['alpha']);
  assert.throws(() => removeCodexServer(added.replace('# <<< Hydra MCP: alpha', '# <<< gone'), 'alpha'), /damaged/);
});

test('servers Hydra didn\'t add to Codex are never touched', async () => {
  const text = await fixture('user-servers.toml');
  assert.throws(() => addCodexServer(text, 'github', stdio), /didn't add/);
  assert.throws(() => addCodexServer(text, 'figma', http), /didn't add/);
  assert.throws(() => removeCodexServer(text, 'github'), /didn't add "github"/);
  const blocks = await fixture('hydra-blocks.toml');
  assert.throws(() => addCodexServer(blocks, 'context7', stdio), /already set up for Codex/);
  assert.throws(() => addCodexServer(blocks, 'mine', stdio), /didn't add/);
  assert.throws(() => removeCodexServer(blocks, 'mine'), /didn't add/);
  // An unreadable config is never written, and neither is one Hydra's table can't be added to.
  assert.throws(() => addCodexServer('model = "unterminated\n', 'alpha', stdio), /can't read your Codex config/);
  assert.throws(() => addCodexServer('mcp_servers = { other = { command = "x" } }\n', 'alpha', stdio), /would break/);
  assert.throws(() => addCodexServer('x = 1\n', 'alpha', { type: 'sse', url: 'https://x', headers: {} }), /not SSE/);
});

test('TOML strings are escaped and read back exactly', () => {
  const samples = ['plain', 'quote " inside', 'back\\slash', 'line\nbreak\r\n', 'tab\tand\u0001control\u007f', 'ünïcødé ✓ 🐉', "single ' quote", '"""', "'''", ''];
  for (const value of samples) {
    const written = tomlString(value);
    assert.equal(parseToml(`k = ${written}\n`).k, value, JSON.stringify(value));
    assert.ok(!/[\n\r\u0000-\u0008]/.test(written), 'one line, no raw control characters');
  }
  assert.equal(tomlString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  const block = codexServerBlock('alpha', { type: 'stdio', command: 'x', args: [], env: { 'odd': 'v' } });
  assert.match(block, /^\n# >>> Hydra MCP: alpha\n/); assert.match(block, /\nargs = \[\]\n/); assert.match(block, /\n\[mcp_servers\.alpha\.env\]\nodd = "v"\n# <<< Hydra MCP: alpha\n$/);
  assert.doesNotMatch(codexServerBlock('alpha', { type: 'stdio', command: 'x', args: [], env: {} }), /\.env\]/, 'no empty env table');
});

test('the TOML reader handles the shapes in real configs and rejects broken ones', async () => {
  const parsed = parseToml(await fixture('user-servers.toml')) as any;
  assert.equal(parsed.model, 'gpt-5-codex');
  assert.deepEqual(parsed.notify, ['notify-send', 'Codex ✓']);
  assert.equal(parsed.features.limit, 1000); assert.equal(parsed.features.ratio, 0.5); assert.equal(parsed.features.started, '1979-05-27T07:32:00Z');
  assert.equal(parsed.mcp_servers.github.env['QUOTED.KEY'], 'literal \\ backslash');
  assert.deepEqual(parsed.mcp_servers['docs-ünïcode'].args, ['--name', 'Ωmega "quoted"', 'multi\nline']);
  const more = parseToml('a.b = 1\n[[arr]]\nx = 1\n[[arr]]\nx = 2\n[arr.sub]\ny = 3\ns = """\\\n   folded \\\n  text"""\nl = \'\'\'raw \\n\'\'\'\nt = { a = [1, 2,], b.c = "d" }\n') as any;
  assert.equal(more.a.b, 1); assert.equal(more.arr.length, 2); assert.equal(more.arr[1].sub.y, 3);
  assert.equal(more.arr[1].sub.s, 'folded text'); assert.equal(more.arr[1].sub.l, 'raw \\n'); assert.deepEqual(more.arr[1].sub.t, { a: [1, 2], b: { c: 'd' } });
  for (const broken of ['a = 1\na = 2\n', '[t]\n[t]\n', 'a = "x\n', 'a = 1 b = 2\n', 't = {}\n[t]\n', 'a = [1\n', 'a = 07\n', 'a = "\\q"\n', 'a = { b = 1 }\na.c = 2\n']) {
    assert.throws(() => parseToml(broken), /Line \d+/, JSON.stringify(broken));
  }
});

test('Codex list parsing: specs, extras, disabled, and who added what', async () => {
  const servers = readCodexServers(await fixture('user-servers.toml'), 'cfg');
  assert.deepEqual(servers.get('github'), {
    source: 'cfg', managedByHydra: false, removable: false, readOnlyReason: 'Added outside Hydra. Hydra never edits servers it didn\'t add to Codex\'s config.toml.', enabled: true, extras: ['startup_timeout_sec'],
    spec: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'QUOTED.KEY': 'literal \\ backslash' } },
  });
  assert.deepEqual(servers.get('figma')?.spec, { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { 'X-Figma-Region': 'us-east-1', Authorization: 'Bearer abcdefgh12345678' }, bearerTokenEnvVar: 'FIGMA_OAUTH_TOKEN' });
  assert.equal(servers.get('docs-ünïcode')?.enabled, false);
  const blocks = readCodexServers(await fixture('hydra-blocks.toml'), 'cfg');
  assert.equal(blocks.get('context7')?.managedByHydra, true); assert.equal(blocks.get('context7')?.removable, true);
  assert.equal(blocks.get('hydra')?.managedByHydra, true); assert.equal(blocks.get('hydra')?.removable, false, 'Hydra\'s own server is locked');
  assert.equal(blocks.get('mine')?.removable, false);
});

test('~/.claude.json parsing reads only user-level servers', async () => {
  const servers = readClaudeServers(await fixture('claude.json'), 'cj');
  assert.deepEqual([...servers.keys()], ['hydra', 'github', 'linear', 'legacy', 'plain', 'weird']);
  assert.deepEqual(servers.get('plain')?.spec, { type: 'stdio', command: 'node', args: ['server.js', '--api-key', 'sk-1234567890abcdef'], env: {} });
  assert.deepEqual(servers.get('legacy')?.spec, { type: 'sse', url: 'https://example.com/sse', headers: {} });
  assert.match(servers.get('weird')!.problem!, /websocket/);
  assert.equal(servers.get('hydra')?.removable, false); assert.deepEqual(servers.get('hydra')?.extras, ['timeout']);
  assert.equal(servers.get('github')?.removable, true);
  assert.equal(readClaudeServers(undefined, 'cj').size, 0);
  assert.throws(() => readClaudeServers('{ broken', 'cj'));
});

test('secret masking by key name and by value shape', () => {
  for (const [key, value] of [['GITHUB_TOKEN', 'abc'], ['API_KEY', 'x'], ['client_secret', 'y'], ['DB_PASSWORD', 'z'], ['Authorization', 'Basic dXNlcg=='], ['X-Api-Key', '123']] as const) assert.ok(looksLikeSecret(key, value), key);
  for (const value of ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-api03-abcdefgh', 'Bearer abcdefgh1234', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'a8f5f167f44f4964e6c998dee827110c5a8f5f16']) assert.ok(looksLikeSecret(undefined, value), value);
  for (const [key, value] of [['AUTHOR', 'Nico'], ['KEYBOARD', 'us'], ['PATH', 'C:\\Windows\\System32'], ['NODE_ENV', 'production'], [undefined, '@modelcontextprotocol/server-filesystem'], [undefined, 'https://example.com/a/b'], ['GITHUB_TOKEN', '${GITHUB_TOKEN}'], ['TOKEN', ''], [undefined, '2025-06-18']] as const) assert.ok(!looksLikeSecret(key, value), `${key}=${value}`);
  assert.equal(maskSecret('API_TOKEN', 'abcdefghijklmnop1234'), '••••1234');
  assert.equal(maskSecret('API_TOKEN', 'short'), '••••••••');
  assert.equal(maskSecret('Authorization', 'Bearer abcdefghijklmnop1234'), 'Bearer ••••1234');
  assert.equal(maskSecret('REGION', 'eu-west-1'), 'eu-west-1');
  const shown = maskSpec({ type: 'stdio', command: 'node', args: ['s.js', '--api-key', 'sk-1234567890abcdef', '--token=abcd', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '--port', '8080'], env: { TOKEN: 'abcdefghijklmnopqrstu', MODE: 'fast' } });
  assert.deepEqual(shown, { type: 'stdio', command: 'node', args: ['s.js', '--api-key', '••••cdef', '--token=••••••••', '••••6789', '--port', '8080'], env: { TOKEN: '••••rstu', MODE: 'fast' } });
  const url = maskSpec({ type: 'http', url: 'https://u:pw@x.dev/mcp?api_key=abcdefghijklmnopq&region=eu', headers: {} }) as { url: string };
  assert.ok(!url.url.includes('pw@') && !url.url.includes('abcdefghijklmnopq') && url.url.includes('region=eu'), url.url);
});

test('validation of names and specs', () => {
  for (const bad of ['', 'hydra', 'HYDRA', '-x', 'a b', 'a.b', 'x'.repeat(65), 'ü', 7]) assert.throws(() => validateServerName(bad), Error, String(bad));
  assert.equal(validateServerName('my-server_2'), 'my-server_2');
  assert.throws(() => validateServerSpec({ type: 'stdio', command: '' }), /command/);
  assert.throws(() => validateServerSpec({ type: 'stdio', command: 'x', args: [1] }), /Arguments/);
  assert.throws(() => validateServerSpec({ type: 'stdio', command: 'x', env: { 'BAD-NAME': 'v' } }), /variable name/);
  assert.throws(() => validateServerSpec({ type: 'http', url: 'ftp://x' }), /https/);
  assert.throws(() => validateServerSpec({ type: 'http', url: 'https://x', headers: { 'X-A': 'a\r\nInjected: 1' } }), /one line/);
  assert.throws(() => validateServerSpec({ type: 'ws', url: 'https://x' }), /stdio/);
  assert.deepEqual(validateServerSpec({ type: 'stdio', command: ' npx ', extra: 1 }), { type: 'stdio', command: 'npx', args: [], env: {} });
});

test('claude mcp add-json arguments', () => {
  const args = claudeAddJsonArgs('alpha', stdio);
  assert.deepEqual(args.slice(0, 5), ['mcp', 'add-json', '-s', 'user', 'alpha']);
  assert.deepEqual(JSON.parse(args[5]!), { type: 'stdio', command: stdio.command, args: (stdio as { args: string[] }).args, env: (stdio as { env: object }).env });
  assert.deepEqual(JSON.parse(claudeAddJsonArgs('b', { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } })[5]!), { type: 'http', url: 'https://x/mcp', headers: { A: 'b' } });
  assert.throws(() => claudeAddJsonArgs('b', http), /Authorization header/);
});

async function scratch(): Promise<{ directory: string; context: McpContext; calls: string[][]; claudeFails: { value: boolean } }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-mcp-'));
  const calls: string[][] = [], claudeFails = { value: false };
  const claudeJson = path.join(directory, '.claude.json');
  const context: McpContext = {
    claudeJson, codexConfig: path.join(directory, 'codex', 'config.toml'), claudeExecutable: 'claude',
    // A fake Claude CLI that edits the JSON the way `claude mcp` would.
    runClaude: async (_executable, args) => {
      calls.push(args);
      if (claudeFails.value) return { code: 1, output: 'boom' };
      const config = JSON.parse(await readFile(claudeJson, 'utf8').catch(() => '{}')) as { mcpServers?: Record<string, unknown> };
      config.mcpServers ??= {};
      if (args[1] === 'add-json') config.mcpServers[args[4]!] = JSON.parse(args[5]!);
      else if (args[1] === 'remove') { if (!config.mcpServers[args[4]!]) return { code: 1, output: `No MCP server found with name: ${args[4]}` }; delete config.mcpServers[args[4]!]; }
      await writeFile(claudeJson, JSON.stringify(config));
      return { code: 0, output: '' };
    },
  };
  return { directory, context, calls, claudeFails };
}

test('list, add to both, toggle per agent and remove, through injected paths', async () => {
  const { directory, context, calls, claudeFails } = await scratch();
  try {
    const original = (await fixture('user-servers.toml')).replace(/\n/g, '\r\n');
    await writeFile(context.claudeJson, await fixture('claude.json'));
    await mkdir(path.dirname(context.codexConfig), { recursive: true });
    await writeFile(context.codexConfig, original);
    const list = await listMcpServers(context);
    const github = list.servers.find(server => server.name === 'github')!;
    assert.deepEqual(Object.keys(github.agents).sort(), ['claude', 'codex'], 'one entry, two chips');
    assert.equal((github.spec as { env: Record<string, string> }).env.GITHUB_PERSONAL_ACCESS_TOKEN, '••••6789', 'secrets masked');
    assert.equal(github.differs, true);
    assert.equal(list.servers.find(server => server.name === 'hydra')?.locked, true);
    assert.ok(!JSON.stringify(list).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'no raw secret anywhere in the list');
    assert.equal((await listMcpServers(context, { reveal: true })).servers.find(server => server.name === 'github')?.agents.codex?.spec?.type, 'stdio');

    await addMcpServer(context, 'alpha', stdio, ['claude', 'codex']);
    assert.deepEqual(calls.at(-1)?.slice(0, 5), ['mcp', 'add-json', '-s', 'user', 'alpha']);
    const both = (await listMcpServers(context)).servers.find(server => server.name === 'alpha')!;
    assert.equal(both.agents.codex?.managedByHydra, true); assert.equal(both.agents.claude?.removable, true); assert.equal(both.differs, false);
    await assert.rejects(addMcpServer(context, 'alpha', stdio, ['codex']), /already set up for Codex/);
    await assert.rejects(addMcpServer(context, 'github', stdio, ['codex']), /already set up for Codex/);

    await removeMcpServer(context, 'alpha', 'codex');
    assert.equal(await readFile(context.codexConfig, 'utf8'), original, 'Codex toggle off restores the file');
    await enableMcpServerFor(context, 'alpha', 'codex');
    assert.deepEqual(readCodexServers(await readFile(context.codexConfig, 'utf8'), '').get('alpha')?.spec, stdio, 'toggle on copies the raw spec from Claude');
    await removeMcpServer(context, 'alpha', 'codex');
    await removeMcpServer(context, 'alpha', 'claude');
    assert.deepEqual(calls.at(-1), ['mcp', 'remove', '-s', 'user', 'alpha']);
    assert.equal(await readFile(context.codexConfig, 'utf8'), original);
    await assert.rejects(removeMcpServer(context, 'github', 'codex'), /didn't add/);
    await assert.rejects(removeMcpServer(context, 'hydra', 'claude'), /Connectors/);

    // All-or-nothing: Claude refusing takes the Codex block out again.
    claudeFails.value = true;
    await assert.rejects(addMcpServer(context, 'beta', { ...http, bearerTokenEnvVar: undefined }, ['codex', 'claude']), /could not add "beta": boom/);
    assert.equal(await readFile(context.codexConfig, 'utf8'), original);
    // No Claude CLI: refused before anything is written.
    await assert.rejects(addMcpServer({ ...context, claudeExecutable: undefined }, 'beta', stdio, ['codex', 'claude']), /Install the Claude Code/);
    assert.equal(await readFile(context.codexConfig, 'utf8'), original);
    await assert.rejects(addMcpServer(context, 'beta', stdio, []), /Choose/);
    assert.deepEqual(await configuredSpec(context, 'linear'), { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer lin_api_abcdefghijklmnop' } });

    // Missing files list as empty; a broken file is reported, not thrown.
    await rm(context.codexConfig);
    await writeFile(context.claudeJson, '{ nope');
    const empty = await listMcpServers(context);
    assert.deepEqual(empty.servers, []); assert.match(empty.errors.claude!, /Couldn't read/); assert.equal(empty.errors.codex, undefined);
    await addMcpServer(context, 'fresh', stdio, ['codex']);
    await removeMcpServer(context, 'fresh', 'codex');
    assert.equal(await readFile(context.codexConfig, 'utf8'), '', 'a file Hydra created is left empty, not reformatted');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const fakeServer = `
const fs = require('fs');
const mode = process.argv[2];
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid));
process.stderr.write('fake server starting\\n');
if (mode === 'crash') { process.stderr.write('fatal: missing FAKE_KEY\\n'); process.exit(3); }
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', data => {
  buffer += data;
  let at;
  while ((at = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    const message = JSON.parse(line);
    const reply = body => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }) + '\\n');
    if (mode === 'hang') continue;
    if (message.method === 'initialize') {
      process.stdout.write('not json, a stray log line\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'ping' }) + '\\n');
      reply({ result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.2.3' } } });
    } else if (message.method === 'tools/list') {
      if (mode === 'refuse') reply({ error: { code: -32000, message: 'no tools for you' } });
      else if (!message.params.cursor) reply({ result: { tools: [{ name: 'a' }, { name: 'b' }], nextCursor: 'p2' } });
      else reply({ result: { tools: [{ name: process.env.FAKE_KEY || 'c' }] } });
    }
  }
});
`;
test('testMcpServer speaks MCP over stdio, and always stops the process', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-mcp-test-'));
  try {
    const script = path.join(directory, 'fake-server.cjs'), pidFile = path.join(directory, 'pid');
    await writeFile(script, fakeServer);
    const spec = (mode: string): McpServerSpec => ({ type: 'stdio', command: process.execPath, args: [script, mode], env: { FAKE_KEY: 'from-env', PID_FILE: pidFile } });
    const alive = async () => { try { process.kill(Number(await readFile(pidFile, 'utf8')), 0); return true; } catch { return false; } };
    const ok = await testMcpServer(spec('ok'), { timeoutMs: 10_000 });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    if (ok.ok) { assert.equal(ok.toolCount, 3); assert.deepEqual(ok.tools, ['a', 'b', 'from-env']); assert.equal(ok.serverName, 'fake'); assert.equal(ok.serverVersion, '1.2.3'); assert.equal(ok.protocolVersion, '2025-06-18'); }
    assert.equal(await alive(), false, 'stopped after a good test');

    const hang = await testMcpServer(spec('hang'), { timeoutMs: 800 });
    assert.equal(hang.ok, false);
    if (!hang.ok) { assert.match(hang.error, /didn't answer within/); assert.match(hang.stderrTail ?? '', /fake server starting/); }
    assert.equal(await alive(), false, 'stopped after a timeout');

    const crash = await testMcpServer(spec('crash'), { timeoutMs: 10_000 });
    assert.equal(crash.ok, false);
    if (!crash.ok) { assert.match(crash.error, /exited \(code 3\)/); assert.match(crash.stderrTail ?? '', /missing FAKE_KEY/); }
    const refuse = await testMcpServer(spec('refuse'), { timeoutMs: 10_000 });
    assert.equal(refuse.ok, false);
    if (!refuse.ok) assert.match(refuse.error, /refused tools\/list: no tools for you/);
    const missing = await testMcpServer({ type: 'stdio', command: path.join(directory, 'nope-not-here'), args: [], env: {} }, { timeoutMs: 5000 });
    assert.equal(missing.ok, false);
    const sse = await testMcpServer({ type: 'sse', url: 'https://x', headers: {} });
    assert.equal(sse.ok, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('testMcpServer speaks streamable HTTP with JSON and SSE answers and a session id', async () => {
  const seen: { session?: string; auth?: string; protocol?: string; deleted?: boolean } = {};
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === 'DELETE') { seen.deleted = request.headers['mcp-session-id'] === 'sess-1'; response.writeHead(200).end(); return; }
    let body = ''; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (request.url === '/denied') { response.writeHead(401).end('no'); return; }
    if (message.method === 'initialize') {
      seen.auth = request.headers.authorization;
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', serverInfo: { name: 'web', version: '9' } } }));
    } else if (message.method === 'notifications/initialized') { seen.session = request.headers['mcp-session-id'] as string; response.writeHead(202).end(); }
    else if (message.method === 'tools/list') {
      seen.protocol = request.headers['mcp-protocol-version'] as string;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: {} })}\r\n\r\n`);
      response.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'x' }] } })}\n\n`);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await testMcpServer({ type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { 'X-Test': '1' }, bearerTokenEnvVar: 'FAKE_MCP_TOKEN' }, { timeoutMs: 5000, env: { FAKE_MCP_TOKEN: 'tok' } });
    assert.deepEqual({ ...result, durationMs: 0 }, { ok: true, toolCount: 1, tools: ['x'], serverName: 'web', serverVersion: '9', protocolVersion: '2025-03-26', durationMs: 0 });
    assert.deepEqual(seen, { auth: 'Bearer tok', session: 'sess-1', protocol: '2025-03-26', deleted: true });
    const denied = await testMcpServer({ type: 'http', url: `http://127.0.0.1:${port}/denied`, headers: {} }, { timeoutMs: 5000 });
    assert.equal(denied.ok, false); if (!denied.ok) assert.match(denied.error, /401.*sign-in or a token/);
    const unset = await testMcpServer({ type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {}, bearerTokenEnvVar: 'FAKE_MCP_TOKEN' }, { env: {} });
    assert.equal(unset.ok, false); if (!unset.ok) assert.match(unset.error, /FAKE_MCP_TOKEN/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Windows env merging and command lookup', async () => {
  assert.deepEqual(mergeEnv({ Path: 'a', X: '1' }, { PATH: 'b' }, 'win32'), { X: '1', PATH: 'b' });
  assert.deepEqual(mergeEnv({ Path: 'a' }, { PATH: 'b' }, 'linux'), { Path: 'a', PATH: 'b' });
  const directory = await mkdtemp(path.join(tmpdir(), 'hydra-mcp-path-'));
  try {
    await writeFile(path.join(directory, 'tool.cmd'), '@echo off');
    // The PATH/PATHEXT search needs real Windows paths.
    if (process.platform === 'win32') assert.equal(await resolveCommand('tool', { Path: directory, PATHEXT: '.EXE;.CMD' }, 'win32'), path.win32.join(directory, 'tool.cmd'));
    assert.equal(await resolveCommand('tool.exe', { Path: directory }, 'win32'), 'tool.exe');
    assert.equal(await resolveCommand('tool', { PATH: directory }, 'linux'), 'tool');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
