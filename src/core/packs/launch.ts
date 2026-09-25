import path from 'node:path';
import type { Provider } from '../model';
import type { McpServerSpec } from '../mcpServers';
import { shimSafe } from '../process';
import { resolvePlaceholders, variableNames, type PackRole, type PackServerInfo, type PackTool, type RoleChanges } from './format';
import type { PackState } from './project';

/**
 * A role at launch (docs/Packs_Plan.md, section 5, "How a role reaches each CLI").
 * Pure: the pack service reads the active pack's checked copy and builds the Claude
 * plugin (a ResolvedRole); roleLaunch turns that into what one launch needs, for one
 * provider and one target, a lane or a head. helperRunner and laneLaunch place the pieces.
 *
 * - Nothing reaches your Claude Code or Codex settings: every piece is a flag for that
 *   one process, a file Hydra writes for it, or a variable in its own environment.
 * - Secrets never reach a command line or a file Hydra writes: a pack holds only
 *   `${NAME}` references. Claude expands them itself from its `--mcp-config` file (R3).
 *   Codex is told the variable's name (`env_vars`, R4); a value the server reads under
 *   another name is set in the Codex process's own environment.
 * - A server that can't run as the pack asks is left out with a note, never passed
 *   half-right: a name you already use, a variable that isn't set, a value Codex can't
 *   be given safely.
 */

// ---- Naming a role ----

/** "coding/builder": how jobs, lanes and plans record a role. */
export const roleRefPattern = /^([a-z0-9-]{1,24})\/([a-z0-9-]{1,24})$/;
const roleNamePattern = /^(?:[a-z0-9-]{1,24}\/)?[a-z0-9-]{1,24}$/;
export interface RoleSummary {
  /** "coding/builder". */
  ref: string;
  /** What a lead passes: "builder" when only one active pack has a role with that id, else the ref. */
  name: string;
  pack: string; packTitle: string; id: string; title: string; description: string;
  /** The role's own agent: a head without `provider`, a plan job without one, and the New lane form's default. */
  provider: Provider;
}
/** "Reviewer (Coding pack)". */
export const roleLabel = (title: string, packTitle: string): string => `${title} (${packTitle} pack)`;

/** The active packs' roles, in packs.json order, each with the name a lead passes. */
export function roleSummaries(packs: readonly { id: string; title: string; roles: readonly Pick<PackRole, 'id' | 'title' | 'description' | 'provider'>[] }[]): RoleSummary[] {
  const all = packs.flatMap(pack => pack.roles.map(role => ({ ref: `${pack.id}/${role.id}`, pack: pack.id, packTitle: pack.title, id: role.id, title: role.title, description: role.description, provider: role.provider })));
  return all.map(role => ({ ...role, name: all.some(other => other !== role && other.id === role.id) ? role.ref : role.id }));
}

/** A role as lanes and plan jobs name it: "pack/role". */
export function parseRoleRef(value: unknown): { pack: string; role: string } {
  const match = typeof value === 'string' ? roleRefPattern.exec(value) : null;
  if (!match) throw new Error('Name the role with its pack, like "coding/builder".');
  return { pack: match[1]!, role: match[2]! };
}
/** A role as a lead names it: "builder", or "coding/builder". Whether it exists is checked against the active roles (findRole). */
export function parseRoleName(value: unknown): string {
  if (typeof value !== 'string' || !roleNamePattern.test(value)) throw new Error('role must be a role\'s name, like "builder" or "coding/builder".');
  return value;
}

export const activeRolesSentence = (roles: readonly Pick<RoleSummary, 'name'>[]): string =>
  roles.length ? `Active roles: ${roles.map(role => role.name).join(', ')}.` : 'No roles are active in this project; turn on a pack in Settings → Packs.';
/** The active role a name means. An unknown or ambiguous name is refused, listing the active roles. */
export function findRole(roles: readonly RoleSummary[], name: string): RoleSummary {
  const found = name.includes('/') ? roles.filter(role => role.ref === name) : roles.filter(role => role.id === name);
  if (found.length === 1) return found[0]!;
  if (found.length > 1) throw new Error(`More than one active pack has a role "${name}". Name it with its pack: ${found.map(role => role.ref).join(', ')}.`);
  throw new Error(`There's no active role "${name}". ${activeRolesSentence(roles)}`);
}

