import path from 'node:path';
import type { Provider } from '../model';
import { parseGate, type Gate } from '../gates/config';
import { looksLikeSecret, validateServerName, validateServerSpec, type McpServerSpec } from '../mcpServers';

/**
 * The pack format (docs/Packs_Plan.md, section 2): pack.json, each skill's
 * SKILL.md front matter, the project's .hydra/packs.json, and the rules every
 * pack keeps. Pure: the registry reads the folder and hands its bytes over.
 *
 * Packs can run commands, so everything is validated, and anything unknown is
 * refused with the reason, as in gates.json: a typo never silently turns
 * something on or off. Every function throws the first problem in plain English.
 */

export const packIdPattern = /^[a-z0-9-]{1,24}$/;
export const packCaps = {
  roles: 8, gates: 6, servers: 6, skills: 16,
  files: 200, bytes: 4 * 1024 * 1024, skillBytes: 64 * 1024, instructions: 8000,
  /** Folders inside a pack, counting from its root. */
  depth: 8,
  /** Packs one project may list, and gates it may have from gates.json and its packs together. */
  projectPacks: 8, effectiveGates: 24,
} as const;

export type PackTool = 'web';
export type RoleChanges = 'required' | 'optional';
export interface PackRole {
  id: string; title: string; description: string;
  /** The default agent. The user can still pick the other one. */
  provider: Provider;
  /** A Markdown file in the pack. */
  instructions: string;
  skills: string[];
  mcpServers: string[];
  tools: PackTool[];
  /** "optional": a head may finish without changing anything; its summary is the result. */
  changes: RoleChanges;
  /** Decision 4: the model on the role's own provider. The other provider keeps its default. */
  model?: string;
}
export interface PackManifest {
  version: 1; id: string; title: string; description: string; publisher?: string;
  roles: PackRole[];
  /** Parsed by the same parseGate as gates.json. `{pack}` and `{node}` are still unresolved. */
  gates: Gate[];
  mcpServers: Record<string, McpServerSpec>;
}
export interface PackSkill {
  id: string; description: string;
  /** Every file in the skill's folder, relative to the pack. */
  files: string[];
  /** The files agents may run, flagged on the review panel. */
  scripts: string[];
}
export interface PackServerInfo {
  /** Why Codex sessions skip this server, when they do. */
  claudeOnly?: string;
  /** "Downloads @playwright/mcp@0.0.82 from npm on first use." */
  downloads?: string;
  /** The `${NAME}` variables it reads from your environment. */
  variables: string[];
}
/** A pack whose files all check out. */
export interface ValidPack {
  manifest: PackManifest;
  skills: PackSkill[];
  /** Each role's instructions, by role id. */
  instructions: Record<string, string>;
  servers: Record<string, PackServerInfo>;
}

// ---- Small checks ----

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  return value as Record<string, unknown>;
};
const onlyKeys = (source: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  const unknown = Object.keys(source).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${what} has an unknown setting "${unknown[0]}".`);
};
/** One line of text, without control characters. */
const text = (value: unknown, what: string, max: number, required = true): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${what} must be text on one line, up to ${max} characters.`);
  return value.trim();
};
const identifier = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !packIdPattern.test(value)) throw new Error(`${what} must be 1–24 lowercase letters, digits or dashes.`);
  return value;
};
const idList = (value: unknown, what: string, max: number): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${what} must be a list of up to ${max} ids.`);
  const ids = value.map(entry => identifier(entry, `Each entry in ${what}`));
  const twice = ids.find((id, index) => ids.indexOf(id) !== index);
  if (twice) throw new Error(`${what} lists "${twice}" twice.`);
  return ids;
};

const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const reservedName = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/**
 * A file a pack names, like "roles/builder.md": relative, forward slashes, no
 * "..", no absolute path, and plain names Windows can hold. It never leaves the folder.
 */
export function packPath(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || value.length > 240) throw new Error(`${what} must be a path inside the pack, like "roles/builder.md".`);
  if (value.includes('\\')) throw new Error(`${what} must use forward slashes, like "roles/builder.md".`);
  const parts = value.split('/');
  if (parts.some(part => !segmentPattern.test(part) || part.endsWith('.') || reservedName.test(part))) {
    throw new Error(`${what} must be a path inside the pack, like "roles/builder.md": no absolute path, no "..", and plain names.`);
  }
  return value;
}

/** A model name safe on any command line: "opus", "claude-opus-4", "gpt-5.6-luna", "claude-opus-5-5[1m]". */
export const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,63}$/;

// ---- {pack} and {node} ----

/**
 * `{pack}` is the pack's folder (its verified copy, when it runs). It may start
 * an argument, alone or followed by a path in the pack, and may follow a
 * `--flag=`: "{pack}/scripts/check.mjs", "--config={pack}/lint.json".
 * `{node}` is Hydra's own executable run as Node (decision 7), and only ever
 * the whole command, never an argument.
 */
const packArgument = /^(--?[A-Za-z0-9][A-Za-z0-9-]*=)?\{pack\}(?:\/(.*))?$/;
export function checkPlaceholders(parts: readonly string[], what: string, files?: ReadonlySet<string>): void {
  parts.forEach((part, index) => {
    if (part.includes('{node}') && (index > 0 || part !== '{node}')) throw new Error(`${what}: "{node}" can only be the command itself, as the first entry.`);
    if (!part.includes('{pack}')) return;
    const match = packArgument.exec(part);
    if (!match || part.indexOf('{pack}') !== part.lastIndexOf('{pack}')) throw new Error(`${what}: "{pack}" must start an argument (or follow "--name="), like "{pack}/scripts/check.mjs".`);
    if (match[2] === undefined) return;
    const inside = packPath(match[2], `${what}: the path after "{pack}"`);
    if (files && !files.has(inside) && ![...files].some(file => file.startsWith(`${inside}/`))) throw new Error(`${what}: "{pack}/${inside}" isn't in the pack.`);
  });
}

