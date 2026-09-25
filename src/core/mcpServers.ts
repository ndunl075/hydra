import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { eolOf, providerPaths, read, removeCodexBlock, removeMarkedBlock, runClaude, serverName as hydraServerName, writeAtomic } from './helperRegistration';
import { processLaunch, terminateProcessTree } from './process';

/**
 * The user's own MCP servers for Claude Code and Codex, managed from Hydra
 * Settings (docs/Settings_And_Connectors_Plan.md, "MCP servers").
 *
 * Config safety, the rules this module keeps:
 * - Claude: read-only parse of `~/.claude.json` (`mcpServers`, user scope).
 *   Every change goes through Claude's own CLI (`claude mcp add-json` /
 *   `claude mcp remove`, scope `user`); Hydra never writes that file.
 * - Codex: `~/.codex/config.toml` is only ever appended to, one marked block per
 *   server (`# >>> Hydra MCP: <name>` … `# <<< Hydra MCP: <name>`), in the
 *   file's own line endings. Removing cuts exactly that block out again, so the
 *   file is byte-identical to before the add. A server Hydra didn't add is never
 *   edited, reformatted or removed: it is listed read-only.
 * - Before writing, the new text is parsed back and must contain exactly the
 *   server that was asked for, and removing the block must give back the old
 *   text byte for byte. A config Hydra can't parse is never written.
 * - Adding to both agents is all-or-nothing: if Claude refuses, the Codex block
 *   just written is taken out again.
 * - Secrets stay where each agent keeps them. Hydra stores no copy, and the list
 *   it hands to the UI has token-like values masked.
 * - Hydra's own `hydra` server is locked here (it's managed on Connectors).
 */