/**
 * Why a role can't be used now, in a few words, from its pack's state in the project
 * (section 3): "the Coding pack is off". `state` is undefined when no pack has that id.
 */
export function roleUnavailableReason(pack: string, packTitle: string | undefined, state: PackState | undefined, role: string): string {
  const title = packTitle ?? pack;
  switch (state) {
    case 'on': return `the ${title} pack has no role "${role}"`;
    case 'off': return `the ${title} pack is off`;
    case 'needsOk': return `the ${title} pack isn't allowed on this machine yet`;
    case 'changed': return `the ${title} pack changed since you allowed it`;
    case 'invalid': return `the ${title} pack has a problem`;
    default: return `the ${pack} pack isn't installed`;
  }
}
/**
 * A role that can't be used. Its message is the head's wording (after "Could not start: "):
 * "the role coding/builder isn't available (the Coding pack is off)."; a lane's tile says
 * `laneNote`: "Role Reviewer isn't available: the Coding pack is off."
 */
export class RoleUnavailable extends Error {
  constructor(readonly ref: string, readonly title: string, readonly reason: string) { super(`the role ${ref} isn't available (${reason}).`); }
  get laneNote(): string { return `Role ${this.title} isn't available: ${this.reason}.`; }
}

// ---- The role, resolved from its pack's checked copy ----

export interface ResolvedSkill { id: string; description: string }
export interface ResolvedServer { id: string; spec: McpServerSpec; info: PackServerInfo }
/** Everything roleLaunch reads, gathered by the pack service from an active pack. */
export interface ResolvedRole {
  ref: string; pack: string; packTitle: string;
  role: PackRole;
  /** The pack's checked copy (its hash verified at this launch): what `{pack}` means, and where every path points. */
  copy: string;
  /** The role's instructions, as checked. */
  instructions: string;
  /** The role's skills, in its order. */
  skills: readonly ResolvedSkill[];
  /** The servers the role lists (decision 5), in its order. */
  servers: readonly ResolvedServer[];
  /** The role's Claude plugin folder (buildRolePlugin), when it has skills. */
  plugin?: string;
  /** Hydra's own executable, run as Node for `{node}` (decision 7). */
  nodeExecutable: string;
  /** The names of your own servers, per agent: a pack server with the same name is left out. */
  userServers: Readonly<Partial<Record<Provider, readonly string[]>>>;
}

/** What heads and lanes ask the pack service for. With none (tests, a window without packs), nothing has a role. */
export interface RoleSource {
  /** The active roles in a project, in packs.json order. */
  roles(folder: string): Promise<RoleSummary[]>;
  /** The active role a name means; refused with the reason, listing the active roles. */
  pick(folder: string, name: string): Promise<RoleSummary>;
  /** A role for one launch, from its pack's checked copy. Throws RoleUnavailable. */
  resolve(folder: string, ref: string): Promise<ResolvedRole>;
}

/** A server entry in a Claude `--mcp-config` file. `${NAME}` references are kept: Claude expands them (R3). */
export type ClaudeServerConfig =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers: Record<string, string> };

export interface RoleLaunchOptions {
  provider: Provider;
  target: 'lane' | 'head';
  /** The environment the CLI starts with: `${NAME}` references are checked against it. */
  env: Readonly<Record<string, string | undefined>>;
  /** The CLI is a Windows `.cmd` shim, so its arguments pass through cmd.exe. */
  shim?: boolean;
  platform?: NodeJS.Platform;
}