/**
 * Put the real folder and executable in place of `{pack}` and `{node}`. The
 * result is an argument list for a direct spawn, never a shell string, so a
 * folder with spaces or quotes in its path is passed as it is.
 */
export function resolvePlaceholders(parts: readonly string[], packFolder: string, nodeExecutable: string): { parts: string[]; env?: Record<string, string> } {
  const resolved = parts.map((part, index) => {
    if (index === 0 && part === '{node}') return nodeExecutable;
    const match = packArgument.exec(part);
    if (!match) return part;
    return `${match[1] ?? ''}${match[2] === undefined ? packFolder : path.join(packFolder, ...match[2].split('/'))}`;
  });
  return { parts: resolved, ...(parts[0] === '{node}' ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}) };
}

// ---- MCP servers: secrets, variables and Codex ----

/** `${NAME}` or `${NAME:-default}`: a value from your environment, filled in when the server starts. */
const referencePattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
export const variableNames = (value: string): string[] => [...value.matchAll(referencePattern)].map(match => match[1]!);
const plainValue = (value: string) => value.length < 8 || /^(\d+(\.\d+)?|true|false)$/i.test(value);
/**
 * Whether a literal in a server's settings is a secret. `${NAME}` references
 * are fine; what's left around them is checked with looksLikeSecret, by its
 * name and its shape. Short plain values ("8", "true") pass even under a
 * name like SESSION_TIMEOUT.
 */
function secretLiteral(key: string | undefined, value: string): boolean {
  const literal = value.replace(referencePattern, '').trim();
  if (!literal || /^(Bearer|Basic|token)$/i.test(literal)) return false;
  return looksLikeSecret(undefined, literal) || (!plainValue(literal) && looksLikeSecret(key, literal));
}
const secretAdvice = 'Put the secret in your environment and use ${NAME}.';
const secretKeyFlag = /token|secret|passw|api[-_]?key|apikey|auth(?!or)|credential|private[-_]?key|access[-_]?key|session|cookie|bearer/i;