export type McpAgent = 'claude' | 'codex';
export const mcpAgents: readonly McpAgent[] = ['claude', 'codex'];
export interface McpStdioSpec { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
/** `sse` is Claude's legacy transport: listed, but Codex can't use it and Test doesn't speak it. */
export interface McpHttpSpec { type: 'http' | 'sse'; url: string; headers: Record<string, string>; bearerTokenEnvVar?: string }
export type McpServerSpec = McpStdioSpec | McpHttpSpec;

export interface McpAgentConfig {
  /** Undefined when the entry couldn't be understood (see `problem`). Masked in list results unless `reveal`. */
  spec?: McpServerSpec;
  problem?: string;
  /** The file this entry lives in. */
  source: string;
  /** Codex: inside a Hydra MCP block (or Hydra's own helper block). Claude has no markers, so always false. */
  managedByHydra: boolean;
  /** Whether Hydra can remove it for this agent; if not, `readOnlyReason` says why. */
  removable: boolean;
  readOnlyReason?: string;
  /** Codex `enabled = false` turns a server off without deleting it. */
  enabled: boolean;
  /** Config keys Hydra shows but doesn't model (Codex `env_vars`, `cwd`, timeouts, …); not copied to the other agent. */
  extras: string[];
}
export interface McpServerEntry {
  name: string;
  agents: Partial<Record<McpAgent, McpAgentConfig>>;
  /** The Claude spec if there is one, else Codex's. */
  spec?: McpServerSpec;
  /** True when the two agents' specs differ. */
  differs: boolean;
  /** Hydra's own server: shown, never edited here. */
  locked: boolean;
}
export interface McpServerList {
  servers: McpServerEntry[];
  /** A file that couldn't be read or parsed; that agent's servers are missing from `servers`. */
  errors: Partial<Record<McpAgent, string>>;
  paths: { claude: string; codex: string };
  /** Whether a Claude CLI was found to make changes with. */
  claudeCliAvailable: boolean;
}

export type ClaudeRunner = (executable: string, args: string[]) => Promise<{ code: number; output: string }>;
/** Everything that touches the machine, injectable so tests never see the real home folder. */
export interface McpContext {
  claudeJson: string;
  codexConfig: string;
  /** The Claude CLI used for add/remove; undefined when none is installed. */
  claudeExecutable?: string;
  runClaude?: ClaudeRunner;
}
export function defaultMcpContext(claudeExecutable?: string, env: NodeJS.ProcessEnv = process.env): McpContext {
  const paths = providerPaths(env);
  return { claudeJson: paths.claudeJson, codexConfig: paths.codexConfig, claudeExecutable };
}

const agentLabel = (agent: McpAgent) => agent === 'claude' ? 'Claude Code' : 'Codex';

// ---- Validation ----

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function validateServerName(name: unknown): string {
  if (typeof name !== 'string' || !namePattern.test(name)) throw new Error('A server name uses letters, digits, "-" and "_" (up to 64), starting with a letter or digit.');
  if (name.toLowerCase() === hydraServerName) throw new Error('"hydra" is Hydra\'s own server. Manage it on the Connectors page.');
  return name;
}
const stringRecord = (value: unknown, what: string, key: RegExp, keyWhat: string, valueCheck: (text: string) => boolean): Record<string, string> => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be a set of names and values.`);
  const result: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!key.test(name)) throw new Error(`${what}: "${name}" isn't a valid ${keyWhat}.`);
    if (typeof entry !== 'string' || !valueCheck(entry)) throw new Error(`${what}: the value of "${name}" must be text on one line.`);
    result[name] = entry;
  }
  return result;
};
const noNul = (text: string) => !text.includes('\0');
const oneLine = (text: string) => !/[\0\r\n]/.test(text);
/** A clean copy of a spec from the UI (unknown input), or a user-readable error. */
export function validateServerSpec(input: unknown): McpServerSpec {
  if (!input || typeof input !== 'object') throw new Error('Choose a command (stdio) or a URL (HTTP) for the server.');
  const spec = input as Record<string, unknown>;
  if (spec.type === 'stdio') {
    if (typeof spec.command !== 'string' || !spec.command.trim() || !oneLine(spec.command)) throw new Error('Enter the command that starts the server.');
    const args = spec.args ?? [];
    if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string' || !noNul(arg))) throw new Error('Arguments must be a list of text values.');
    return { type: 'stdio', command: spec.command.trim(), args: [...args] as string[], env: stringRecord(spec.env, 'Environment', envKeyPattern, 'variable name', noNul) };
  }
  if (spec.type === 'http' || spec.type === 'sse') {
    let url: URL;
    try { url = new URL(String(spec.url ?? '').trim()); } catch { throw new Error('Enter the server\'s full URL, starting with https://.'); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The server URL must start with https:// or http://.');
    const result: McpHttpSpec = { type: spec.type, url: String(spec.url).trim(), headers: stringRecord(spec.headers, 'Headers', headerNamePattern, 'header name', oneLine) };
    if (spec.bearerTokenEnvVar !== undefined && spec.bearerTokenEnvVar !== '') {
      if (typeof spec.bearerTokenEnvVar !== 'string' || !envKeyPattern.test(spec.bearerTokenEnvVar)) throw new Error('The bearer token variable must be an environment variable name.');
      result.bearerTokenEnvVar = spec.bearerTokenEnvVar;
    }
    return result;
  }
  throw new Error('The server type must be "stdio" or "http".');
}

// ---- Secrets ----

const secretKeyPattern = /token|secret|passw|api[-_]?key|apikey|auth(?!or)|credential|private[-_]?key|access[-_]?key|client[-_]?key|session|cookie|bearer|signature|(^|[-_])key($|[-_])/i;
const secretPrefixPattern = /^(sk-|sk_|pk_live_|rk_live_|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|glpat-|xox[abprs]-|AKIA|ASIA|AIza|ya29\.|npm_|pypi-|hf_|shpat_|SG\.|lin_api_|eyJ)/;
/**
 * Whether a value should be masked: by its key (TOKEN, KEY, SECRET, PASSWORD,
 * AUTH, …) or by its shape (known token prefixes, "Bearer …", long random
 * strings). An environment-variable reference like `${GITHUB_TOKEN}` is not a secret.
 */
export function looksLikeSecret(key: string | undefined, value: string): boolean {
  if (!value || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/.test(value)) return false;
  if (key && secretKeyPattern.test(key)) return true;
  const bare = value.replace(/^(Bearer|Basic|token)\s+/i, '');
  if (bare !== value) return bare.length >= 8;
  if (secretPrefixPattern.test(bare) && bare.length >= 12) return true;
  return bare.length >= 24 && /^[A-Za-z0-9_\-+=]+$/.test(bare) && /\d/.test(bare) && /[A-Za-z]/.test(bare) && !/^\d[\d-]*$/.test(bare);
}
const masked = (value: string) => value.length >= 16 ? `••••${value.slice(-4)}` : '••••••••';
/** The value to show for a key/value pair: unchanged, or masked (an auth scheme word like "Bearer " is kept). */
export function maskSecret(key: string | undefined, value: string): string {
  if (!looksLikeSecret(key, value)) return value;
  const scheme = /^(Bearer|Basic|token)\s+/i.exec(value)?.[0] ?? '';
  return scheme + masked(value.slice(scheme.length));
}
function maskArgs(args: string[]): string[] {
  return args.map((arg, index) => {
    const previous = index > 0 ? args[index - 1] ?? '' : '';
    if (/^--?[A-Za-z]/.test(previous) && !previous.includes('=') && secretKeyPattern.test(previous) && !arg.startsWith('-')) return masked(arg);
    const pair = /^(--?[A-Za-z][\w.-]*|[A-Za-z_][\w.-]*)=(.*)$/s.exec(arg);
    if (pair) return `${pair[1]}=${maskSecret(pair[1], pair[2] ?? '')}`;
    return maskSecret(undefined, arg);
  });
}
function maskUrl(text: string): string {
  let url: URL;
  try { url = new URL(text); } catch { return text; }
  let changed = false;
  if (url.password) { url.password = 'hidden'; changed = true; }
  for (const [key, value] of [...url.searchParams]) {
    const shown = maskSecret(key, value);
    if (shown !== value) { url.searchParams.set(key, shown); changed = true; }
  }
  return changed ? url.toString() : text;
}
const maskRecord = (record: Record<string, string>) => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, maskSecret(key, value)]));
/** A copy of the spec with token-like env values, headers, arguments and URL parts masked. */
export function maskSpec(spec: McpServerSpec): McpServerSpec {
  return spec.type === 'stdio'
    ? { type: 'stdio', command: spec.command, args: maskArgs(spec.args), env: maskRecord(spec.env) }
    : { ...spec, url: maskUrl(spec.url), headers: maskRecord(spec.headers) };
}

// ---- A small TOML reader (enough to find and read [mcp_servers.*] safely) ----

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }
/**
 * Parse TOML 1.0 (plus 1.1's newlines in inline tables and \e / \x escapes).
 * Dates and odd numbers (hex, inf, …) come back as their raw text. Throws with
 * a line number on anything malformed, including redefined keys and tables, so a
 * config that would stop Codex from starting is never written.
 */