export interface RoleLaunch {
  ref: string;
  title: string;
  /** "Reviewer (Coding pack)". */
  label: string;
  changes: RoleChanges;
  tools: PackTool[];
  /** The role's instructions and then its skill index: a head's "Your role" section, a Codex lane's developer instructions. */
  text: string;
  skillIndex?: string;
  /** Each skill's SKILL.md in the checked copy. */
  skills: { id: string; file: string }[];
  /** The instructions file in the checked copy: a Claude lane's `--append-system-prompt-file` (R1), and where a Codex lane is told to read them. */
  instructionsFile: string;
  /** Claude: `--plugin-dir` (R5). */
  pluginDir?: string;
  /** Claude: the role's servers for a `--mcp-config` file, by name. */
  mcpServers: Record<string, ClaudeServerConfig>;
  /** Codex: `-c` overrides for the role's servers, as argument pairs. */
  codexConfig: string[];
  /** Variables the Codex servers read by name, set in the CLI's own environment. Never on its command line. */
  env: Record<string, string>;
  /** Claude heads: added to `--allowedTools`. */
  allowedTools: string[];
  /** Codex heads: `-c web_search=…` (R7). */
  webSearch: 'live' | 'disabled';
  /** Decision 4: only when the role runs on its own provider. */
  model?: string;
  /** What was left out, and why. */
  notes: string[];
}

const oneLine = (text: string) => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…` : text;
export const skillFile = (copy: string, id: string): string => path.join(copy, 'skills', id, 'SKILL.md');

/**
 * The skill index (section 1, "Skills"; R6): one line per skill with its description and
 * the absolute path of its SKILL.md in the checked copy, then how to use it.
 */
export function skillIndex(copy: string, skills: readonly ResolvedSkill[]): string | undefined {
  if (!skills.length) return undefined;
  return ['Skills you can use:', ...skills.map(skill => `- ${skill.id}: ${clip(oneLine(skill.description), 300)} (${skillFile(copy, skill.id)})`), 'Read the file before you use the skill.'].join('\n');
}

/** Characters that can't sit in a TOML literal on Codex's command line, or that cmd.exe reads as syntax through its `.cmd` shim. */
const codexUnsafe = /['"%^&|<>!\u0000-\u001f\u007f]/;
/** What cmd.exe reads as syntax in a path on a shim's command line. */
const cmdUnsafe = /["%^&|<>!\u0000-\u001f\u007f]/;
const literal = (value: string) => `'${value}'`;
/** Variables that steer the CLI, Node or Windows themselves: a pack server never gets one set under its name. */
const steering = /^(HYDRA_|CODEX_|OPENAI_|ANTHROPIC_|CLAUDE|ELECTRON_|NODE_|NPM_)|^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|WINDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|SHELL|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|RUST_LOG|DISABLE_AUTOUPDATER|TERM|COLORTERM)$/i;

function envValue(env: RoleLaunchOptions['env'], name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}
/** `${NAME}` references without a default whose variable isn't set (R3: Claude would pass the text `${NAME}` itself). */
function unsetVariables(values: readonly string[], env: RoleLaunchOptions['env'], platform: NodeJS.Platform): string[] {
  const unset = new Set<string>();
  for (const value of values) for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-[^}]*)?\}/g)) {
    if (match[2] === undefined && !envValue(env, match[1]!, platform)) unset.add(match[1]!);
  }
  return [...unset];
}
const wholeReference = (value: string): string | undefined => /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];

/** One server for Claude: the `--mcp-config` entry, with `{pack}` and `{node}` resolved and `${NAME}` kept. */
function claudeServer(server: ResolvedServer, role: ResolvedRole): ClaudeServerConfig {
  const { spec } = server;
  if (spec.type === 'stdio') {
    const { parts, env } = resolvePlaceholders([spec.command, ...spec.args], role.copy, role.nodeExecutable);
    return { type: 'stdio', command: parts[0]!, args: parts.slice(1), env: { ...spec.env, ...env } };
  }
  const authorization = Object.keys(spec.headers).some(key => key.toLowerCase() === 'authorization');
  // Claude takes a bearer token as the header itself; the reference stays a reference.
  return { type: spec.type, url: spec.url, headers: { ...spec.headers, ...(spec.bearerTokenEnvVar && !authorization ? { Authorization: `Bearer \${${spec.bearerTokenEnvVar}}` } : {}) } };
}

/**
 * One server for Codex: its `-c mcp_servers.<name>.*` pairs, and the variables to set in
 * Codex's environment. A reason instead when it can't be passed safely.
 */
function codexServer(name: string, server: ResolvedServer, role: ResolvedRole, options: RoleLaunchOptions, taken: Record<string, string>): { config: string[]; env: Record<string, string> } | { skip: string } {
  const { spec } = server;
  const platform = options.platform ?? process.platform;
  const unsafe = 'its settings can\'t be passed to Codex safely';
  const pairs: string[] = [];
  const set = (key: string, value: string) => { pairs.push('-c', `mcp_servers.${name}.${key}=${value}`); };
  const table = (entries: [string, string][]) => `{ ${entries.map(([key, value]) => `${key} = ${literal(value)}`).join(', ')} }`;
  const env: Record<string, string> = {};
  if (spec.type === 'stdio') {
    const resolved = resolvePlaceholders([spec.command, ...spec.args], role.copy, role.nodeExecutable);
    const plain = Object.entries({ ...spec.env, ...resolved.env }).filter(([, value]) => !variableNames(value).length);
    if ([...resolved.parts, ...plain.map(([, value]) => value)].some(value => codexUnsafe.test(value))) return { skip: unsafe };
    const byName: string[] = [];
    for (const [key, value] of Object.entries(spec.env)) {
      const source = wholeReference(value);
      if (!source) continue;
      byName.push(key);
      if (source.toUpperCase() === key.toUpperCase()) continue;
      // The server reads `key`; your value is in `source`. Codex passes variables only by
      // their own name (R4), so `key` is set in Codex's environment, never over one already there.
      const wanted = envValue(options.env, source, platform)!;
      const current = taken[key] ?? envValue(options.env, key, platform);
      if (steering.test(key)) return { skip: `Hydra doesn't set ${key} for Codex` };
      if (current !== undefined && current !== wanted) return { skip: `${key} is already set in your environment` };
      env[key] = wanted;
    }
    set('command', literal(resolved.parts[0]!));
    set('args', `[${resolved.parts.slice(1).map(literal).join(', ')}]`);
    if (plain.length) set('env', table(plain));
    if (byName.length) set('env_vars', `[${byName.map(literal).join(', ')}]`);
    // npx may download the server first: Codex's own 10 seconds is often too short.
    set('startup_timeout_sec', '60');
  } else {
    if (codexUnsafe.test(spec.url) || Object.keys(spec.headers).some(key => !/^[A-Za-z0-9_-]+$/.test(key))) return { skip: unsafe };
    set('url', literal(spec.url));
    const plain = Object.entries(spec.headers).filter(([, value]) => !variableNames(value).length);
    const named: [string, string][] = [];
    let bearer = spec.bearerTokenEnvVar;
    for (const [key, value] of Object.entries(spec.headers)) {
      const whole = wholeReference(value), token = /^Bearer \$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)?.[1];
      if (whole) named.push([key, whole]);
      else if (token && key.toLowerCase() === 'authorization') bearer = token;
    }
    if (plain.some(([, value]) => codexUnsafe.test(value))) return { skip: unsafe };
    if (plain.length) set('http_headers', table(plain));
    if (named.length) set('env_http_headers', table(named));
    if (bearer) set('bearer_token_env_var', literal(bearer));
  }
  // Under `codex exec` with approval "never", a server's tools are refused without this (R4).
  set('default_tools_approval_mode', literal('approve'));
  return { config: pairs, env };
}

