import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../src/core/git';
import { JobStore, toHeadCheckView } from '../src/core/jobs';
import { gateChip } from '../src/core/agentsCanvas';
import { HelperService, type HelperServiceOptions } from '../src/core/helperService';
import { LaneStore } from '../src/core/lanes';
import { LaneService, gatesFingerprint, gatesPassNote } from '../src/core/laneService';
import { parseGatesConfig, runGateList, type Gate, type GatesConfig } from '../src/core/gates';
import { reviewPrompt } from '../src/core/gates/review';
import { checkPackContents, codexProblem, formatPacksFile, packCaps, parsePackManifest, parsePacksFile, parseSkillFile, resolvePlaceholders, skipGatesProblem, type PackManifest } from '../src/core/packs/format';
import { packHash, readPackFolder } from '../src/core/packs/files';
import { choosePack, listPacks, loadPack } from '../src/core/packs/registry';
import { allowPack, allowState, canonicalProject, readAllowed, revokePack } from '../src/core/packs/allowed';
import { buildRolePlugin, cacheName, ensureCached, removeCacheEntry } from '../src/core/packs/cache';
import { projectPacks, readPacksFile, withPack, withSkipGate, writePacksFile, type PackPlaces, type ProjectPack } from '../src/core/packs/project';
import { combineGates, effectiveGates, overGateCap } from '../src/core/packs/gates';
import { PackService } from '../src/core/packs/service';
import { fakePtyModule } from './lanePtyFake';

// ---- Fixtures ----

/** The plan's SEO example (docs/Packs_Plan.md, section 2), with a {node} gate and a review gate that names a role. */
const seo = (): any => ({
  version: 1, id: 'seo', title: 'SEO', description: 'Pages that rank: titles, structure and links.', publisher: 'Acme web team',
  roles: [{ id: 'seo-writer', title: 'SEO writer', description: 'Writes and fixes page metadata.', provider: 'claude', instructions: 'roles/seo-writer.md', skills: ['meta-tags'], mcpServers: ['lighthouse'] }],
  gates: [
    { id: 'meta', type: 'command', command: ['{node}', '{pack}/scripts/check-meta.mjs'], timeoutSeconds: 120 },
    { id: 'seo-review', type: 'review', reviewer: 'other', role: 'seo-writer', focus: 'Titles, descriptions, headings and internal links.' },
  ],
  mcpServers: { lighthouse: { type: 'stdio', command: 'npx', args: ['-y', 'lighthouse-mcp@1.2.3'], env: { CHROME_PATH: '${CHROME_PATH}' } } },
});
const skill = (id: string, description = `The ${id} skill.`) => `---\nname: ${id}\ndescription: ${description}\n---\n\nHow to use it.\n`;
/** A pack's files in memory: `undefined` removes one of the defaults. */
function seoFiles(manifest: unknown = seo(), extra: Record<string, string | Buffer | undefined> = {}): Map<string, Buffer> {
  const all: Record<string, string | Buffer | undefined> = {
    'pack.json': JSON.stringify(manifest), 'roles/seo-writer.md': 'Write good metadata.\n',
    'skills/meta-tags/SKILL.md': skill('meta-tags', 'How to write meta tags.'), 'skills/meta-tags/check.mjs': 'console.log(1);\n',
    'scripts/check-meta.mjs': 'process.exit(0);\n', ...extra,
  };
  return new Map(Object.entries(all).filter((entry): entry is [string, string | Buffer] => entry[1] !== undefined).map(([name, content]) => [name, Buffer.isBuffer(content) ? content : Buffer.from(content)]));
}
const refuses = (change: (manifest: any) => void, pattern: RegExp) => { const manifest = seo(); change(manifest); assert.throws(() => parsePackManifest(manifest), pattern); };
const contentsRefuse = (files: Map<string, Buffer>, pattern: RegExp, manifest: unknown = JSON.parse(files.get('pack.json')!.toString())) => assert.throws(() => checkPackContents(parsePackManifest(manifest), files), pattern);