function checkServerValues(spec: McpServerSpec, what: string): void {
  const check = (key: string | undefined, value: string, where: string) => {
    if (secretLiteral(key, value)) throw new Error(`${what}: ${where} looks like a secret. ${secretAdvice}`);
    const hydra = variableNames(value).find(name => /^HYDRA_/i.test(name));
    if (hydra) throw new Error(`${what}: ${where} reads \${${hydra}}, one of Hydra's own variables. A pack can't.`);
  };
  if (spec.type === 'stdio') {
    spec.args.forEach((arg, index) => {
      const previous = index > 0 ? spec.args[index - 1]! : '';
      const pair = /^(--?[A-Za-z][\w.-]*)=(.*)$/s.exec(arg);
      const key = pair ? pair[1] : /^--?[A-Za-z]/.test(previous) && !previous.includes('=') && secretKeyFlag.test(previous) ? previous : undefined;
      check(key, pair ? pair[2]! : arg, `argument ${index + 1}`);
    });
    for (const [key, value] of Object.entries(spec.env)) check(key, value, `the value of ${key}`);
  } else {
    let url: URL;
    try { url = new URL(spec.url.replace(referencePattern, 'x')); } catch { throw new Error(`${what}: "url" isn't a valid address.`); }
    if (url.password || url.username) throw new Error(`${what}: the URL has a user name or password in it. ${secretAdvice}`);
    const query = spec.url.includes('?') ? spec.url.slice(spec.url.indexOf('?') + 1).split('#')[0]! : '';
    for (const [key, value] of new URLSearchParams(query)) check(key, value, `the URL's "${key}"`);
    check(undefined, spec.url, 'the URL');
    for (const [key, value] of Object.entries(spec.headers)) check(key, value, `the header ${key}`);
  }
}

/** Characters cmd.exe reads as syntax, or that can't sit in a TOML literal on Codex's command line. */
const codexUnsafe = /['\r\n%^&|<>!"]/;
/**
 * Why Codex sessions skip a server, or undefined when Codex can run it.
 * Codex servers are passed as `-c` arguments through the npm `codex.cmd` shim,
 * and Codex passes a variable only whole, by name (`env_vars`, R4).
 */
export function codexProblem(spec: McpServerSpec): string | undefined {
  const unsafe = 'Its settings have characters that can\'t be passed to Codex safely (\' " % ^ & | < > ! or a line break).';
  if (spec.type === 'sse') return 'Codex can\'t use SSE servers.';
  if (spec.type === 'stdio') {
    if ([spec.command, ...spec.args].some(part => codexUnsafe.test(part))) return unsafe;
    if (spec.args.some(arg => variableNames(arg).length)) return 'Codex doesn\'t fill in ${NAME} in arguments.';
    for (const value of Object.values(spec.env)) {
      const names = variableNames(value);
      if (names.length && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) return 'Codex passes a variable only whole, as "${NAME}".';
      if (!names.length && codexUnsafe.test(value)) return unsafe;
    }
    return undefined;
  }
  if (codexUnsafe.test(spec.url)) return unsafe;
  if (variableNames(spec.url).length) return 'Codex doesn\'t fill in ${NAME} in a URL.';
  for (const [key, value] of Object.entries(spec.headers)) {
    const whole = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value), bearer = key.toLowerCase() === 'authorization' && /^Bearer \$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value);
    if (variableNames(value).length && !whole && !bearer) return 'Codex passes a header variable only whole, as "${NAME}" (or "Bearer ${NAME}" for Authorization).';
    if (!variableNames(value).length && codexUnsafe.test(value)) return unsafe;
  }
  return undefined;
}

/** What a server downloads when it first starts, for the review panel (decision 3). */
export function serverDownloads(spec: McpServerSpec): string | undefined {
  if (spec.type !== 'stdio') return undefined;
  const runner = spec.command.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  const target = spec.args.find(arg => !arg.startsWith('-'));
  if (!target) return undefined;
  if (runner === 'npx' || runner === 'bunx' || runner === 'pnpx') return `Downloads ${target} from npm on first use.`;
  if (runner === 'uvx') return `Downloads ${target} from PyPI on first use.`;
  return undefined;
}

const stdioKeys = ['type', 'command', 'args', 'env'];
const httpKeys = ['type', 'url', 'headers', 'bearerTokenEnvVar'];
function parseServer(value: unknown, what: string): McpServerSpec {
  const source = record(value, what);
  onlyKeys(source, source.type === 'stdio' ? stdioKeys : httpKeys, what);
  let spec: McpServerSpec;
  try { spec = validateServerSpec(source); } catch (error) { throw new Error(`${what}: ${error instanceof Error ? error.message : String(error)}`); }
  if (spec.type === 'stdio') {
    if (spec.args.length > 64 || spec.args.some(arg => arg.length > 4000)) throw new Error(`${what}: "args" must be up to 64 arguments.`);
    if (Object.keys(spec.env).length > 32) throw new Error(`${what}: "env" can set up to 32 variables.`);
    checkPlaceholders([spec.command, ...spec.args], what);
  }
  checkServerValues(spec, what);
  return spec;
}

// ---- pack.json ----