/**
 * What one launch of a role needs (section 5's table), for one provider and target.
 * Every path points into the pack's checked copy. Servers the role doesn't list never
 * reach it (decision 5).
 */
export function roleLaunch(role: ResolvedRole, options: RoleLaunchOptions): RoleLaunch {
  const { provider } = options;
  const platform = options.platform ?? process.platform;
  const notes: string[] = [];
  const label = roleLabel(role.role.title, role.packTitle);
  const web = role.role.tools.includes('web');
  const index = skillIndex(role.copy, role.skills);
  const instructionsFile = path.join(role.copy, ...role.role.instructions.split('/'));
  const mcpServers: Record<string, ClaudeServerConfig> = {};
  const codexConfig: string[] = [];
  const env: Record<string, string> = {};
  const yours = new Set((role.userServers[provider] ?? []).map(name => name.toLowerCase()));
  for (const server of role.servers) {
    const name = `${role.pack}-${server.id}`;
    const skip = (why: string) => { notes.push(`The ${name} server was left out: ${why}.`); };
    if (yours.has(name.toLowerCase())) { skip('you already have a server with that name'); continue; }
    if (provider === 'codex' && server.info.claudeOnly) { skip(`Codex can't use it. ${server.info.claudeOnly.replace(/\.$/, '')}`); continue; }
    const { spec } = server;
    const values = spec.type === 'stdio' ? [...spec.args, ...Object.values(spec.env)] : [spec.url, ...Object.values(spec.headers), ...(spec.bearerTokenEnvVar ? [`\${${spec.bearerTokenEnvVar}}`] : [])];
    const unset = unsetVariables(values, options.env, platform);
    if (unset.length) { skip(`${unset.map(variable => `\${${variable}}`).join(', ')} ${unset.length === 1 ? 'isn\'t' : 'aren\'t'} set in your environment`); continue; }
    if (provider === 'claude') { mcpServers[name] = claudeServer(server, role); continue; }
    const codex = codexServer(name, server, role, options, env);
    if ('skip' in codex) { skip(codex.skip); continue; }
    codexConfig.push(...codex.config);
    Object.assign(env, codex.env);
  }
  // Paths on a shim's command line meet cmd.exe; one it would misread is left out rather than mangled.
  const onCommandLine = (file: string | undefined, what: string): string | undefined => {
    if (file && options.shim && cmdUnsafe.test(file)) { notes.push(`The role's ${what} was left out: its path has characters cmd.exe reads as commands.`); return undefined; }
    return file;
  };
  const pluginDir = provider === 'claude' && role.skills.length ? onCommandLine(role.plugin, 'skills') : undefined;
  if (provider === 'claude' && role.skills.length && !role.plugin) notes.push('The role\'s skills were left out: Hydra couldn\'t build their plugin.');
  return {
    ref: role.ref, title: role.role.title, label, changes: role.role.changes, tools: [...role.role.tools],
    text: [role.instructions.trim(), ...(index ? ['', index] : [])].join('\n'),
    ...(index ? { skillIndex: index } : {}),
    skills: role.skills.map(skill => ({ id: skill.id, file: skillFile(role.copy, skill.id) })),
    instructionsFile,
    ...(pluginDir ? { pluginDir } : {}),
    mcpServers, codexConfig, env,
    allowedTools: provider === 'claude' ? [...(pluginDir ? ['Skill'] : []), ...Object.keys(mcpServers).map(name => `mcp__${name}`), ...(web ? ['WebSearch', 'WebFetch'] : [])] : [],
    webSearch: web ? 'live' : 'disabled',
    ...(role.role.model && role.role.provider === provider ? { model: role.role.model } : {}),
    notes,
  };
}