export function parseToml(text: string): TomlTable {
  let at = 0;
  const root: TomlTable = {};
  const frozen = new WeakSet<object>(), defined = new WeakSet<object>(), tableArrays = new WeakSet<object>();
  const fail = (message: string): never => { throw new Error(`Line ${text.slice(0, at).split('\n').length}: ${message}`); };
  const skipSpace = () => { while (text[at] === ' ' || text[at] === '\t') at++; };
  const skipComment = () => { if (text[at] === '#') { while (at < text.length && text[at] !== '\n') { if (/[\0-\x08\x0a-\x1f\x7f]/.test(text[at] ?? '') && !(text[at] === '\r' && text[at + 1] === '\n')) fail('Control character in a comment.'); at++; } } };
  const skipBlank = () => { for (;;) { skipSpace(); skipComment(); if (text[at] === '\n') at++; else if (text[at] === '\r' && text[at + 1] === '\n') at += 2; else return; } };
  const endOfLine = () => { skipSpace(); skipComment(); if (at >= text.length) return; if (text[at] === '\n') { at++; return; } if (text[at] === '\r' && text[at + 1] === '\n') { at += 2; return; } fail('Expected the end of the line.'); };
  const escape = (): string => {
    const letter = text[at++] ?? '';
    const simple: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };
    if (letter in simple) return simple[letter]!;
    const width = letter === 'u' ? 4 : letter === 'U' ? 8 : letter === 'x' ? 2 : 0;
    if (!width) fail(`Unknown escape \\${letter}.`);
    const hex = text.slice(at, at + width);
    if (!new RegExp(`^[0-9A-Fa-f]{${width}}$`).test(hex)) fail('Bad unicode escape.');
    at += width;
    const code = parseInt(hex, 16);
    if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail('Bad unicode escape.');
    return String.fromCodePoint(code);
  };
  const string = (): string => {
    const quote = text[at] ?? '"';
    const multi = text.startsWith(quote.repeat(3), at);
    at += multi ? 3 : 1;
    if (multi) { if (text[at] === '\n') at++; else if (text[at] === '\r' && text[at + 1] === '\n') at += 2; }
    let value = '';
    for (;;) {
      if (at >= text.length) fail('Unterminated string.');
      const char = text[at] ?? '';
      if (char === quote) {
        if (!multi) { at++; return value; }
        let run = 0; while (text[at + run] === quote) run++;
        if (run >= 3) { if (run > 5) fail('Too many quotes.'); value += quote.repeat(run - 3); at += run; return value; }
        value += quote.repeat(run); at += run; continue;
      }
      if (char === '\\' && quote === '"') {
        at++;
        if (multi && /^[ \t]*\r?\n/.test(text.slice(at))) { while (/[ \t\r\n]/.test(text[at] ?? '')) at++; continue; }
        value += escape(); continue;
      }
      if (char === '\n' || (char === '\r' && text[at + 1] === '\n')) { if (!multi) fail('Line break in a string.'); }
      else if (/[\0-\x08\x0a-\x1f\x7f]/.test(char) && char !== '\t') fail('Control character in a string.');
      value += char; at++;
    }
  };
  const keyPart = (): string => {
    if (text[at] === '"' || text[at] === "'") { if (text.startsWith(text[at]!.repeat(3), at)) fail('A key can\'t be a multi-line string.'); return string(); }
    const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(at, at + 256))?.[0];
    if (!bare) fail('Expected a key.');
    at += bare!.length; return bare!;
  };
  const key = (): string[] => { const parts = [keyPart()]; for (;;) { skipSpace(); if (text[at] !== '.') return parts; at++; skipSpace(); parts.push(keyPart()); } };
  const isTable = (value: TomlValue | undefined): value is TomlTable => !!value && typeof value === 'object' && !Array.isArray(value);
  const value = (): TomlValue => {
    const char = text[at];
    if (char === '"' || char === "'") return string();
    if (char === '[') {
      at++; const items: TomlValue[] = [];
      for (;;) { skipBlank(); if (text[at] === ']') { at++; frozen.add(items); return items; } items.push(value()); skipBlank(); if (text[at] === ',') { at++; continue; } if (text[at] === ']') { at++; frozen.add(items); return items; } fail('Expected "," or "]" in an array.'); }
    }
    if (char === '{') {
      at++; const table: TomlTable = {};
      skipBlank(); if (text[at] === '}') { at++; frozen.add(table); return table; }
      for (;;) { skipBlank(); assign(table, key()); skipBlank(); if (text[at] === ',') { at++; skipBlank(); if (text[at] === '}') { at++; frozen.add(table); return table; } continue; } if (text[at] === '}') { at++; frozen.add(table); return table; } fail('Expected "," or "}" in an inline table.'); }
    }
    const raw = /^(?:true|false|[-+0-9A-Za-z_.:]+(?: (?=\d\d:)[0-9:.Z+-]+)?)/.exec(text.slice(at, at + 128))?.[0];
    if (!raw) fail('Expected a value.');
    at += raw!.length;
    if (raw === 'true' || raw === 'false') return raw === 'true';
    if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(raw!)) return Number(raw!.replace(/_/g, ''));
    if (!/^([+-]?(0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|inf|nan)|\d{4}-\d\d-\d\d([Tt ][0-9:.]+)?([Zz]|[+-]\d\d:\d\d)?|\d\d:\d\d(:\d\d(\.\d+)?)?)$/.test(raw!)) fail(`"${raw}" isn't a TOML value.`);
    return raw!;
  };
  const descend = (table: TomlTable, part: string): TomlTable => {
    const existing = table[part];
    if (existing === undefined) { const created: TomlTable = {}; table[part] = created; return created; }
    if (Array.isArray(existing) && tableArrays.has(existing)) return existing[existing.length - 1] as TomlTable;
    if (!isTable(existing) || frozen.has(existing)) fail(`"${part}" is already a value.`);
    return existing as TomlTable;
  };
  function assign(table: TomlTable, parts: string[]): void {
    skipSpace(); if (text[at] !== '=') fail('Expected "=".'); at++; skipSpace();
    let target = table;
    for (const part of parts.slice(0, -1)) target = descend(target, part);
    const last = parts[parts.length - 1]!;
    if (Object.hasOwn(target, last)) fail(`"${parts.join('.')}" is defined twice.`);
    target[last] = value();
  }
  let current = root;
  for (;;) {
    skipBlank();
    if (at >= text.length) return root;
    if (text[at] === '[') {
      const array = text[at + 1] === '[';
      at += array ? 2 : 1; skipSpace();
      const parts = key(); skipSpace();
      if (!text.startsWith(array ? ']]' : ']', at)) fail('Expected "]".');
      at += array ? 2 : 1;
      let parent = root;
      for (const part of parts.slice(0, -1)) parent = descend(parent, part);
      const last = parts[parts.length - 1]!;
      if (array) {
        const existing = parent[last] ?? [];
        if (!Array.isArray(existing) || (parent[last] !== undefined && !tableArrays.has(existing))) fail(`"${parts.join('.')}" is already a value.`);
        const list = existing as TomlValue[]; tableArrays.add(list); parent[last] = list;
        current = {}; list.push(current);
      } else {
        const existing = parent[last];
        if (existing !== undefined && (!isTable(existing) || frozen.has(existing) || defined.has(existing))) fail(`Table [${parts.join('.')}] is defined twice.`);
        current = (existing as TomlTable | undefined) ?? {};
        parent[last] = current; defined.add(current);
      }
      endOfLine(); continue;
    }
    assign(current, key());
    endOfLine();
  }
}