const packKeys = ['$schema', 'version', 'id', 'title', 'description', 'publisher', 'roles', 'gates', 'mcpServers'];
const roleKeys = ['id', 'title', 'description', 'provider', 'instructions', 'skills', 'mcpServers', 'tools', 'changes', 'model'];

function parseRole(value: unknown, index: number): PackRole {
  const source = record(value, `Role ${index + 1}`);
  const id = identifier(source.id, `Role ${index + 1}'s "id"`);
  const what = `Role "${id}"`;
  onlyKeys(source, roleKeys, what);
  if (source.provider !== 'claude' && source.provider !== 'codex') throw new Error(`${what}: "provider" must be "claude" or "codex".`);
  const instructions = packPath(source.instructions, `${what}: "instructions"`);
  if (!instructions.toLowerCase().endsWith('.md')) throw new Error(`${what}: "instructions" must be a Markdown file (.md) in the pack.`);
  const tools = idList(source.tools, `${what}: "tools"`, 1);
  if (tools.some(tool => tool !== 'web')) throw new Error(`${what}: "tools" can only be ["web"] for now.`);
  const changes = source.changes ?? 'required';
  if (changes !== 'required' && changes !== 'optional') throw new Error(`${what}: "changes" must be "required" or "optional".`);
  if (source.model !== undefined && (typeof source.model !== 'string' || !modelPattern.test(source.model))) throw new Error(`${what}: "model" must be a model name like "opus" or "gpt-5.6-luna": letters, digits and . _ : / [ ] -.`);
  return {
    id, title: text(source.title, `${what}: "title"`, 40)!, description: text(source.description, `${what}: "description"`, 300)!,
    provider: source.provider, instructions,
    skills: idList(source.skills, `${what}: "skills"`, packCaps.skills), mcpServers: idList(source.mcpServers, `${what}: "mcpServers"`, packCaps.servers),
    tools: tools as PackTool[], changes, ...(typeof source.model === 'string' ? { model: source.model } : {}),
  };
}

/** Check a pack.json's contents. Files it names are checked by checkPackContents. */
export function parsePackManifest(value: unknown): PackManifest {
  const source = record(value, 'pack.json');
  onlyKeys(source, packKeys, 'pack.json');
  if (source.version !== 1) throw new Error('pack.json needs "version": 1.');
  const id = identifier(source.id, 'The pack\'s "id"');
  const title = text(source.title, '"title"', 60)!;
  const description = text(source.description, '"description"', 300)!;
  const publisher = text(source.publisher, '"publisher"', 80, false);

  if (source.roles !== undefined && !Array.isArray(source.roles)) throw new Error('"roles" must be a list.');
  const rawRoles = (source.roles ?? []) as unknown[];
  if (rawRoles.length > packCaps.roles) throw new Error(`A pack has at most ${packCaps.roles} roles (found ${rawRoles.length}).`);
  const roles = rawRoles.map(parseRole);
  const twiceRole = roles.find((role, index) => roles.findIndex(other => other.id === role.id) !== index);
  if (twiceRole) throw new Error(`Two roles have the id "${twiceRole.id}".`);

  const rawServers = source.mcpServers === undefined ? {} : record(source.mcpServers, '"mcpServers"');
  const serverIds = Object.keys(rawServers);
  if (serverIds.length > packCaps.servers) throw new Error(`A pack has at most ${packCaps.servers} MCP servers (found ${serverIds.length}).`);
  const mcpServers: Record<string, McpServerSpec> = {};
  for (const serverId of serverIds) {
    identifier(serverId, `The MCP server id "${serverId}"`);
    validateServerName(`${id}-${serverId}`);
    mcpServers[serverId] = parseServer(rawServers[serverId], `MCP server "${serverId}"`);
  }

  if (source.gates !== undefined && !Array.isArray(source.gates)) throw new Error('"gates" must be a list.');
  const rawGates = (source.gates ?? []) as unknown[];
  if (rawGates.length > packCaps.gates) throw new Error(`A pack has at most ${packCaps.gates} gates (found ${rawGates.length}).`);
  const roleIds = roles.map(role => role.id);
  const gates = rawGates.map((gate, index) => parseGate(gate, index, { roles: roleIds }));
  const twiceGate = gates.find((gate, index) => gates.findIndex(other => other.id === gate.id) !== index);
  if (twiceGate) throw new Error(`Two gates have the id "${twiceGate.id}".`);
  for (const gate of gates) {
    if (gate.type === 'command') checkPlaceholders(gate.command, `Gate "${gate.id}": "command"`);
    if (gate.type === 'screenshots') checkPlaceholders(gate.start, `Gate "${gate.id}": "start"`);
  }

  for (const role of roles) {
    const missing = role.mcpServers.find(server => !(server in mcpServers));
    if (missing) throw new Error(`Role "${role.id}" uses the MCP server "${missing}", which the pack doesn't have.`);
  }
  return { version: 1, id, title, description, ...(publisher ? { publisher } : {}), roles, gates, mcpServers };
}