async function tempRoot(name = 'hydra-packs-'): Promise<{ root: string; close: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), name));
  return { root, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }) };
}
/** Write a pack folder under `parent`. */
async function writePack(parent: string, id: string, files: Map<string, Buffer> | Record<string, string>): Promise<string> {
  const folder = path.join(parent, id);
  for (const [name, content] of files instanceof Map ? files : Object.entries(files)) {
    const target = path.join(folder, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return folder;
}
/** A small valid pack whose gates are `gates`, with a role "checker" and any scripts it needs. */
function smallPack(id: string, title: string, gates: unknown[], scripts: Record<string, string> = {}): Record<string, string> {
  return {
    'pack.json': JSON.stringify({ version: 1, id, title, description: `${title} checks.`, roles: [{ id: 'checker', title: 'Checker', description: 'Checks things.', provider: 'codex', instructions: 'roles/checker.md', changes: 'optional' }], gates }),
    'roles/checker.md': `Check everything carefully for the ${title} pack.\n`, ...scripts,
  };
}
const junction = (target: string, link: string) => symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
const places = (root: string, extra: Partial<PackPlaces> = {}): PackPlaces => ({ builtin: path.join(root, 'builtin'), user: path.join(root, 'user'), allowedFile: path.join(root, 'storage', 'packs', 'allowed.json'), cacheRoot: path.join(root, 'storage', 'packs', 'cache'), version: '0.24.0', ...extra });
async function allowListed(folder: string, where: PackPlaces, ids: string[]): Promise<void> {
  const packs = await listPacks({ builtin: where.builtin, user: where.user, project: path.join(folder, '.hydra', 'packs') });
  for (const id of ids) await allowPack(where.allowedFile, await canonicalProject(folder), choosePack(packs, id)!, where.version);
}

// ---- pack.json ----

test('pack.json: a valid pack parses with its defaults, skills, scripts and server notes', () => {
  const manifest = parsePackManifest(seo());
  assert.equal(manifest.roles[0]!.changes, 'required');
  assert.deepEqual(manifest.roles[0]!.tools, []);
  assert.equal((manifest.gates[1] as Extract<Gate, { type: 'review' }>).role, 'seo-writer');
  const valid = checkPackContents(manifest, seoFiles());
  assert.deepEqual(valid.skills, [{ id: 'meta-tags', description: 'How to write meta tags.', files: ['skills/meta-tags/SKILL.md', 'skills/meta-tags/check.mjs'], scripts: ['skills/meta-tags/check.mjs'] }]);
  assert.equal(valid.instructions['seo-writer'], 'Write good metadata.\n');
  assert.deepEqual(valid.servers.lighthouse, { downloads: 'Downloads lighthouse-mcp@1.2.3 from npm on first use.', variables: ['CHROME_PATH'] });
  // Decision 4: a role may set a model, parsed now and used when it launches.
  const withModel = seo(); withModel.roles[0].model = 'claude-opus-5-5[1m]';
  assert.equal(parsePackManifest(withModel).roles[0]!.model, 'claude-opus-5-5[1m]');
});

test('pack.json: ids and unknown keys are refused with the reason', () => {
  refuses(manifest => { manifest.id = 'SEO'; }, /The pack's "id" must be 1–24 lowercase letters, digits or dashes/);
  refuses(manifest => { manifest.id = 'a'.repeat(25); }, /must be 1–24 lowercase/);
  refuses(manifest => { manifest.roles[0].id = 'Writer'; }, /Role 1's "id" must be 1–24/);
  refuses(manifest => { manifest.colour = 'red'; }, /pack\.json has an unknown setting "colour"/);
  refuses(manifest => { manifest.maxAttempts = 5; }, /unknown setting "maxAttempts"/);
  refuses(manifest => { manifest.roles[0].colour = 'red'; }, /Role "seo-writer" has an unknown setting "colour"/);
  refuses(manifest => { manifest.gates[0].pack = 'other'; }, /Gate "meta" has an unknown setting "pack"/);
  refuses(manifest => { manifest.gates[0].role = 'seo-writer'; }, /Gate "meta" has an unknown setting "role"/);
  refuses(manifest => { manifest.mcpServers.lighthouse.cwd = 'C:/'; }, /MCP server "lighthouse" has an unknown setting "cwd"/);
  refuses(manifest => { manifest.roles.push({ ...manifest.roles[0] }); }, /Two roles have the id "seo-writer"/);
  refuses(manifest => { manifest.gates.push({ ...manifest.gates[0] }); }, /Two gates have the id "meta"/);
  refuses(manifest => { manifest.mcpServers['Light House'] = manifest.mcpServers.lighthouse; }, /The MCP server id "Light House" must be/);
  refuses(manifest => { manifest.version = 2; }, /"version": 1/);
  refuses(manifest => { manifest.roles[0].provider = 'gemini'; }, /"provider" must be "claude" or "codex"/);
  refuses(manifest => { manifest.roles[0].tools = ['shell']; }, /"tools" can only be \["web"\]/);
  refuses(manifest => { manifest.roles[0].changes = 'maybe'; }, /"changes" must be "required" or "optional"/);
  refuses(manifest => { manifest.roles[0].model = 'opus & calc'; }, /"model" must be a model name/);
  refuses(manifest => { manifest.publisher = 'x'.repeat(81); }, /"publisher" must be text on one line, up to 80/);
  refuses(manifest => { manifest.description = 'x'.repeat(301); }, /"description" must be text on one line, up to 300/);
  // "role" on a review gate is a pack-only addition: gates.json refuses it, and a pack's must name one of its roles.
  assert.throws(() => parseGatesConfig({ gates: [{ id: 'check', type: 'review', role: 'seo-writer' }] }), /Gate "check" has an unknown setting "role"/);
  refuses(manifest => { manifest.gates[1].role = 'nobody'; }, /"role" must name one of this pack's roles/);
});

test('pack.json: references between roles, skills and servers are checked', () => {
  refuses(manifest => { manifest.roles[0].mcpServers = ['nope']; }, /Role "seo-writer" uses the MCP server "nope", which the pack doesn't have/);
  const noSkill = seo(); noSkill.roles[0].skills = ['nope'];
  contentsRefuse(seoFiles(noSkill), /Role "seo-writer" uses the skill "nope", which the pack doesn't have/);
  contentsRefuse(seoFiles(seo(), { 'skills/other/notes.md': 'x' }), /The skill "other" has no SKILL\.md/);
  contentsRefuse(seoFiles(seo(), { 'skills/loose.md': 'x' }), /the skills folder holds only one folder per skill/);
  contentsRefuse(seoFiles(seo(), { 'skills/meta-tags/SKILL.md': skill('other-name') }), /"name" must be "meta-tags", the folder's name/);
  contentsRefuse(seoFiles(seo(), { 'roles/seo-writer.md': undefined }), /its instructions file "roles\/seo-writer\.md" isn't in the pack/);
  contentsRefuse(seoFiles(seo(), { 'roles/seo-writer.md': '  \n' }), /is empty/);
  // A pack's skills can't grant tools or run hooks through their front matter.
  assert.throws(() => parseSkillFile('meta-tags', '---\nname: meta-tags\ndescription: x\nallowed-tools: Bash(*)\n---\n'), /unknown front-matter setting "allowed-tools"/);
  assert.throws(() => parseSkillFile('meta-tags', '---\nname: meta-tags\ndescription: >\n  folded\n---\n'), /write "description" on one line|one line/);
  assert.throws(() => parseSkillFile('meta-tags', 'no front matter'), /must start with front matter/);
  assert.deepEqual(parseSkillFile('meta-tags', '\uFEFF---\r\nname: "meta-tags"\r\ndescription: Quoted and CRLF.\r\nlicense: MIT\r\n---\r\n'), { description: 'Quoted and CRLF.' });
});

test('pack.json: files outside the folder are refused, and {pack} and {node} are used only as allowed', () => {
  for (const bad of ['/etc/role.md', 'C:/role.md', '../role.md', 'roles/../../role.md', 'roles\\seo-writer.md', 'roles/./role.md', 'roles/con.md', 'roles/role.md.', '.hidden/role.md']) {
    refuses(manifest => { manifest.roles[0].instructions = bad; }, /"instructions" must/);
  }
  refuses(manifest => { manifest.roles[0].instructions = 'roles/seo-writer.txt'; }, /must be a Markdown file/);
  refuses(manifest => { manifest.gates[0].command = ['{node}', '{pack}/../outside.mjs']; }, /the path after "\{pack\}"/);
  refuses(manifest => { manifest.gates[0].command = ['{node}', '{pack}/C:/x.mjs']; }, /the path after "\{pack\}"/);
  refuses(manifest => { manifest.gates[0].command = ['node', '{node}']; }, /"\{node\}" can only be the command itself/);
  refuses(manifest => { manifest.gates[0].command = ['{node}x', 'a.mjs']; }, /"\{node\}" can only be the command itself/);
  refuses(manifest => { manifest.gates[0].command = ['node', 'x{pack}/a.mjs']; }, /"\{pack\}" must start an argument/);
  refuses(manifest => { manifest.gates[0].command = ['node', '{pack}/a{pack}']; }, /"\{pack\}" must start an argument/);
  refuses(manifest => { manifest.mcpServers.lighthouse.args = ['{node}']; }, /"\{node\}" can only be the command itself/);
  const missing = seo(); missing.gates[0].command = ['{node}', '{pack}/scripts/missing.mjs'];
  contentsRefuse(seoFiles(missing), /"\{pack\}\/scripts\/missing\.mjs" isn't in the pack/);
  // Allowed: {pack} alone, after --name=, and as a folder in the pack.
  const fine = seo(); fine.gates[0].command = ['{node}', '{pack}/scripts', '--config={pack}/scripts/check-meta.mjs', '{pack}'];
  assert.doesNotThrow(() => checkPackContents(parsePackManifest(fine), seoFiles(fine)));
  // Resolved for a direct spawn: the real folder (spaces and quotes as they are) and Hydra's executable as Node.
  const folder = path.join('C:', 'it\'s here', 'seo-abc');
  assert.deepEqual(resolvePlaceholders(['{node}', '{pack}/scripts/check.mjs', '--config={pack}/a.json', '{pack}', 'plain'], folder, 'C:\\Program Files\\Hydra\\Hydra.exe'), {
    parts: ['C:\\Program Files\\Hydra\\Hydra.exe', path.join(folder, 'scripts', 'check.mjs'), `--config=${path.join(folder, 'a.json')}`, folder, 'plain'],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.deepEqual(resolvePlaceholders(['npm', 'test'], folder, 'hydra.exe'), { parts: ['npm', 'test'] });
});

test('pack.json: the caps', () => {
  const role = seo().roles[0];
  refuses(manifest => { manifest.roles = Array.from({ length: 9 }, (_, index) => ({ ...role, id: `r${index}` })); }, /at most 8 roles \(found 9\)/);
  refuses(manifest => { manifest.gates = Array.from({ length: 7 }, (_, index) => ({ id: `g${index}`, type: 'review' })); }, /at most 6 gates \(found 7\)/);
  refuses(manifest => { for (let index = 0; index < 6; index++) manifest.mcpServers[`s${index}`] = { type: 'stdio', command: 'x' }; }, /at most 6 MCP servers \(found 7\)/);
  const skills = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`skills/s${index}/SKILL.md`, skill(`s${index}`)]));
  contentsRefuse(seoFiles(seo(), skills), /at most 16 skills \(found 17\)/);
  const many = Object.fromEntries(Array.from({ length: packCaps.files - 4 }, (_, index) => [`notes/n${index}.txt`, 'x']));
  contentsRefuse(seoFiles(seo(), many), /at most 200 files \(found 201\)/);
  contentsRefuse(seoFiles(seo(), { 'big.bin': Buffer.alloc(packCaps.bytes) }), /at most 4 MB/);
  contentsRefuse(seoFiles(seo(), { 'skills/meta-tags/SKILL.md': skill('meta-tags') + 'x'.repeat(64 * 1024) }), /SKILL\.md is over 64 KB/);
  contentsRefuse(seoFiles(seo(), { 'roles/seo-writer.md': 'x'.repeat(8001) }), /is over 8000 characters/);
  assert.doesNotThrow(() => checkPackContents(parsePackManifest(seo()), seoFiles(seo(), { 'roles/seo-writer.md': 'x'.repeat(8000) })));
});

test('pack.json: a secret literal is refused, and ${NAME} is allowed', () => {
  const withServer = (spec: unknown) => { const manifest = seo(); manifest.mcpServers.lighthouse = spec; return manifest; };
  const secret = /looks like a secret\. Put the secret in your environment and use \$\{NAME\}\./;
  assert.throws(() => parsePackManifest(withServer({ type: 'stdio', command: 'npx', env: { OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwx' } })), secret);
  assert.throws(() => parsePackManifest(withServer({ type: 'stdio', command: 'npx', env: { API_KEY: 'abcd1234efgh5678' } })), /the value of API_KEY looks like a secret/);
  assert.throws(() => parsePackManifest(withServer({ type: 'stdio', command: 'npx', args: ['--api-key', 'abcd1234efgh5678'] })), /argument 2 looks like a secret/);
  assert.throws(() => parsePackManifest(withServer({ type: 'stdio', command: 'npx', args: ['--token=ghp_abcdefghijklmnopqrstuv'] })), secret);
  assert.throws(() => parsePackManifest(withServer({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer abcdef1234567890' } })), /the header Authorization looks like a secret/);
  assert.throws(() => parsePackManifest(withServer({ type: 'http', url: 'https://example.com/mcp?api_key=abcd1234efgh5678' })), /the URL's "api_key" looks like a secret/);
  assert.throws(() => parsePackManifest(withServer({ type: 'http', url: 'https://me:hunter2@example.com/mcp' })), /user name or password/);
  assert.throws(() => parsePackManifest(withServer({ type: 'stdio', command: 'npx', env: { TOKEN: '${HYDRA_HELPER_TOKEN}' } })), /one of Hydra's own variables/);
  // References, and short plain values under a secret-sounding name, are fine.
  assert.doesNotThrow(() => parsePackManifest(withServer({ type: 'stdio', command: 'npx', args: ['--api-key', '${OPENAI_API_KEY}'], env: { OPENAI_API_KEY: '${OPENAI_API_KEY}', SESSION_TIMEOUT: '30', AUTH_ENABLED: 'true' } })));
  assert.doesNotThrow(() => parsePackManifest(withServer({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${GITHUB_TOKEN}' } })));
});

test('pack.json: servers Codex can\'t be given safely are marked Claude only', () => {
  assert.equal(codexProblem({ type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0'], env: { A: '${A}', B: 'plain' } }), undefined);
  assert.match(codexProblem({ type: 'stdio', command: 'npx', args: ['--flag', 'a&b'], env: {} })!, /can't be passed to Codex safely/);
  assert.match(codexProblem({ type: 'stdio', command: 'npx', args: ['it\'s'], env: {} })!, /can't be passed to Codex safely/);
  assert.match(codexProblem({ type: 'stdio', command: 'npx', args: ['100%'], env: {} })!, /can't be passed to Codex safely/);
  assert.match(codexProblem({ type: 'stdio', command: 'npx', args: ['--dir=${HOME}'], env: {} })!, /doesn't fill in \$\{NAME\} in arguments/);
  assert.match(codexProblem({ type: 'stdio', command: 'npx', args: [], env: { A: 'prefix-${A}' } })!, /only whole/);
  assert.match(codexProblem({ type: 'sse', url: 'https://example.com/sse', headers: {} })!, /SSE/);
  assert.equal(codexProblem({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${T}' } }), undefined);
  assert.match(codexProblem({ type: 'http', url: 'https://example.com/mcp', headers: { 'X-Key': 'k-${T}' } })!, /header variable only whole/);
  const unsafe = seo(); unsafe.mcpServers.lighthouse.args = ['-y', 'lighthouse-mcp@1.2.3', '--budget=100%'];
  assert.match(checkPackContents(parsePackManifest(unsafe), seoFiles(unsafe)).servers.lighthouse!.claudeOnly!, /can't be passed to Codex safely/);
});

// ---- .hydra/packs.json ----

test('packs.json: round trip, unknown keys, duplicates, and skipGates naming a gate the pack doesn\'t have', async () => {
  const file = { version: 1 as const, packs: [{ id: 'coding' }, { id: 'research', skipGates: ['fact-check'] }] };
  assert.equal(formatPacksFile(file), '{\n  "version": 1,\n  "packs": [\n    {\n      "id": "coding"\n    },\n    {\n      "id": "research",\n      "skipGates": [\n        "fact-check"\n      ]\n    }\n  ]\n}\n');
  assert.deepEqual(parsePacksFile(JSON.parse(formatPacksFile(file))), file);
  assert.throws(() => parsePacksFile({ version: 1, packs: [], extra: 1 }), /\.hydra\/packs\.json has an unknown setting "extra"/);
  assert.throws(() => parsePacksFile({ version: 1, packs: [{ id: 'coding', enabled: true }] }), /The "coding" entry in \.hydra\/packs\.json has an unknown setting "enabled"/);
  assert.throws(() => parsePacksFile({ version: 1, packs: [{ id: 'coding' }, { id: 'coding' }] }), /lists the pack "coding" twice/);
  assert.throws(() => parsePacksFile({ version: 1, packs: Array.from({ length: 9 }, (_, index) => ({ id: `p${index}` })) }), /at most 8 packs \(found 9\)/);
  assert.throws(() => parsePacksFile({ version: 1, packs: [{ id: 'research', skipGates: ['a', 'a'] }] }), /"skipGates" for research lists "a" twice/);
  assert.throws(() => parsePacksFile({ packs: [] }), /needs "version": 1/);
  assert.equal(skipGatesProblem({ id: 'research', skipGates: ['fact-chek'] }, { title: 'Research', gates: [{ id: 'fact-check', type: 'review', required: true, reviewer: 'other', focus: '' }] }), '"skipGates" names "fact-chek", which the Research pack doesn\'t have.');
  assert.deepEqual(withPack(withPack(file, 'seo', true), 'coding', false).packs.map(entry => entry.id), ['research', 'seo']);
  assert.deepEqual(withSkipGate(file, 'research', 'fact-check', false).packs[1], { id: 'research' });
  assert.deepEqual(withSkipGate(file, 'coding', 'code-review', true).packs[0], { id: 'coding', skipGates: ['code-review'] });
  const { root, close } = await tempRoot();
  try {
    assert.deepEqual(await readPacksFile(root), { file: { version: 1, packs: [] }, exists: false });
    await writePacksFile(root, file);
    assert.equal(await readFile(path.join(root, '.hydra', 'packs.json'), 'utf8'), formatPacksFile(file));
    assert.deepEqual(await readPacksFile(root), { file, exists: true });
    assert.deepEqual((await readdir(path.join(root, '.hydra'))).sort(), ['packs.json'], 'the atomic write leaves no temporary file');
    // A CRLF checkout keeps its line endings, and an unchanged file isn't written again.
    const crlf = formatPacksFile(file).replace(/\n/g, '\r\n');
    await writeFile(path.join(root, '.hydra', 'packs.json'), crlf);
    const before = (await stat(path.join(root, '.hydra', 'packs.json'))).mtimeMs;
    await new Promise(resolve => setTimeout(resolve, 20));
    await writePacksFile(root, file);
    assert.equal((await stat(path.join(root, '.hydra', 'packs.json'))).mtimeMs, before, 'the same packs: not written');
    await writePacksFile(root, withPack(file, 'seo', true));
    assert.equal(await readFile(path.join(root, '.hydra', 'packs.json'), 'utf8'), formatPacksFile(withPack(file, 'seo', true)).replace(/\n/g, '\r\n'));
    await writeFile(path.join(root, '.hydra', 'packs.json'), '{ "version": 1, ');
    await assert.rejects(readPacksFile(root), /isn't valid JSON/);
  } finally { await close(); }
});

// ---- The content hash ----

test('hash: changing any file changes it; the order files are read in doesn\'t', async () => {
  const files = seoFiles();
  const hash = packHash(files);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(packHash(new Map([...files].reverse())), hash);
  const changed = (edit: (copy: Map<string, Buffer>) => void) => { const copy = new Map(files); edit(copy); return packHash(copy); };
  assert.notEqual(changed(copy => copy.set('roles/seo-writer.md', Buffer.from('Write good metadata!\n'))), hash);
  assert.notEqual(changed(copy => { copy.set('roles/renamed.md', copy.get('roles/seo-writer.md')!); copy.delete('roles/seo-writer.md'); }), hash);
  assert.notEqual(changed(copy => copy.set('extra.txt', Buffer.alloc(0))), hash);
  assert.notEqual(packHash(new Map([['a', Buffer.from('xy')], ['b', Buffer.from('')]])), packHash(new Map([['a', Buffer.from('x')], ['b', Buffer.from('y')]])), 'bytes can\'t move between files unnoticed');
  const { root, close } = await tempRoot();
  try {
    const folder = await writePack(root, 'seo', files);
    const read = await readPackFolder(folder);
    assert.equal(read.hash, hash);
    assert.deepEqual([...read.files.keys()].sort(), [...files.keys()].sort());
  } finally { await close(); }
});

// ---- The registry ----

test('registry: built-in and user packs are found; a broken pack is listed with its problem; a user pack can\'t reuse a built-in id', async () => {
  const { root, close } = await tempRoot();
  try {
    const user = path.join(root, 'user'), project = path.join(root, 'project');
    await writePack(user, 'seo', seoFiles());
    await writePack(user, 'broken', { 'pack.json': '{ "version": 1, ' });
    await writePack(user, 'coding', smallPack('coding', 'My coding', []));
    await writePack(user, 'other', smallPack('seo2', 'Misnamed', []));
    await writePack(user, 'Bad Name', smallPack('bad', 'Bad', []));
    await mkdir(path.join(user, '.git'), { recursive: true });
    // A link anywhere in a pack is refused, and nothing is followed through it.
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true }); await writeFile(path.join(outside, 'keep.txt'), 'keep');
    const linked = await writePack(user, 'linked', smallPack('linked', 'Linked', []));
    await junction(outside, path.join(linked, 'data'));
    await junction(outside, path.join(user, 'whole'));
    const packs = await listPacks({ builtin: path.resolve('packs'), user, project });
    const find = (id: string, source = 'user') => packs.find(pack => pack.id === id && pack.source === source)!;
    for (const id of ['coding', 'research']) { assert.ok(find(id, 'builtin').valid, `${id} is built in and valid: ${find(id, 'builtin').problem}`); }
    assert.ok(find('seo').valid); assert.match(find('seo').hash!, /^[a-f0-9]{64}$/);
    assert.match(find('broken').problem!, /pack\.json isn't valid JSON/);
    assert.equal(find('coding').problem, 'coding is a built-in pack; choose another id.');
    assert.equal(find('coding').valid, undefined);
    assert.match(find('other').problem!, /says the id is "seo2", but the folder is named "other"/);
    assert.match(find('Bad Name').problem!, /The folder's name must be the pack's id/);
    assert.match(find('linked').problem!, /"data" is a link/);
    assert.match(find('whole').problem!, /is a link/);
    assert.equal(packs.some(pack => pack.id === '.git'), false);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(choosePack(packs, 'coding')!.source, 'builtin');
    // A project pack wins over yours with the same id, and yours says so.
    await writePack(project, 'seo', seoFiles());
    const again = await listPacks({ user, project }, { only: new Set(['seo']) });
    assert.deepEqual(again.map(pack => pack.source), ['user', 'project'], '`only` reads just those packs');
    assert.equal(choosePack(again, 'seo')!.source, 'project');
    assert.match(again[0]!.note!, /This project has its own seo pack, which it uses instead/);
  } finally { await close(); }
});

test('the built-in packs: Coding and Research, review gates only, Playwright pinned for the UI builder only', async () => {
  const coding = await loadPack(path.resolve('packs', 'coding'), 'builtin');
  const research = await loadPack(path.resolve('packs', 'research'), 'builtin');
  assert.ok(coding.valid, coding.problem); assert.ok(research.valid, research.problem);
  const codingManifest = coding.valid!.manifest, researchManifest = research.valid!.manifest;
  assert.deepEqual(codingManifest.roles.map(role => [role.id, role.provider, role.changes]), [['builder', 'claude', 'required'], ['ui-builder', 'claude', 'required'], ['reviewer', 'codex', 'optional']]);
  assert.deepEqual(researchManifest.roles.map(role => [role.id, role.provider, role.tools, role.changes]), [['researcher', 'claude', ['web'], 'required'], ['fact-checker', 'codex', ['web'], 'optional']]);
  for (const manifest of [codingManifest, researchManifest]) assert.ok(manifest.gates.every(gate => gate.type === 'review'), 'a built-in pack can\'t know a project\'s test command');
  assert.deepEqual(codingManifest.gates.map(gate => gate.id), ['code-review']);
  assert.deepEqual(researchManifest.gates.map(gate => [gate.id, (gate as Extract<Gate, { type: 'review' }>).role]), [['fact-check', 'fact-checker']]);
  // Decisions 3 and 5: Playwright MCP, pinned to one exact version, only for the UI builder.
  const playwright = codingManifest.mcpServers.playwright;
  assert.ok(playwright && playwright.type === 'stdio');
  assert.ok(playwright.args.some(arg => /^@playwright\/mcp@\d+\.\d+\.\d+$/.test(arg)), 'an exact version, not a range or "latest"');
  assert.deepEqual(codingManifest.roles.filter(role => role.mcpServers.includes('playwright')).map(role => role.id), ['ui-builder']);
  assert.match(coding.valid!.servers.playwright!.downloads!, /^Downloads @playwright\/mcp@\d+\.\d+\.\d+ from npm on first use\.$/);
  assert.deepEqual(coding.valid!.skills.map(skill => skill.id), ['test-first', 'ui-check']);
  assert.deepEqual(research.valid!.skills.map(skill => skill.id), ['cite-sources']);
});

// ---- The allow record ----

test('allow record: per project and pack; built-in pinned to Hydra, others to their hash', async () => {
  const { root, close } = await tempRoot();
  try {
    const file = path.join(root, 'storage', 'packs', 'allowed.json');
    const project = await canonicalProject(root), other = await canonicalProject(path.join(root, 'other'));
    const seoPack = { id: 'seo', source: 'user' as const, hash: 'a'.repeat(64) };
    assert.deepEqual(await readAllowed(file), { entries: [] });
    assert.deepEqual(allowState(await readAllowed(file), project, seoPack, 'SEO'), { state: 'needsOk', reason: 'The SEO pack isn\'t allowed on this machine yet.' });
    await allowPack(file, project, seoPack, '0.24.0', new Date('2026-09-25T10:00:00Z'));
    const record = await readAllowed(file);
    assert.deepEqual(record.entries, [{ project, pack: 'seo', source: 'user', hash: 'a'.repeat(64), version: '0.24.0', at: '2026-09-25T10:00:00.000Z' }]);
    assert.ok((await readFile(file, 'utf8')).endsWith('}\n'));
    assert.deepEqual(allowState(record, project, seoPack, 'SEO'), { state: 'allowed' });
    assert.deepEqual(allowState(record, project, { ...seoPack, hash: 'b'.repeat(64) }, 'SEO'), { state: 'changed', reason: 'The SEO pack changed since you allowed it. Review it again in Settings → Packs.' });
    assert.equal(allowState(record, project, { ...seoPack, source: 'project' }, 'SEO').state, 'needsOk', 'another source needs your OK again');
    assert.equal(allowState(record, other, seoPack, 'SEO').state, 'needsOk', 'once per project');
    // A built-in pack isn't pinned to a hash; an update doesn't ask again, and says so.
    await allowPack(file, project, { id: 'coding', source: 'builtin' }, '0.24.0');
    const coding = { id: 'coding', source: 'builtin' as const, hash: 'c'.repeat(64) };
    assert.deepEqual(allowState(await readAllowed(file), project, coding, 'Coding', '0.24.0'), { state: 'allowed' });
    assert.deepEqual(allowState(await readAllowed(file), project, coding, 'Coding', '0.25.0'), { state: 'allowed', note: 'Updated in Hydra 0.25.0.' });
    await revokePack(file, project, 'seo');
    assert.deepEqual((await readAllowed(file)).entries.map(entry => entry.pack), ['coding']);
    await assert.rejects(allowPack(file, project, { id: 'seo', source: 'user' }, '0.24.0'), /couldn't be read, so it can't be allowed/);
    // A damaged record allows nothing and says why; Hydra won't write over it.
    await writeFile(file, '{ nope');
    const damaged = await readAllowed(file);
    assert.match(damaged.problem!, /Hydra couldn't read what you allowed on this machine/);
    assert.deepEqual(allowState(damaged, project, coding, 'Coding'), { state: 'needsOk', reason: damaged.problem });
    await assert.rejects(allowPack(file, project, coding, '0.24.0'), /couldn't read what you allowed/);
  } finally { await close(); }
});

// ---- The cache ----

test('cache: a checked copy, repaired when it changes; links in it are unlinked, never followed', async () => {
  const { root, close } = await tempRoot();
  try {
    const cacheRoot = path.join(root, 'cache'), files = seoFiles(), hash = packHash(files);
    const copy = await ensureCached(cacheRoot, { id: 'seo', hash, files });
    assert.equal(path.basename(copy), cacheName('seo', hash));
    assert.equal(path.basename(copy), `seo-${hash.slice(0, 12)}`);
    assert.equal((await readPackFolder(copy)).hash, hash);
    const written = (await stat(path.join(copy, 'pack.json'))).mtimeMs;
    assert.equal(await ensureCached(cacheRoot, { id: 'seo', hash, files }), copy);
    assert.equal((await stat(path.join(copy, 'pack.json'))).mtimeMs, written, 'a good copy is left as it is');
    // A head can write outside its worktree (research R8): a changed copy is rebuilt from the checked bytes.
    await writeFile(path.join(copy, 'scripts', 'check-meta.mjs'), 'process.exit(0); // tampered\n');
    await writeFile(path.join(copy, 'extra.txt'), 'x');
    assert.equal(await ensureCached(cacheRoot, { id: 'seo', hash, files }), copy);
    assert.equal(await readFile(path.join(copy, 'scripts', 'check-meta.mjs'), 'utf8'), 'process.exit(0);\n');
    await assert.rejects(access(path.join(copy, 'extra.txt')));
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true }); await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await junction(outside, path.join(copy, 'scripts', 'linked'));
    assert.equal(await ensureCached(cacheRoot, { id: 'seo', hash, files }), copy);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep', 'removing the bad copy never deleted through its link');
    assert.equal((await readPackFolder(copy)).hash, hash);
    await assert.rejects(ensureCached(cacheRoot, { id: 'seo', hash: 'f'.repeat(64), files }), /don't match its hash/);
    assert.deepEqual((await readdir(cacheRoot)).filter(name => name.startsWith('.tmp-')), [], 'no temporary folders are left');
    await assert.rejects(removeCacheEntry(cacheRoot, '..'), /only deletes inside its pack cache/);
    await assert.rejects(removeCacheEntry(cacheRoot, 'a/b'), /only deletes inside its pack cache/);
  } finally { await close(); }
});

test('cache: a role\'s Claude plugin holds only plugin.json and its skills, and building it twice changes nothing', async () => {
  const { root, close } = await tempRoot();
  try {
    const cacheRoot = path.join(root, 'cache');
    const files = seoFiles(seo(), { 'skills/other/SKILL.md': skill('other'), 'hooks/hooks.json': '{}', 'commands/x.md': 'x' });
    const hash = packHash(files);
    const plugin = await buildRolePlugin(cacheRoot, { id: 'seo', hash, files, title: 'SEO' }, { id: 'seo-writer', title: 'SEO writer', skills: ['meta-tags'] });
    assert.equal(plugin, path.join(cacheRoot, `seo-${hash.slice(0, 12)}.plugins`, 'seo-writer'));
    const read = await readPackFolder(plugin);
    assert.deepEqual([...read.files.keys()].sort(), ['.claude-plugin/plugin.json', 'skills/meta-tags/SKILL.md', 'skills/meta-tags/check.mjs']);
    assert.deepEqual(JSON.parse(read.files.get('.claude-plugin/plugin.json')!.toString()), { name: 'hydra-seo', version: `0.0.0-${hash.slice(0, 12)}`, description: 'SEO writer skills from the SEO pack, for Hydra.' });
    const written = (await stat(path.join(plugin, '.claude-plugin', 'plugin.json'))).mtimeMs;
    assert.equal(await buildRolePlugin(cacheRoot, { id: 'seo', hash, files, title: 'SEO' }, { id: 'seo-writer', title: 'SEO writer', skills: ['meta-tags'] }), plugin);
    assert.equal((await stat(path.join(plugin, '.claude-plugin', 'plugin.json'))).mtimeMs, written);
    assert.equal((await readPackFolder(plugin)).hash, read.hash);
    // A link planted in it is removed with the folder, never followed.
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true }); await writeFile(path.join(outside, 'keep.txt'), 'keep');
    await junction(outside, path.join(plugin, 'skills', 'linked'));
    await buildRolePlugin(cacheRoot, { id: 'seo', hash, files, title: 'SEO' }, { id: 'seo-writer', title: 'SEO writer', skills: ['meta-tags'] });
    assert.equal((await readPackFolder(plugin)).hash, read.hash);
    assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  } finally { await close(); }
});

// ---- A project's packs: every state ----

test('active packs: every state, and a changed user pack goes inactive with its gates not run', async () => {
  const { root, close } = await tempRoot();
  try {
    const where = places(root), lead = path.join(root, 'lead');
    await writePack(where.builtin!, 'coding', smallPack('coding', 'Coding', [{ id: 'code-review', type: 'review' }]));
    await writePack(where.user!, 'seo', smallPack('seo', 'SEO', [{ id: 'meta', type: 'command', command: ['{node}', '{pack}/check.mjs'] }], { 'check.mjs': 'process.exit(0);\n' }));
    await writePack(where.user!, 'fresh', smallPack('fresh', 'Fresh', [{ id: 'fresh-check', type: 'review' }]));
    await writePack(where.user!, 'broken', { 'pack.json': JSON.stringify({ version: 1, id: 'broken', title: 'Broken', description: 'x', extra: true }) });
    await writePack(where.user!, 'spare', smallPack('spare', 'Spare', []));
    await writePacksFile(lead, { version: 1, packs: [{ id: 'coding' }, { id: 'seo', skipGates: ['typo'] }, { id: 'fresh' }, { id: 'ghost' }, { id: 'broken' }] });
    await allowListed(lead, where, ['coding', 'seo']);

    const state = async () => Object.fromEntries((await projectPacks(lead, where)).packs.map(pack => [pack.id, pack] as const));
    let packs = await state();
    assert.deepEqual(Object.values(packs).map(pack => [pack.id, pack.state]), [['coding', 'on'], ['seo', 'on'], ['fresh', 'needsOk'], ['ghost', 'notInstalled'], ['broken', 'invalid'], ['spare', 'off']]);
    assert.equal(packs.coding!.copy, path.join(where.cacheRoot, cacheName('coding', packs.coding!.pack!.hash!)));
    assert.deepEqual(packs.seo!.notes, ['"skipGates" names "typo", which the SEO pack doesn\'t have.']);
    assert.equal(packs.fresh!.reason, 'The Fresh pack isn\'t allowed on this machine yet.');
    assert.equal(packs.ghost!.reason, 'The ghost pack isn\'t installed: it\'s neither built into Hydra nor in your packs folder.');
    assert.match(packs.broken!.reason!, /^The broken pack has a problem: pack\.json has an unknown setting "extra"/);

    let gates = await effectiveGates(lead, where, 'hydra.exe');
    assert.deepEqual(gates.gates.map(gate => [gate.id, gate.pack]), [['code-review', 'coding'], ['meta', 'seo']]);
    assert.deepEqual(gates.notRun.map(result => [result.id, result.pack, result.state, result.required, result.summary]), [
      ['fresh-check', 'fresh', 'notRun', true, 'The Fresh pack isn\'t allowed on this machine yet.'],
      ['ghost', 'ghost', 'notRun', false, 'The ghost pack isn\'t installed: it\'s neither built into Hydra nor in your packs folder.'],
      ['broken', 'broken', 'notRun', false, packs.broken!.reason],
    ]);

    // Editing a user pack's file makes it Changed: nothing from it runs, and its gate says why.
    await writeFile(path.join(where.user!, 'seo', 'check.mjs'), 'process.exit(0); // edited\n');
    packs = await state();
    assert.equal(packs.seo!.state, 'changed');
    assert.equal(packs.seo!.copy, undefined);
    gates = await effectiveGates(lead, where, 'hydra.exe');
    assert.deepEqual(gates.gates.map(gate => gate.id), ['code-review']);
    assert.deepEqual(gates.notRun.find(result => result.id === 'meta'), { id: 'meta', kind: 'command', required: true, state: 'notRun', passed: false, exitCode: null, durationMs: 0, outputTail: '', summary: 'The SEO pack changed since you allowed it. Review it again in Settings → Packs.', pack: 'seo', packTitle: 'SEO' });
    // Reviewing it again restores it.
    await allowListed(lead, where, ['seo']);
    assert.equal((await state()).seo!.state, 'on');
    // A built-in id in your folder is listed as a problem, never used.
    await writePack(where.user!, 'coding', smallPack('coding', 'Mine', []));
    const all = (await projectPacks(lead, where)).packs;
    assert.equal(all.find(pack => pack.id === 'coding' && pack.pack?.source === 'builtin')!.state, 'on');
    assert.equal(all.find(pack => pack.id === 'coding' && pack.pack?.source === 'user')!.reason, 'coding is a built-in pack; choose another id.');
  } finally { await close(); }
});

test('project packs (.hydra/packs) are third-party: they need your review, pinned by hash', async () => {
  const { root, close } = await tempRoot();
  try {
    const where = places(root), lead = path.join(root, 'lead');
    await writePack(path.join(lead, '.hydra', 'packs'), 'docs', smallPack('docs', 'Docs', [{ id: 'links', type: 'command', command: ['{node}', '{pack}/links.mjs'] }], { 'links.mjs': 'process.exit(0);\n' }));
    await writePacksFile(lead, { version: 1, packs: [{ id: 'docs' }] });
    let [docs] = (await projectPacks(lead, where)).packs;
    assert.equal(docs!.pack!.source, 'project');
    assert.equal(docs!.state, 'needsOk', 'a committed packs.json and a committed pack still need your OK on this machine');
    assert.deepEqual((await effectiveGates(lead, where, 'hydra.exe')).notRun.map(result => result.summary), ['The Docs pack isn\'t allowed on this machine yet.']);
    await allowListed(lead, where, ['docs']);
    [docs] = (await projectPacks(lead, where)).packs;
    assert.equal(docs!.state, 'on');
    assert.deepEqual((await readAllowed(where.allowedFile)).entries.map(entry => [entry.pack, entry.source, entry.hash]), [['docs', 'project', docs!.pack!.hash]]);
    // A pull that changes the pack makes it Changed until you review it again.
    await writeFile(path.join(lead, '.hydra', 'packs', 'docs', 'links.mjs'), 'process.exit(1);\n');
    [docs] = (await projectPacks(lead, where)).packs;
    assert.equal(docs!.state, 'changed');
  } finally { await close(); }
});

// ---- Effective gates ----

test('effective gates: gates.json wins on an id, an earlier pack beats a later one, skipGates, {pack} and {node}, maxAttempts and lanes', async () => {
  const { root, close } = await tempRoot();
  try {
    const where = places(root), lead = path.join(root, 'lead');
    await writePack(where.user!, 'alpha', smallPack('alpha', 'Alpha', [
      { id: 'tests', type: 'command', command: ['npm', 'test'] },
      { id: 'lint', type: 'command', command: ['{node}', '{pack}/scripts/lint.mjs', '--config={pack}/lint.json'] },
      { id: 'a-review', type: 'review', role: 'checker', focus: 'Look closely.' },
    ], { 'scripts/lint.mjs': 'process.exit(0);\n', 'lint.json': '{}' }));
    await writePack(where.user!, 'beta', smallPack('beta', 'Beta', [
      { id: 'lint', type: 'command', command: ['beta-lint'] },
      { id: 'extra', type: 'screenshots', start: ['{node}', '{pack}/serve.mjs', '{port}'], url: 'http://localhost:{port}/' },
      { id: 'skipme', type: 'command', command: ['x'] },
    ], { 'serve.mjs': '' }));
    await mkdir(path.join(lead, '.hydra'), { recursive: true });
    await writeFile(path.join(lead, '.hydra', 'gates.json'), JSON.stringify({ maxAttempts: 5, lanes: 'off', gates: [{ id: 'tests', type: 'command', command: ['npm', 'run', 'test:unit'] }] }));
    await writePacksFile(lead, { version: 1, packs: [{ id: 'alpha' }, { id: 'beta', skipGates: ['skipme'] }] });
    await allowListed(lead, where, ['alpha', 'beta']);
    const node = path.join('C:', 'Program Files', 'Hydra', 'Hydra.exe');
    const gates = await effectiveGates(lead, where, node);
    assert.equal(gates.source, 'gates'); assert.equal(gates.maxAttempts, 5); assert.equal(gates.lanes, 'off');
    assert.deepEqual(gates.gates.map(gate => [gate.id, gate.pack]), [['tests', undefined], ['lint', 'alpha'], ['a-review', 'alpha'], ['extra', 'beta']]);
    assert.deepEqual((gates.gates[0] as Extract<Gate, { type: 'command' }>).command, ['npm', 'run', 'test:unit']);
    assert.deepEqual(gates.dropped, [
      { id: 'tests', pack: 'alpha', reason: 'Replaced by gates.json.' },
      { id: 'lint', pack: 'beta', reason: 'Replaced by the Alpha pack.' },
      { id: 'skipme', pack: 'beta', reason: 'Skipped in this project.' },
    ]);
    assert.deepEqual(gates.notRun, []);
    const alpha = (await projectPacks(lead, where, { listedOnly: true })).packs[0]!;
    assert.ok(alpha.copy!.startsWith(where.cacheRoot + path.sep), '{pack} is the checked copy, never the pack\'s own folder');
    const lint = gates.gates[1] as Extract<Gate, { type: 'command' }>;
    assert.deepEqual(lint.command, [node, path.join(alpha.copy!, 'scripts', 'lint.mjs'), `--config=${path.join(alpha.copy!, 'lint.json')}`]);
    assert.deepEqual(lint.env, { ELECTRON_RUN_AS_NODE: '1' });
    const extra = gates.gates[3] as Extract<Gate, { type: 'screenshots' }>;
    assert.equal(extra.start[0], node); assert.equal(extra.start[2], '{port}'); assert.deepEqual(extra.env, { ELECTRON_RUN_AS_NODE: '1' });
    assert.deepEqual((gates.gates[2] as Extract<Gate, { type: 'review' }>).reviewerRole, { title: 'Checker (Alpha pack)', instructions: 'Check everything carefully for the Alpha pack.\n' });
    // Without gates.json, the defaults: 3 attempts (the head's own default) and onMerge.
    await rm(path.join(lead, '.hydra', 'gates.json'));
    const defaults = await effectiveGates(lead, where, node);
    assert.equal(defaults.source, 'none'); assert.equal(defaults.maxAttempts, undefined); assert.equal(defaults.lanes, 'onMerge');
    assert.deepEqual(defaults.gates.map(gate => gate.id), ['tests', 'lint', 'a-review', 'extra']);
    // A packs.json Hydra can't use throws, as a broken gates.json does: never mistaken for no packs.
    await writeFile(path.join(lead, '.hydra', 'packs.json'), JSON.stringify({ version: 1, packs: [{ id: 'alpha', on: true }] }));
    await assert.rejects(effectiveGates(lead, where, node), /unknown setting "on"/);
  } finally { await close(); }
});

test('effective gates: at most 24, and turning on a pack that would pass it is refused with the reason', () => {
  const base: GatesConfig = { source: 'gates', lanes: 'onMerge', gates: Array.from({ length: 12 }, (_, index): Gate => ({ id: `own${index}`, type: 'command', required: true, command: ['x'], timeoutSeconds: 60 })) };
  const pack = (id: string): ProjectPack => {
    const manifest: PackManifest = { version: 1, id, title: id.toUpperCase(), description: 'x', roles: [], mcpServers: {}, gates: Array.from({ length: 6 }, (_, index): Gate => ({ id: `${id}${index}`, type: 'command', required: true, command: ['x'], timeoutSeconds: 60 })) };
    return { id, title: id.toUpperCase(), state: 'on', entry: { id }, copy: path.join('C:', 'cache', id), notes: [], pack: { id, source: 'user', folder: '', hash: 'a'.repeat(64), valid: { manifest, skills: [], instructions: {}, servers: {} } } };
  };
  const combined = combineGates(base, [pack('p1'), pack('p2'), pack('p3')], 'hydra.exe');
  assert.equal(combined.gates.length, 24);
  assert.deepEqual(combined.notRun.map(result => [result.id, result.pack, result.summary]), Array.from({ length: 6 }, (_, index) => [`p3${index}`, 'p3', 'Not run: the project would have more than 24 gates.']));
  assert.equal(overGateCap(base, [pack('p1'), pack('p2')], pack('p3')), 'Turning on the P3 pack would give this project 30 gates; the limit is 24.');
  assert.equal(overGateCap(base, [pack('p1')], pack('p2')), undefined);
});

test('pack gates run from the checked copy: {node} is Hydra\'s executable as Node, paths pass without a shell, and results say which pack', async () => {
  const { root, close } = await tempRoot();
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    const repo = path.join(root, 'repo'), worktree = path.join(root, 'head');
    await mkdir(repo, { recursive: true });
    await git(root, ['init', '-q', '-b', 'main', repo]);
    await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n'); await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
    const base = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    await git(repo, ['worktree', 'add', '-q', '-b', 'agent/x', worktree, base]);
    // Global storage with a space and a quote in its path: the argument list is passed as it is.
    const where = places(root, { allowedFile: path.join(root, 'it\'s storage', 'packs', 'allowed.json'), cacheRoot: path.join(root, 'it\'s storage', 'packs', 'cache') });
    const probe = 'console.log(`node-mode=${process.env.ELECTRON_RUN_AS_NODE} arg=${process.argv[2]} here=${require("fs").existsSync("a.txt")}`); process.exit(process.argv[2] === "one two" ? 0 : 3);\n';
    await writePack(where.user!, 'probe', smallPack('probe', 'Probe', [{ id: 'probe', type: 'command', command: ['{node}', '{pack}/scripts/probe.cjs', 'one two'] }], { 'scripts/probe.cjs': probe }));
    await writePacksFile(repo, { version: 1, packs: [{ id: 'probe' }] });
    await allowListed(repo, where, ['probe']);
    const gates = await effectiveGates(repo, where, process.execPath);
    const results = await runGateList(gates.gates, worktree, base, { author: 'claude', logDirectory: path.join(root, 'logs'), executable: async provider => `fake-${provider}` });
    assert.equal(results.length, 1);
    assert.equal(results[0]!.state, 'passed', results[0]!.outputTail);
    assert.equal(results[0]!.pack, 'probe');
    assert.match(results[0]!.outputTail, /node-mode=1 arg=one two here=true/, 'run as Node, in the worktree, with the argument intact');
  } finally {
    if (saved === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = saved;
    await close();
  }
});

// ---- Heads and lanes use the loader ----

/** A head that adds src/b.ts and calls hydra_done once, against a real repository, with the given gates loader. */
async function headDone(repo: string, root: string, gates: HelperServiceOptions['gates']) {
  const store = new JobStore(path.join(root, `jobs-${Math.random().toString(16).slice(2)}`)); await store.load();
  let resolveDone!: (value: any) => void;
  const done = new Promise<any>(resolve => { resolveDone = resolve; });
  const signal = new AbortController().signal;
  const service: HelperService = new HelperService({
    store, endpoint: { issue: () => 'x'.repeat(43), revokeJob: () => undefined, port: 1 }, leadFolder: repo, leadKey: 'window',
    worktreeRoot: () => path.join(root, 'worktrees'), executable: async provider => `fake-${provider}`, bridge: { command: 'hydra.exe', args: [] },
    logDirectory: path.join(root, 'logs'), maxConcurrent: () => 1, watchdogMs: 1000, ...(gates ? { gates } : {}),
    startRun: spec => {
      setTimeout(() => void (async () => {
        await writeFile(path.join(spec.worktree, 'src', 'b.ts'), 'export const b = 2;\n');
        resolveDone(await service.handle({ role: 'helper', leadKey: 'window', jobId: service.list()[0]!.id }, 'hydra_done', { summary: 'Added b.ts' }, signal));
      })().catch(resolveDone), 0);
      return { onTurnEnd: () => undefined, exited: new Promise(() => undefined), send: async () => true, stop: async () => undefined };
    },
  });
  try {
    await service.handle({ role: 'lead', leadKey: 'window' }, 'hydra_start_head', { title: 'Add b', brief: 'Add src/b.ts.', write_scope: ['src/'], idempotency_key: `b-${Math.random()}` }, signal);
    const result = await done;
    return { result, job: service.list()[0]! };
  } finally { await service.dispose(); }
}

test('head acceptance uses the packs loader: a failing pack gate sends the head back; an unallowed pack\'s gate is not run and never blocks', async () => {
  const { root, close } = await tempRoot();
  try {
    const repo = path.join(root, 'repo');
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await git(root, ['init', '-q', '-b', 'main', repo]);
    await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    const where = places(root);
    await writePack(where.user!, 'strict', smallPack('strict', 'Strict', [{ id: 'strict-check', type: 'command', command: ['{node}', '{pack}/fail.cjs'], timeoutSeconds: 60 }], { 'fail.cjs': 'console.log("the strict pack says no"); process.exit(1);\n' }));
    await writePacksFile(repo, { version: 1, packs: [{ id: 'strict' }] });
    await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
    const loader = (folder: string) => effectiveGates(folder, where, process.execPath);

    const unallowed = await headDone(repo, root, loader);
    assert.equal(unallowed.result.accepted, true, unallowed.result.message);
    assert.deepEqual(unallowed.job.result!.checks.map(check => [check.id, check.state, check.pack, check.summary]), [['strict-check', 'notRun', 'strict', 'The Strict pack isn\'t allowed on this machine yet.']]);

    await allowListed(repo, where, ['strict']);
    const allowed = await headDone(repo, root, loader);
    assert.equal(allowed.result.accepted, false);
    assert.match(allowed.result.message, /These gates failed:\n- strict-check \(command, exit 1\)/);
    assert.match(allowed.result.message, /the strict pack says no/);
  } finally { await close(); }
});

test('lane gates use the packs loader: a lane merge runs the active pack\'s gates and reports an inactive one as not run', async () => {
  const { root, close } = await tempRoot();
  try {
    const repo = path.join(root, 'repo');
    await mkdir(repo, { recursive: true });
    await git(root, ['init', '-q', '-b', 'main', repo]);
    await git(repo, ['config', 'user.email', 'test@example.invalid']); await git(repo, ['config', 'user.name', 'Test']);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    const where = places(root);
    await writePack(where.user!, 'good', smallPack('good', 'Good', [{ id: 'good-check', type: 'command', command: ['{node}', '{pack}/ok.cjs'] }], { 'ok.cjs': 'process.exit(0);\n' }));
    await writePack(where.user!, 'later', smallPack('later', 'Later', [{ id: 'later-check', type: 'command', command: ['{node}', '{pack}/ok.cjs'] }], { 'ok.cjs': 'process.exit(0);\n' }));
    await writePacksFile(repo, { version: 1, packs: [{ id: 'good' }, { id: 'later' }] });
    await git(repo, ['add', '.']); await git(repo, ['commit', '-qm', 'init']);
    await allowListed(repo, where, ['good']);
    const store = new LaneStore(path.join(root, 'store')); await store.load();
    const service = new LaneService({
      store, repository: repo, worktreeRoot: () => undefined, pty: fakePtyModule(),
      executable: async () => 'true', connected: async () => true, bridge: () => ({ command: 'node', args: [], env: {} }),
      helpersDir: path.join(root, 'helpers'), configDirectory: path.join(root, 'cfg'), testCommand: () => 'true',
      gatesExecutable: async provider => `fake-${provider}`, gatesLogDirectory: path.join(root, 'gateslogs'),
      gates: folder => effectiveGates(folder, where, process.execPath),
    });
    try {
      const lane = await service.create({ name: 'Lane 1', provider: 'claude' });
      const outcome = await service.runGates(lane.id);
      assert.deepEqual(outcome.results.map(result => [result.id, result.state, result.pack]), [['good-check', 'passed', 'good'], ['later-check', 'notRun', 'later']]);
      assert.deepEqual(outcome.failed, []);
      assert.equal(service.get(lane.id)!.lastGates!.results.length, 2);
    } finally { await service.dispose(); }
  } finally { await close(); }
});

// ---- The service's writes ----

test('the pack service: turning on needs the hash you reviewed; skip in this project refuses a gate the pack doesn\'t have', async () => {
  const { root, close } = await tempRoot();
  try {
    const lead = path.join(root, 'lead');
    const service = new PackService({ builtin: path.resolve('packs'), userFolder: () => path.join(root, 'user'), storage: path.join(root, 'storage', 'packs'), version: '0.24.0', nodeExecutable: 'hydra.exe' });
    const coding = (await service.state(lead)).packs.find(pack => pack.id === 'coding')!;
    assert.equal(coding.state, 'off');
    await assert.rejects(service.turnOn(lead, 'coding', 'f'.repeat(64)), /changed while you were reviewing it/);
    await assert.rejects(readFile(path.join(lead, '.hydra', 'packs.json')), 'nothing is written when the OK is refused');
    await service.turnOn(lead, 'coding', coding.pack!.hash!);
    assert.equal(await readFile(path.join(lead, '.hydra', 'packs.json'), 'utf8'), '{\n  "version": 1,\n  "packs": [\n    {\n      "id": "coding"\n    }\n  ]\n}\n');
    assert.equal((await service.state(lead)).packs[0]!.state, 'on');
    assert.deepEqual((await service.effectiveGates(lead)).gates.map(gate => [gate.id, gate.pack]), [['code-review', 'coding']]);
    await assert.rejects(service.skipGate(lead, 'coding', 'nope', true), /The Coding pack has no gate "nope"/);
    await service.skipGate(lead, 'coding', 'code-review', true);
    assert.deepEqual((await service.effectiveGates(lead)).dropped, [{ id: 'code-review', pack: 'coding', reason: 'Skipped in this project.' }]);
    await service.setEnabled(lead, 'coding', false);
    assert.equal((await service.state(lead)).packs.find(pack => pack.id === 'coding')!.state, 'off');
    await assert.rejects(service.setEnabled(lead, 'ghost', true), /There's no usable pack "ghost"/);
  } finally { await close(); }
});

test('a pack review gate\'s role reaches the reviewer\'s prompt, and pack reaches the head\'s check view', () => {
  const prompt = reviewPrompt({ provider: 'codex', title: 'Add the facts', baseCommit: 'a'.repeat(40), diff: { text: '+ claim', cut: false }, earlier: [], screenshots: [], focus: 'Every claim has a source.', role: { title: 'Fact-checker (Research pack)', instructions: 'Check each claim against its source.\n' } });
  assert.match(prompt, /## Your role: Fact-checker \(Research pack\)\nCheck each claim against its source\.\n\nYou still only read; the reply below is what counts\.\n\n## What to focus on\nEvery claim has a source\./);
  assert.doesNotMatch(reviewPrompt({ provider: 'codex', baseCommit: 'a'.repeat(40), diff: { text: '', cut: false }, earlier: [], screenshots: [], focus: '' }), /Your role/);
  const view = toHeadCheckView({ id: 'code-review', required: true, passed: true, exitCode: 0, durationMs: 1, outputTail: '', kind: 'review', state: 'passed', pack: 'coding', packTitle: 'Coding' });
  assert.deepEqual([view.pack, view.packTitle], ['coding', 'Coding']);
  assert.equal('pack' in toHeadCheckView({ id: 'unit', required: true, passed: true, exitCode: 0, durationMs: 1, outputTail: '' }), false);
  assert.equal(gateChip({ ...view, summary: 'No findings.' }).title, 'No findings. · From the Coding pack', 'a pack gate\'s chip names the pack by its title');
});

test('cache: heads finishing at once share one copy; none removes another\'s', async () => {
  const { root, close } = await tempRoot();
  try {
    const cacheRoot = path.join(root, 'cache'), files = seoFiles(), hash = packHash(files);
    const copies = await Promise.all(Array.from({ length: 4 }, () => ensureCached(cacheRoot, { id: 'seo', hash, files })));
    assert.equal(new Set(copies).size, 1);
    assert.equal((await readPackFolder(copies[0]!)).hash, hash);
    assert.deepEqual(await readdir(cacheRoot), [cacheName('seo', hash)]);
  } finally { await close(); }
});

test('reused lane gates: a pack whose gates won\'t run changes the fingerprint, and the note names gates that didn\'t run', () => {
  const config: GatesConfig = { source: 'gates', lanes: 'onMerge', gates: [] };
  const skipped = { id: 'seo:meta', title: 'meta', state: 'notRun' } as any;
  assert.notEqual(gatesFingerprint({ ...config, notRun: [skipped] }), gatesFingerprint(config));
  assert.equal(gatesFingerprint({ ...config, notRun: [] }), gatesFingerprint(config));
  const passed = { id: 'unit', title: 'unit', state: 'passed' } as any;
  assert.equal(gatesPassNote([passed]), ' Gates passed.');
  assert.equal(gatesPassNote([passed, skipped], ' on abc1234'), ' Gates passed on abc1234; not run: seo:meta.');
  assert.equal(gatesPassNote([skipped]), ' Gates not run: seo:meta.');
});