// ---- TOML writing (only what Hydra's blocks need) ----

/** A TOML basic string: quotes, backslashes and control characters escaped; other Unicode written as is. */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '"') out += '\\"';
    else if (char === '\\') out += '\\\\';
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (char === '\b') out += '\\b';
    else if (char === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0').toUpperCase()}`;
    else out += char;
  }
  return out + '"';
}
export const tomlKey = (key: string) => /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);

const codexStart = (name: string) => `# >>> Hydra MCP: ${name}`;
const codexEnd = (name: string) => `# <<< Hydra MCP: ${name}`;
const codexNote = '# Added by Hydra. Remove it in Hydra Settings > MCP servers; Hydra never edits the rest of this file.';
/** Hydra's block for one server, lines joined with `eol`, starting and ending with a line break. */
export function codexServerBlock(name: string, spec: McpServerSpec, eol = '\n'): string {
  validateServerName(name);
  const table = `mcp_servers.${name}`;
  const lines = ['', codexStart(name), codexNote, `[${table}]`];
  const subtable = (suffix: string, record: Record<string, string>) => {
    if (!Object.keys(record).length) return;
    lines.push('', `[${table}.${suffix}]`, ...Object.entries(record).map(([key, value]) => `${tomlKey(key)} = ${tomlString(value)}`));
  };
  if (spec.type === 'stdio') {
    lines.push(`command = ${tomlString(spec.command)}`, `args = [${spec.args.map(tomlString).join(', ')}]`);
    subtable('env', spec.env);
  } else {
    if (spec.type !== 'http') throw new Error('Codex supports stdio and streamable HTTP servers, not SSE.');
    lines.push(`url = ${tomlString(spec.url)}`);
    if (spec.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${tomlString(spec.bearerTokenEnvVar)}`);
    subtable('http_headers', spec.headers);
  }
  lines.push(codexEnd(name), '');
  return lines.join(eol);
}
const damagedBlock = (name: string) => `Hydra's block for "${name}" in the Codex config is damaged. Remove the lines between the "Hydra MCP: ${name}" markers by hand.`;
/** The names of the servers inside Hydra MCP blocks. */
export function hydraCodexBlocks(text: string): string[] {
  return [...text.matchAll(/^# >>> Hydra MCP: ([A-Za-z0-9][A-Za-z0-9_-]*)\r?$/gm)].map(match => match[1]!);
}
function codexServersTable(parsed: TomlTable): TomlTable {
  const servers = parsed.mcp_servers;
  return servers && typeof servers === 'object' && !Array.isArray(servers) ? servers : {};
}
/**
 * `text` with a Hydra block for the server appended. Throws, changing nothing,
 * if Codex already has a server by that name (Hydra's or the user's), if the
 * file doesn't parse, or if the result wouldn't read back as exactly this server.
 */
export function addCodexServer(text: string, name: string, spec: McpServerSpec): string {
  validateServerName(name);
  let parsed: TomlTable;
  try { parsed = parseToml(text); } catch (error) { throw new Error(`Hydra can't read your Codex config, so it won't change it. ${(error as Error).message}`); }
  if (Object.hasOwn(codexServersTable(parsed), name)) {
    throw new Error(hydraCodexBlocks(text).includes(name) ? `"${name}" is already set up for Codex.` : `Your Codex config already has an MCP server named "${name}" that Hydra didn't add. Choose another name.`);
  }
  if (hydraCodexBlocks(text).includes(name)) throw new Error(damagedBlock(name));
  const updated = text + codexServerBlock(name, spec, eolOf(text || '\n'));
  // Belt and braces: the result must parse, hold exactly this server, and come apart byte-exactly.
  let reread: McpAgentConfig | undefined;
  try { reread = readCodexServers(updated, '').get(name); } catch (error) { throw new Error(`Adding "${name}" would break your Codex config, so Hydra didn't. ${(error as Error).message}`); }
  if (!reread?.spec || JSON.stringify(reread.spec) !== JSON.stringify(normalised(spec))) throw new Error(`Hydra couldn't write "${name}" to the Codex config safely, so it didn't.`);
  if (removeCodexServer(updated, name).text !== text) throw new Error(`Hydra couldn't write "${name}" to the Codex config safely, so it didn't.`);
  return updated;
}
/**
 * `text` without Hydra's block for the server: the byte-exact inverse of
 * addCodexServer. A server Hydra didn't add is refused, never edited.
 */
export function removeCodexServer(text: string, name: string): { text: string; had: boolean } {
  const removed = removeMarkedBlock(text, codexStart(name), codexEnd(name), damagedBlock(name));
  if (removed.had) return removed;
  let exists = false;
  try { exists = Object.hasOwn(codexServersTable(parseToml(text)), name); } catch { /* an unreadable file: nothing Hydra added is in it */ }
  if (exists) throw new Error(`Hydra didn't add "${name}" to Codex, so it won't edit it. Remove it from Codex's config.toml yourself.`);
  return removed;
}
const normalised = (spec: McpServerSpec): McpServerSpec => spec.type === 'stdio'
  ? { type: 'stdio', command: spec.command, args: spec.args, env: spec.env }
  : { type: spec.type, url: spec.url, headers: spec.headers, ...(spec.bearerTokenEnvVar ? { bearerTokenEnvVar: spec.bearerTokenEnvVar } : {}) };

const codexModelled = new Set(['command', 'args', 'env', 'url', 'http_headers', 'bearer_token_env_var', 'enabled']);
const asStrings = (value: TomlValue | undefined): Record<string, string> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : JSON.stringify(entry)])) : undefined;
/** Codex's servers from config.toml text (raw values). Throws if the file doesn't parse. */
export function readCodexServers(text: string, source: string): Map<string, McpAgentConfig> {
  const servers = codexServersTable(parseToml(text));
  const managed = new Set(hydraCodexBlocks(text));
  const hydraHelpers = removeCodexBlock(text).had;
  const result = new Map<string, McpAgentConfig>();
  for (const [name, raw] of Object.entries(servers)) {
    const isHydra = name === hydraServerName;
    const hydraAdded = isHydra ? hydraHelpers : managed.has(name);
    const entry: McpAgentConfig = {
      source, managedByHydra: hydraAdded, removable: hydraAdded && !isHydra, enabled: true, extras: [],
      ...(isHydra ? { readOnlyReason: 'Hydra\'s own server. Connect or disconnect it on the Connectors page.' } : hydraAdded ? {} : { readOnlyReason: 'Added outside Hydra. Hydra never edits servers it didn\'t add to Codex\'s config.toml.' }),
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { result.set(name, { ...entry, problem: 'Not a server table.' }); continue; }
    if (raw.enabled === false) entry.enabled = false;
    entry.extras = Object.keys(raw).filter(key => !codexModelled.has(key));
    if (typeof raw.command === 'string') {
      const args = Array.isArray(raw.args) ? raw.args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)) : [];
      entry.spec = { type: 'stdio', command: raw.command, args, env: asStrings(raw.env) ?? {} };
    } else if (typeof raw.url === 'string') {
      const spec: McpHttpSpec = { type: 'http', url: raw.url, headers: asStrings(raw.http_headers) ?? {} };
      if (typeof raw.bearer_token_env_var === 'string') spec.bearerTokenEnvVar = raw.bearer_token_env_var;
      entry.spec = spec;
    } else entry.problem = 'It has neither a command nor a url.';
    result.set(name, entry);
  }
  return result;
}

// ---- Claude ----

/** Claude's user-level servers from ~/.claude.json text (top-level `mcpServers`). */
export function readClaudeServers(text: string | undefined, source: string): Map<string, McpAgentConfig> {
  const result = new Map<string, McpAgentConfig>();
  if (!text?.trim()) return result;
  const parsed = JSON.parse(text) as { mcpServers?: unknown };
  const servers = parsed.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers as Record<string, unknown> : {};
  for (const [name, raw] of Object.entries(servers)) {
    const isHydra = name === hydraServerName;
    const entry: McpAgentConfig = { source, managedByHydra: isHydra, removable: !isHydra, enabled: true, extras: [], ...(isHydra ? { readOnlyReason: 'Hydra\'s own server. Connect or disconnect it on the Connectors page.' } : {}) };
    const server = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const strings = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : JSON.stringify(entry)])) : {};
    const type = typeof server.type === 'string' ? server.type : typeof server.url === 'string' ? 'http' : 'stdio';
    entry.extras = Object.keys(server).filter(key => !['type', 'command', 'args', 'env', 'url', 'headers'].includes(key));
    if ((type === 'stdio') && typeof server.command === 'string') entry.spec = { type: 'stdio', command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: strings(server.env) };
    else if ((type === 'http' || type === 'sse') && typeof server.url === 'string') entry.spec = { type, url: server.url, headers: strings(server.headers) };
    else entry.problem = `Hydra doesn't understand this server's "${type}" setup.`;
    result.set(name, entry);
  }
  return result;
}
/** The `claude mcp add-json` arguments for a server (an argument array: no shell ever sees them). */
export function claudeAddJsonArgs(name: string, spec: McpServerSpec): string[] {
  validateServerName(name);
  if (spec.type !== 'stdio' && spec.bearerTokenEnvVar) throw new Error('Claude Code takes the token itself as an Authorization header, not a variable name.');
  const json = spec.type === 'stdio'
    ? { type: 'stdio', command: spec.command, args: spec.args, env: spec.env }
    : { type: spec.type, url: spec.url, headers: spec.headers };
  return ['mcp', 'add-json', '-s', 'user', name, JSON.stringify(json)];
}
export const claudeRemoveArgs = (name: string) => ['mcp', 'remove', '-s', 'user', validateServerName(name)];
function claudeCli(context: McpContext): { executable: string; run: ClaudeRunner } {
  if (!context.claudeExecutable) throw new Error('Install the Claude Code extension or CLI first; Hydra changes Claude\'s servers through it.');
  return { executable: context.claudeExecutable, run: context.runClaude ?? runClaude };
}
const cliOutput = (output: string) => output.trim().slice(0, 300) || 'no details';