// ---- Skills ----

const skillFrontKeys = ['name', 'description', 'license'];
/**
 * A skill's SKILL.md front matter: `name` (the folder's name) and a one-line
 * `description`, plus an optional `license`. Anything else is refused: a
 * skill's front matter can grant tools (`allowed-tools`) or run hooks, and a
 * pack's skills do neither.
 */
export function parseSkillFile(id: string, content: string): { description: string } {
  const what = `skills/${id}/SKILL.md`;
  const lines = content.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new Error(`${what} must start with front matter ("---", then name and description).`);
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) throw new Error(`${what}: its front matter has no closing "---".`);
  const values: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!match) throw new Error(`${what}: write each front-matter value on one line, like "description: …".`);
    const key = match[1]!;
    if (!skillFrontKeys.includes(key)) throw new Error(`${what} has an unknown front-matter setting "${key}". A pack's skill has only name, description and license.`);
    let value = match[2]!.trim();
    if (/^[>|]/.test(value)) throw new Error(`${what}: write "${key}" on one line.`);
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    values[key] = value;
  }
  if (values.name !== id) throw new Error(`${what}: "name" must be "${id}", the folder's name.`);
  if (!values.description || values.description.length > 1024) throw new Error(`${what} needs a "description" of up to 1024 characters.`);
  return { description: values.description };
}

/** Files agents may run. The review panel flags them: "Agents may run these." */
export const scriptPattern = /\.(m?js|cjs|m?ts|py|sh|bash|ps1|psm1|bat|cmd|exe|dll|rb|pl|php|jar|vbs)$/i;

// ---- The whole pack ----

/**
 * Check a pack's files against its manifest: the caps, the role files, the
 * skills and every `{pack}` path. `files` maps each file's path in the pack
 * (forward slashes) to its bytes; links were refused while reading the folder.
 */
export function checkPackContents(manifest: PackManifest, files: ReadonlyMap<string, Uint8Array>): ValidPack {
  if (files.size > packCaps.files) throw new Error(`A pack has at most ${packCaps.files} files (found ${files.size}).`);
  let bytes = 0;
  for (const content of files.values()) bytes += content.byteLength;
  if (bytes > packCaps.bytes) throw new Error(`A pack is at most ${packCaps.bytes / 1024 / 1024} MB (this one is ${(bytes / 1024 / 1024).toFixed(1)} MB).`);
  const names = new Set(files.keys());
  const decode = (file: string) => Buffer.from(files.get(file)!).toString('utf8').replace(/^﻿/, '');

  const skillFolders = new Map<string, string[]>();
  for (const file of names) {
    if (!file.startsWith('skills/')) continue;
    const [, folder, ...rest] = file.split('/');
    if (!rest.length) throw new Error(`"${file}": the skills folder holds only one folder per skill, like skills/cite-sources/SKILL.md.`);
    identifier(folder, `The skill folder "skills/${folder}"`);
    skillFolders.set(folder!, [...skillFolders.get(folder!) ?? [], file]);
  }
  if (skillFolders.size > packCaps.skills) throw new Error(`A pack has at most ${packCaps.skills} skills (found ${skillFolders.size}).`);
  const skills: PackSkill[] = [];
  for (const [id, skillFiles] of [...skillFolders].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const main = `skills/${id}/SKILL.md`;
    if (!files.has(main)) throw new Error(`The skill "${id}" has no SKILL.md (skills/${id}/SKILL.md).`);
    if (files.get(main)!.byteLength > packCaps.skillBytes) throw new Error(`${main} is over ${packCaps.skillBytes / 1024} KB.`);
    const sorted = [...skillFiles].sort();
    skills.push({ id, description: parseSkillFile(id, decode(main)).description, files: sorted, scripts: sorted.filter(file => scriptPattern.test(file)) });
  }

  const instructions: Record<string, string> = {};
  for (const role of manifest.roles) {
    if (!files.has(role.instructions)) throw new Error(`Role "${role.id}": its instructions file "${role.instructions}" isn't in the pack.`);
    const content = decode(role.instructions);
    if (content.length > packCaps.instructions) throw new Error(`Role "${role.id}": "${role.instructions}" is over ${packCaps.instructions} characters.`);
    if (!content.trim()) throw new Error(`Role "${role.id}": "${role.instructions}" is empty.`);
    const missing = role.skills.find(skill => !skillFolders.has(skill));
    if (missing) throw new Error(`Role "${role.id}" uses the skill "${missing}", which the pack doesn't have (skills/${missing}/SKILL.md).`);
    instructions[role.id] = content;
  }

  for (const gate of manifest.gates) {
    if (gate.type === 'command') checkPlaceholders(gate.command, `Gate "${gate.id}": "command"`, names);
    if (gate.type === 'screenshots') checkPlaceholders(gate.start, `Gate "${gate.id}": "start"`, names);
  }
  const servers: Record<string, PackServerInfo> = {};
  for (const [id, spec] of Object.entries(manifest.mcpServers)) {
    if (spec.type === 'stdio') checkPlaceholders([spec.command, ...spec.args], `MCP server "${id}"`, names);
    const values = spec.type === 'stdio' ? [...spec.args, ...Object.values(spec.env)] : [spec.url, ...Object.values(spec.headers)];
    const claudeOnly = codexProblem(spec), downloads = serverDownloads(spec);
    servers[id] = { ...(claudeOnly ? { claudeOnly } : {}), ...(downloads ? { downloads } : {}), variables: [...new Set(values.flatMap(variableNames))].sort() };
  }
  return { manifest, skills, instructions, servers };
}