// ---- Instructions on a Codex lane's command line ----

/** Developer instructions stay well inside cmd.exe's 8191-character line (research R2). */
export const developerInstructionsMax = 2000;
/**
 * A role's text as the value of `-c developer_instructions='…'` (R2): one line; through a
 * `.cmd` shim, only characters cmd.exe reads literally (shimSafe). Straight quotes become
 * typographic ones, so the text stays one TOML literal string (processLaunch passes those
 * through PowerShell intact). Undefined when it is still too long: the first prompt gets it then.
 */
export function codexDeveloperInstructions(text: string, shim: boolean): string | undefined {
  const flat = (shim ? shimSafe(text) : oneLine(text)).replace(/'/g, '\u2019').replace(/"/g, '\u201d');
  return flat && flat.length <= developerInstructionsMax ? flat : undefined;
}

/**
 * A Codex lane's role in its first prompt, when the developer instructions can't carry it
 * (section 5): the text itself when it fits `max`, else where to read it.
 */
export function roleFirstPrompt(role: Pick<RoleLaunch, 'text' | 'instructionsFile' | 'skills'>, max: number): string {
  const inline = `Your role's instructions: ${oneLine(role.text)}`;
  if (inline.length <= max) return inline;
  const pointer = `Read your role's instructions in ${role.instructionsFile} before you start, and follow them.`;
  const shown = role.skills.slice(0, 6).map(skill => `${skill.id} (${skill.file})`);
  const index = shown.length ? ` Skills you can use, each described in its file (read it before you use the skill): ${shown.join(', ')}${role.skills.length > shown.length ? ` and ${role.skills.length - shown.length} more beside them` : ''}.` : '';
  return clip(`${pointer}${index}`, Math.max(max, pointer.length));
}