// ---- List / add / remove ----

interface RawServers { claude: Map<string, McpAgentConfig>; codex: Map<string, McpAgentConfig>; errors: Partial<Record<McpAgent, string>>; codexText?: string }
async function readAll(context: McpContext): Promise<RawServers> {
  const errors: Partial<Record<McpAgent, string>> = {};
  let claude = new Map<string, McpAgentConfig>(), codex = new Map<string, McpAgentConfig>(), codexText: string | undefined;
  try { claude = readClaudeServers(await read(context.claudeJson), context.claudeJson); }
  catch (error) { errors.claude = `Couldn't read ${context.claudeJson}: ${(error as Error).message}`; }
  try { codexText = await read(context.codexConfig) ?? ''; codex = readCodexServers(codexText, context.codexConfig); }
  catch (error) { errors.codex = `Couldn't read ${context.codexConfig}: ${(error as Error).message}`; }
  return { claude, codex, errors, codexText };
}
/**
 * Every user-level server of both agents, merged by name and sorted. Secrets are
 * masked unless `reveal` (only for Hydra's own use, never sent to a webview).
 */
export async function listMcpServers(context: McpContext, options: { reveal?: boolean } = {}): Promise<McpServerList> {
  const raw = await readAll(context);
  const names = [...new Set([...raw.claude.keys(), ...raw.codex.keys()])].sort((a, b) => a.localeCompare(b));
  const show = (config: McpAgentConfig | undefined): McpAgentConfig | undefined => config && (options.reveal || !config.spec ? config : { ...config, spec: maskSpec(config.spec) });
  const servers = names.map((name): McpServerEntry => {
    const claude = raw.claude.get(name), codex = raw.codex.get(name);
    const agents: Partial<Record<McpAgent, McpAgentConfig>> = {};
    if (claude) agents.claude = show(claude);
    if (codex) agents.codex = show(codex);
    const differs = !!claude?.spec && !!codex?.spec && JSON.stringify(normalised(claude.spec)) !== JSON.stringify(normalised(codex.spec));
    return { name, agents, spec: agents.claude?.spec ?? agents.codex?.spec, differs, locked: name === hydraServerName };
  });
  return { servers, errors: raw.errors, paths: { claude: context.claudeJson, codex: context.codexConfig }, claudeCliAvailable: !!context.claudeExecutable };
}
/** The unmasked spec of a configured server (for Test and for copying to the other agent). */
export async function configuredSpec(context: McpContext, name: string, agent?: McpAgent): Promise<McpServerSpec> {
  if (agent !== undefined && !mcpAgents.includes(agent)) throw new Error('Choose Claude Code or Codex.');
  const raw = await readAll(context);
  const config = agent ? raw[agent].get(name) : raw.claude.get(name) ?? raw.codex.get(name);
  if (!config) throw new Error(`No MCP server named "${name}"${agent ? ` for ${agentLabel(agent)}` : ''}.`);
  if (!config.spec) throw new Error(`"${name}" can't be used: ${config.problem ?? 'unknown setup'}`);
  return config.spec;
}
function parseAgents(agents: unknown): McpAgent[] {
  const list = Array.isArray(agents) ? agents : [agents];
  if (!list.length || list.some(agent => agent !== 'claude' && agent !== 'codex')) throw new Error('Choose Claude Code, Codex, or both.');
  return [...new Set(list as McpAgent[])];
}
/**
 * Add a server for the chosen agents, all-or-nothing. Everything is checked
 * before anything is written; Codex is written first (it can be undone
 * byte-exactly) and taken out again if Claude then refuses.
 */
