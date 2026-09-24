import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { replaceAtomic } from './atomicFile';
import { leadGuidanceMarkdown } from './helperTools';
import { processLaunch } from './process';

/**
 * Connecting Claude Code and Codex to Hydra (docs/Official_Extensions_Plan.md,
 * Phase 5). The connection is between Hydra and the user's Claude Code / Codex
 * install, never a project: Hydra adds itself as a user-level tool server named
 * "hydra" and nothing is written inside any repository.
 *
 * - Claude: registered through Claude's own `claude mcp add-json -s user`
 *   (Claude rewrites ~/.claude.json itself all the time), plus one "mcp__hydra"
 *   allow rule inserted into ~/.claude/settings.json without reformatting it.
 * - Codex: one clearly marked block appended to ~/.codex/config.toml. `codex mcp
 *   add` reformats the whole file, so Hydra writes and removes only its block;
 *   the rest of the file stays byte-identical.
 */
export type ConnectableProvider = 'claude' | 'codex';
export interface HelperServerSpec { command: string; args: string[]; env: Record<string, string> }
export interface ConnectionStatus { provider: ConnectableProvider; connected: boolean; current: boolean; error?: string }

export const serverName = 'hydra';
export const claudeAllowRule = 'mcp__hydra';
const blockStart = '# >>> Hydra helpers (managed by Hydra: connect or disconnect in Hydra Settings)';
const blockEnd = '# <<< Hydra helpers';

export interface ProviderPaths { claudeJson: string; claudeSettings: string; codexConfig: string }
export function providerPaths(env: NodeJS.ProcessEnv = process.env): ProviderPaths {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  return {
    claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homedir(), '.claude.json'),
    claudeSettings: path.join(claudeDir, 'settings.json'),
    codexConfig: path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml'),
  };
}