// ---- .hydra/packs.json ----

export interface PacksFileEntry {
  id: string;
  /** Pack gates this project turns off. */
  skipGates?: string[];
}
export interface PacksFile { version: 1; packs: PacksFileEntry[] }

/** Check a project's .hydra/packs.json. Whether each skipGates entry names a real gate is checked against the pack (skipGatesProblem). */
export function parsePacksFile(value: unknown): PacksFile {
  const source = record(value, '.hydra/packs.json');
  onlyKeys(source, ['$schema', 'version', 'packs'], '.hydra/packs.json');
  if (source.version !== 1) throw new Error('.hydra/packs.json needs "version": 1.');
  if (!Array.isArray(source.packs)) throw new Error('.hydra/packs.json needs a "packs" list.');
  if (source.packs.length > packCaps.projectPacks) throw new Error(`A project can turn on at most ${packCaps.projectPacks} packs (found ${source.packs.length}).`);
  const packs = source.packs.map((value, index): PacksFileEntry => {
    const entry = record(value, `Pack ${index + 1} in .hydra/packs.json`);
    const id = identifier(entry.id, `Pack ${index + 1}'s "id" in .hydra/packs.json`);
    onlyKeys(entry, ['id', 'skipGates'], `The "${id}" entry in .hydra/packs.json`);
    const skipGates = idList(entry.skipGates, `"skipGates" for ${id}`, packCaps.gates);
    return { id, ...(skipGates.length ? { skipGates } : {}) };
  });
  const twice = packs.find((pack, index) => packs.findIndex(other => other.id === pack.id) !== index);
  if (twice) throw new Error(`.hydra/packs.json lists the pack "${twice.id}" twice.`);
  return { version: 1, packs };
}

/** packs.json as Hydra writes it: 2-space JSON and a trailing newline, so a commit shows only real changes. */
export const formatPacksFile = (file: PacksFile): string => `${JSON.stringify({ version: 1, packs: file.packs.map(entry => ({ id: entry.id, ...(entry.skipGates?.length ? { skipGates: entry.skipGates } : {}) })) }, null, 2)}\n`;

/** A skipGates entry that names no gate of the pack, as a note for the Packs page. A typo can only leave a gate on. */
export function skipGatesProblem(entry: PacksFileEntry, manifest: Pick<PackManifest, 'title' | 'gates'>): string | undefined {
  const unknown = (entry.skipGates ?? []).filter(id => !manifest.gates.some(gate => gate.id === id));
  return unknown.length ? `"skipGates" names ${unknown.map(id => `"${id}"`).join(', ')}, which the ${manifest.title} pack doesn't have.` : undefined;
}