export async function addMcpServer(context: McpContext, name: unknown, specInput: unknown, agentsInput: unknown): Promise<McpAgent[]> {
  const serverName = validateServerName(name), spec = validateServerSpec(specInput), agents = parseAgents(agentsInput);
  const raw = await readAll(context);
  for (const agent of agents) {
    if (raw.errors[agent]) throw new Error(raw.errors[agent]);
    if (raw[agent].has(serverName)) throw new Error(`"${serverName}" is already set up for ${agentLabel(agent)}.`);
  }
  let codexText: string | undefined;
  if (agents.includes('codex')) codexText = addCodexServer(raw.codexText ?? '', serverName, spec);
  let claudeArgs: string[] | undefined, cli: ReturnType<typeof claudeCli> | undefined;
  if (agents.includes('claude')) { claudeArgs = claudeAddJsonArgs(serverName, spec); cli = claudeCli(context); }
  if (codexText !== undefined) await writeAtomic(context.codexConfig, codexText);
  if (claudeArgs && cli) {
    const added = await cli.run(cli.executable, claudeArgs).catch(error => ({ code: 1, output: String(error) }));
    if (added.code !== 0) {
      if (codexText !== undefined) await undoCodexAdd(context.codexConfig, serverName, codexText, raw.codexText ?? '');
      throw new Error(`Claude Code could not add "${serverName}": ${cliOutput(added.output)}`);
    }
  }
  return agents;
}
async function undoCodexAdd(file: string, name: string, written: string, original: string): Promise<void> {
  const now = await read(file) ?? '';
  // Only if nobody touched the file since; otherwise cut out just the block.
  await writeAtomic(file, now === written ? original : removeCodexServer(now, name).text);
}
/** Remove a server for one agent. Codex: only a server Hydra added. Claude: through `claude mcp remove`. */
export async function removeMcpServer(context: McpContext, name: unknown, agentInput: unknown): Promise<void> {
  const serverName = validateServerName(name), [agent] = parseAgents(agentInput);
  if (agent === 'codex') {
    const text = await read(context.codexConfig);
    if (text === undefined) return;
    const removed = removeCodexServer(text, serverName);
    if (removed.had) await writeAtomic(context.codexConfig, removed.text);
    return;
  }
  const cli = claudeCli(context);
  const result = await cli.run(cli.executable, claudeRemoveArgs(serverName));
  if (result.code !== 0 && !/not found|no .*server/i.test(result.output)) throw new Error(`Claude Code could not remove "${serverName}": ${cliOutput(result.output)}`);
}
/**
 * The per-agent toggle turned on: copy the server from the other agent (raw
 * values read from its config, so secrets never pass through the UI).
 */