/** A file's text, or undefined when it doesn't exist. */
export const read = async (file: string): Promise<string | undefined> => { try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } };
export async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.hydra-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(temporary, text, 'utf8');
  try { await replaceAtomic(temporary, file); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
/** The file's own line ending: CRLF if it has any, else LF. */
export const eolOf =(text: string) => text.includes('\r\n') ? '\r\n' : '\n';

// ---- Codex ----

/** A TOML literal string. Paths never contain a single quote; refuse rather than mis-quote. */
function literal(value: string): string {
  if (value.includes("'") || /[\r\n]/.test(value)) throw new Error('A Hydra head setting contains a quote or line break.');
  return `'${value}'`;
}
export function codexBlock(spec: HelperServerSpec, eol = '\n'): string {
  return [
    '', blockStart,
    `[mcp_servers.${serverName}]`,
    `command = ${literal(spec.command)}`,
    `args = [${spec.args.map(literal).join(', ')}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 3600',
    "default_tools_approval_mode = 'approve'",
    '',
    `[mcp_servers.${serverName}.env]`,
    ...Object.entries(spec.env).map(([key, value]) => `${key} = ${literal(value)}`),
    blockEnd, '',
  ].join(eol);
}
/** The text without Hydra's block, and whether it had one. Byte-exact inverse of addCodexBlock. */
export function removeCodexBlock(text: string): { text: string; had: boolean } {
  return removeMarkedBlock(text, blockStart, blockEnd, 'Hydra\'s block in the Codex config is damaged. Remove the lines between the Hydra markers by hand.');
}
/**
 * Remove one block that was appended as `eol + start + eol + … + eol + end + eol`
 * (its lines joined with the file's own line ending, with an empty first and last
 * element). The byte-exact inverse of appending it, whatever came before or after.
 */
export function removeMarkedBlock(text: string, start: string, end: string, damaged: string): { text: string; had: boolean } {
  for (const eol of ['\r\n', '\n']) {
    const from = text.indexOf(`${eol}${start}${eol}`);
    if (from < 0) continue;
    const endMarker = `${eol}${end}${eol}`;
    const to = text.indexOf(endMarker, from);
    if (to < 0) throw new Error(damaged);
    return { text: text.slice(0, from) + text.slice(to + endMarker.length), had: true };
  }
  return { text, had: false };
}
export function addCodexBlock(text: string, spec: HelperServerSpec): string {
  const without = removeCodexBlock(text).text;
  if (new RegExp(`^\\s*\\[mcp_servers\\.${serverName}(\\]|\\.)`, 'm').test(without)) throw new Error(`Your Codex config already has an "${serverName}" MCP server that Hydra didn't add. Rename or remove it first.`);
  return without + codexBlock(spec, eolOf(without || '\n'));
}
/**
 * Codex may not read an MCP server's instructions, so the lead guidance (when to
 * start heads without being asked) also goes into Codex's global AGENTS.md, next
 * to config.toml, as a marked block removed byte-exactly on disconnect.
 */
const guidanceStart = '<!-- >>> Hydra heads (managed by Hydra: connect or disconnect in Hydra Settings) -->';
const guidanceEnd = '<!-- <<< Hydra heads -->';
export const codexAgentsFile = (configFile: string) => path.join(path.dirname(configFile), 'AGENTS.md');
export function guidanceBlock(eol = '\n'): string { return ['', guidanceStart, ...leadGuidanceMarkdown.trimEnd().split('\n'), guidanceEnd, ''].join(eol); }
export function removeGuidanceBlock(text: string): { text: string; had: boolean } {
  return removeMarkedBlock(text, guidanceStart, guidanceEnd, 'Hydra\'s block in Codex\'s AGENTS.md is damaged. Remove the lines between the Hydra markers by hand.');
}
export function addGuidanceBlock(text: string): string {
  const without = removeGuidanceBlock(text).text;
  return without + guidanceBlock(eolOf(without || '\n'));
}

export async function codexStatus(file: string, spec: HelperServerSpec): Promise<ConnectionStatus> {
  try {
    const text = await read(file) ?? '', agents = await read(codexAgentsFile(file)) ?? '';
    const had = removeCodexBlock(text).had;
    const guided = agents.includes(guidanceBlock(eolOf(agents)).trim());
    return { provider: 'codex', connected: had, current: had && guided && text.includes(codexBlock(spec, eolOf(text)).trim()) };
  } catch (error) { return { provider: 'codex', connected: false, current: false, error: error instanceof Error ? error.message : String(error) }; }
}
export async function connectCodex(file: string, spec: HelperServerSpec): Promise<void> {
  const config = addCodexBlock(await read(file) ?? '', spec);
  const agentsFile = codexAgentsFile(file);
  await writeAtomic(agentsFile, addGuidanceBlock(await read(agentsFile) ?? ''));
  await writeAtomic(file, config);
}
export async function disconnectCodex(file: string): Promise<void> {
  const text = await read(file);
  if (text !== undefined) {
    const removed = removeCodexBlock(text);
    if (removed.had) await writeAtomic(file, removed.text);
  }
  const agentsFile = codexAgentsFile(file), agents = await read(agentsFile);
  if (agents === undefined) return;
  const removed = removeGuidanceBlock(agents);
  if (!removed.had) return;
  // Hydra created the file if nothing else is left in it.
  if (removed.text === '') await rm(agentsFile, { force: true });
  else await writeAtomic(agentsFile, removed.text);
}

// ---- Claude ----

/** Insert the allow rule into "permissions.allow" without reformatting the file. */
export function addClaudeAllowRule(text: string | undefined): string {
  if (!text?.trim()) return JSON.stringify({ permissions: { allow: [claudeAllowRule] } }, null, 2) + '\n';
  const parsed = JSON.parse(text) as { permissions?: { allow?: unknown } };
  const allow = parsed.permissions?.allow;
  if (Array.isArray(allow) && allow.includes(claudeAllowRule)) return text;
  const eol = eolOf(text);
  const match = /"allow"\s*:\s*\[/.exec(text);
  if (match && Array.isArray(allow)) {
    const at = match.index + match[0].length;
    const next = /\S/.exec(text.slice(at));
    const indent = /(\r?\n)([ \t]*)"allow"/.exec(text.slice(0, at))?.[2] ?? '  ';
    const insertion = next?.[0] === ']' ? `"${claudeAllowRule}"` : `${eol}${indent}  "${claudeAllowRule}",`;
    return text.slice(0, at) + insertion + text.slice(at);
  }
  // No allow list to extend: rewrite with the rule added (formatting of this rare case is not preserved).
  const permissions = (parsed.permissions && typeof parsed.permissions === 'object' ? parsed.permissions : {}) as Record<string, unknown>;
  return JSON.stringify({ ...parsed, permissions: { ...permissions, allow: [...(Array.isArray(allow) ? allow : []), claudeAllowRule] } }, null, 2) + eol;
}
/** Exact inverse of addClaudeAllowRule's in-place insertions. */
export function removeClaudeAllowRule(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  for (const eol of ['\r\n', '\n']) {
    const found = new RegExp(`${eol.replace('\r', '\\r').replace('\n', '\\n')}[ \\t]*"${claudeAllowRule}",`).exec(text);
    if (found) return text.slice(0, found.index) + text.slice(found.index + found[0].length);
  }
  if (text.includes(`[\"${claudeAllowRule}\"]`)) return text.replace(`[\"${claudeAllowRule}\"]`, '[]');
  return text;
}

export async function claudeStatus(paths: ProviderPaths, spec: HelperServerSpec): Promise<ConnectionStatus> {
  try {
    const config = JSON.parse(await read(paths.claudeJson) ?? '{}') as { mcpServers?: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };
    const entry = config.mcpServers?.[serverName];
    const current = !!entry && entry.command === spec.command && JSON.stringify(entry.args) === JSON.stringify(spec.args) && JSON.stringify(entry.env) === JSON.stringify(spec.env);
    return { provider: 'claude', connected: !!entry, current };
  } catch (error) { return { provider: 'claude', connected: false, current: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Run Claude's CLI with an argument array (no shell string; `.cmd` shims go through processLaunch). */
export function runClaude(executable: string, args: string[]): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    execFile(launch.executable, launch.args, { windowsHide: true, timeout: 60_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0, output: `${stdout}${stderr}` });
    });
  });
}
export async function connectClaude(executable: string, paths: ProviderPaths, spec: HelperServerSpec): Promise<void> {
  await runClaude(executable, ['mcp', 'remove', '-s', 'user', serverName]);
  const added = await runClaude(executable, ['mcp', 'add-json', '-s', 'user', serverName, JSON.stringify({ type: 'stdio', command: spec.command, args: spec.args, env: spec.env, timeout: 3_600_000 })]);
  if (added.code !== 0) throw new Error(`Claude Code could not add Hydra: ${added.output.trim().slice(0, 300)}`);
  const settings = await read(paths.claudeSettings);
  const updated = addClaudeAllowRule(settings);
  if (updated !== settings) await writeAtomic(paths.claudeSettings, updated);
}
export async function disconnectClaude(executable: string | undefined, paths: ProviderPaths): Promise<void> {
  if (executable) await runClaude(executable, ['mcp', 'remove', '-s', 'user', serverName]);
  const settings = await read(paths.claudeSettings);
  const updated = removeClaudeAllowRule(settings);
  if (settings !== undefined && updated !== settings) await writeAtomic(paths.claudeSettings, updated!);
}