export async function enableMcpServerFor(context: McpContext, name: unknown, agentInput: unknown): Promise<void> {
  const serverName = validateServerName(name), [agent] = parseAgents(agentInput);
  const spec = await configuredSpec(context, serverName, agent === 'claude' ? 'codex' : 'claude');
  await addMcpServer(context, serverName, spec, [agent]);
}

// ---- Test ----

export type McpTestResult =
  | { ok: true; toolCount: number; tools: string[]; serverName?: string; serverVersion?: string; protocolVersion?: string; durationMs: number }
  | { ok: false; error: string; stderrTail?: string; durationMs: number };
export interface McpTestOptions { timeoutMs?: number; cwd?: string; env?: NodeJS.ProcessEnv }
export const mcpProtocolVersion = '2025-06-18';
const initializeParams = { protocolVersion: mcpProtocolVersion, capabilities: {}, clientInfo: { name: 'hydra', title: 'Hydra', version: '1' } };
type JsonRpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code?: number; message?: string } };
const maxPages = 20;
const toolNames = (result: unknown): { names: string[]; cursor?: string } => {
  const value = result as { tools?: { name?: unknown }[]; nextCursor?: unknown };
  if (!Array.isArray(value?.tools)) throw new Error('The server\'s tools/list answer has no tools list.');
  return { names: value.tools.map(tool => String(tool?.name ?? '')), cursor: typeof value.nextCursor === 'string' && value.nextCursor ? value.nextCursor : undefined };
};
const rpcError = (method: string, error: JsonRpc['error']) => new Error(`The server refused ${method}: ${error?.message ?? 'unknown error'}${error?.code !== undefined ? ` (${error.code})` : ''}`);

/**
 * Start the server briefly and run MCP `initialize` → `notifications/initialized`
 * → `tools/list`. The process (tree) is always stopped and the whole test is
 * bounded by `timeoutMs`. Never throws: failures come back as `{ ok: false }`.
 */
export async function testMcpServer(spec: McpServerSpec, options: McpTestOptions = {}): Promise<McpTestResult> {
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 20_000;
  try {
    const result = spec.type === 'stdio' ? await testStdio(spec, timeoutMs, options) : spec.type === 'http' ? await testHttp(spec, timeoutMs, options.env ?? process.env) : undefined;
    if (!result) return { ok: false, error: 'Testing legacy SSE servers isn\'t supported. Check it from Claude Code with /mcp.', durationMs: Date.now() - started };
    return { ok: true, ...result, durationMs: Date.now() - started };
  } catch (error) {
    const failure = error as Error & { stderrTail?: string };
    return { ok: false, error: failure.message, ...(failure.stderrTail ? { stderrTail: failure.stderrTail } : {}), durationMs: Date.now() - started };
  }
}
type Handshake = { toolCount: number; tools: string[]; serverName?: string; serverVersion?: string; protocolVersion?: string };
function handshakeResult(init: unknown, tools: string[]): Handshake {
  const value = init as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } };
  return {
    toolCount: tools.length, tools,
    ...(typeof value?.serverInfo?.name === 'string' ? { serverName: value.serverInfo.name } : {}),
    ...(typeof value?.serverInfo?.version === 'string' ? { serverVersion: value.serverInfo.version } : {}),
    ...(typeof value?.protocolVersion === 'string' ? { protocolVersion: value.protocolVersion } : {}),
  };
}

/** Case-insensitive on Windows, like the OS: a spec's PATH replaces the inherited Path. */
export function mergeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>, platform = process.platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (platform === 'win32') for (const existing of Object.keys(result)) if (existing.toLowerCase() === key.toLowerCase()) delete result[existing];
    result[key] = value;
  }
  return result;
}
/** Windows can't spawn `npx` without its extension: find it on PATH with PATHEXT, as a shell would. */
export async function resolveCommand(command: string, env: NodeJS.ProcessEnv, platform = process.platform): Promise<string> {
  if (platform !== 'win32' || path.win32.extname(command)) return command;
  const lookup = (name: string) => Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const extensions = (lookup('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(extension => extension.toLowerCase());
  const directories = /[\\/]/.test(command) ? [''] : (lookup('PATH') || '').split(';').filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = directory ? path.win32.join(directory, command + extension) : command + extension;
      try { await access(candidate); return candidate; } catch { /* keep looking */ }
    }
  }
  return command;
}
async function testStdio(spec: McpStdioSpec, timeoutMs: number, options: McpTestOptions): Promise<Handshake> {
  const env = mergeEnv(options.env ?? process.env, spec.env);
  const executable = await resolveCommand(spec.command, env);
  const launch = processLaunch(executable, spec.args);
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn(launch.executable, launch.args, { cwd: options.cwd ?? homedir(), env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { throw new Error(`Couldn't start "${spec.command}": ${(error as Error).message}`); }
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let stderr = '', buffer = '', settled = false;
  const waiting = new Map<number, { resolve: (message: JsonRpc) => void; reject: (error: Error) => void }>();
  let failAll: (error: Error) => void = () => undefined;
  const failed = new Promise<never>((_resolve, reject) => { failAll = reject; });
  failed.catch(() => undefined);
  const fail = (error: Error) => { if (settled) return; settled = true; for (const entry of waiting.values()) entry.reject(error); failAll(error); };
  const timer = setTimeout(() => fail(new Error(`The server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  child.on('error', error => fail(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? `Command not found: ${spec.command}` : `Couldn't start "${spec.command}": ${error.message}`)));
  child.on('close', code => fail(new Error(`The server exited${code === null ? '' : ` (code ${code})`} before it finished answering.`)));
  child.stdin.on('error', () => undefined);
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => { stderr = (stderr + data).slice(-4000); });
  child.stdout.setEncoding('utf8');
  const send = (message: JsonRpc) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); };
  child.stdout.on('data', (data: string) => {
    buffer += data;
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('The server sent too much output.')); return; }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonRpc;
      try { message = JSON.parse(line) as JsonRpc; } catch { continue; /* stray log output on stdout */ }
      if (message.method && message.id !== undefined && message.id !== null) {
        // A request from the server (ping, roots/list, …): answer so it isn't left waiting.
        if (message.method === 'ping') send({ id: message.id, result: {} });
        else if (message.method === 'roots/list') send({ id: message.id, result: { roots: [] } });
        else send({ id: message.id, error: { code: -32601, message: 'Not supported by Hydra\'s test.' } });
        continue;
      }
      if (typeof message.id === 'number') { const entry = waiting.get(message.id); waiting.delete(message.id); entry?.resolve(message); }
    }
  });
  let nextId = 1;
  const request = (method: string, params: unknown): Promise<unknown> => {
    const id = nextId++;
    const answer = new Promise<JsonRpc>((resolve, reject) => waiting.set(id, { resolve, reject }));
    send({ id, method, params });
    return Promise.race([answer, failed]).then(message => { if (message.error) throw rpcError(method, message.error); return message.result; });
  };
  try {
    const init = await request('initialize', initializeParams);
    send({ method: 'notifications/initialized' });
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const listed = toolNames(await request('tools/list', cursor ? { cursor } : {}));
      tools.push(...listed.names); cursor = listed.cursor;
      if (!cursor) break;
    }
    return handshakeResult(init, tools);
  } catch (error) {
    const tail = stderr.trim().split(/\r?\n/).slice(-15).join('\n');
    throw Object.assign(error as Error, tail ? { stderrTail: tail } : {});
  } finally {
    settled = true; clearTimeout(timer);
    child.stdin.end();
    if (child.pid && child.exitCode === null && child.signalCode === null) await terminateProcessTree(child.pid).catch(() => { child.kill('SIGKILL'); });
    // Wait for the exit to be reaped, so a finished test never leaves the server behind.
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]);
  }
}

/** Server-sent events from a response body: each event's joined `data:` lines. */
async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
}
async function testHttp(spec: McpHttpSpec, timeoutMs: number, env: NodeJS.ProcessEnv): Promise<Handshake> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const token = spec.bearerTokenEnvVar ? env[spec.bearerTokenEnvVar] : undefined;
  if (spec.bearerTokenEnvVar && !token) { clearTimeout(timer); throw new Error(`The environment variable ${spec.bearerTokenEnvVar} (the server's token) isn't set for Hydra.`); }
  const headers = (extra: Record<string, string> = {}) => {
    const result = new Headers(spec.headers);
    result.set('content-type', 'application/json'); result.set('accept', 'application/json, text/event-stream');
    if (token) result.set('authorization', `Bearer ${token}`);
    for (const [key, value] of Object.entries(extra)) result.set(key, value);
    return result;
  };
  let session: string | undefined, negotiated: string | undefined, nextId = 1;
  const post = async (message: JsonRpc, expectAnswer: boolean): Promise<JsonRpc | undefined> => {
    const response = await fetch(spec.url, {
      method: 'POST', signal: controller.signal, body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      headers: headers({ ...(session ? { 'mcp-session-id': session } : {}), ...(negotiated ? { 'mcp-protocol-version': negotiated } : {}) }),
    });
    session = response.headers.get('mcp-session-id') ?? session;
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).trim().slice(0, 300);
      const hint = response.status === 401 || response.status === 403 ? ' The server wants a sign-in or a token (add an Authorization header).' : '';
      throw new Error(`The server answered HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.${hint}${body ? ` ${body}` : ''}`);
    }
    if (!expectAnswer) { await response.body?.cancel().catch(() => undefined); return undefined; }
    const type = response.headers.get('content-type') ?? '';
    const find = (payload: unknown): JsonRpc | undefined => (Array.isArray(payload) ? payload : [payload]).find((item: JsonRpc) => item && item.id === message.id && !item.method);
    if (type.includes('text/event-stream') && response.body) {
      for await (const data of sseData(response.body)) {
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { continue; }
        const found = find(payload);
        if (found) { await response.body.cancel().catch(() => undefined); return found; }
      }
      throw new Error('The server closed its event stream without answering.');
    }
    const text = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(text); } catch { throw new Error(`The server's answer isn't JSON: ${text.trim().slice(0, 200)}`); }
    const found = find(payload);
    if (!found) throw new Error('The server\'s answer doesn\'t match the request.');
    return found;
  };
  const request = async (method: string, params: unknown) => {
    const answer = (await post({ id: nextId++, method, params }, true))!;
    if (answer.error) throw rpcError(method, answer.error);
    return answer.result;
  };
  try {
    const init = await request('initialize', initializeParams);
    const version = (init as { protocolVersion?: unknown })?.protocolVersion;
    if (typeof version === 'string') negotiated = version;
    await post({ method: 'notifications/initialized' }, false);
    const tools: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const listed = toolNames(await request('tools/list', cursor ? { cursor } : {}));
      tools.push(...listed.names); cursor = listed.cursor;
      if (!cursor) break;
    }
    return handshakeResult(init, tools);
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`The server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`);
    const cause = (error as { cause?: { code?: string; message?: string } }).cause;
    if (error instanceof TypeError && cause) throw new Error(`Couldn't reach the server: ${cause.code ?? cause.message ?? error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
    // End the session politely; don't wait long for it.
    if (session) await fetch(spec.url, { method: 'DELETE', headers: headers({ 'mcp-session-id': session }), signal: AbortSignal.timeout(2000) }).then(response => response.body?.cancel()).catch(() => undefined);
  }
}
