import type { McpServerSpec } from '../../core/mcpServers';

/**
 * Pure parsing/formatting for the MCP servers page's Add form and row
 * summaries. No `vscode` import, so these are unit tested directly
 * (tests/mcpServersPage.test.ts); the client-side script embedded in
 * mcpServers.ts re-implements the same shapes in plain JS (the shell's
 * script is a string, not a module — see src/settings/search.ts /
 * shell.ts for the same split).
 */

/** Non-blank, trimmed lines, in order. */
export function parseLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
}

/** One argument per line (a whole line, trimmed; nothing else is inferred). */
export function parseArgsText(text: string): string[] {
  return parseLines(text);
}
export function formatArgsText(args: readonly string[]): string {
  return args.join('\n');
}

export interface ParsedPairs {
  values: Record<string, string>;
  /** One message per line Hydra couldn't parse; the line itself is left out of `values`. */
  errors: string[];
}
/** `KEY=VALUE` per line, for environment variables. */
export function parseEnvText(text: string): ParsedPairs {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  parseLines(text).forEach((line, index) => {
    const at = line.indexOf('=');
    if (at <= 0) { errors.push(`Line ${index + 1}: expected KEY=VALUE.`); return; }
    const key = line.slice(0, at).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { errors.push(`Line ${index + 1}: "${key}" isn't a valid environment variable name.`); return; }
    values[key] = line.slice(at + 1);
  });
  return { values, errors };
}
export function formatEnvText(env: Record<string, string>): string {
  return Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
}

/** `Name: value` per line, for HTTP headers. */
export function parseHeadersText(text: string): ParsedPairs {
  const values: Record<string, string> = {};
  const errors: string[] = [];
  parseLines(text).forEach((line, index) => {
    const at = line.indexOf(':');
    if (at <= 0) { errors.push(`Line ${index + 1}: expected "Header-Name: value".`); return; }
    const key = line.slice(0, at).trim();
    if (!key) { errors.push(`Line ${index + 1}: a header needs a name.`); return; }
    values[key] = line.slice(at + 1).trim();
  });
  return { values, errors };
}
export function formatHeadersText(headers: Record<string, string>): string {
  return Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\n');
}

/** One-line summary for a server row: the command and its args, or the URL. Truncated for display. */
export function summarizeSpec(spec: McpServerSpec, maxLength = 160): string {
  const text = spec.type === 'stdio' ? [spec.command, ...spec.args].join(' ') : spec.url;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

export const mcpAgentLabel = (agent: 'claude' | 'codex'): string => agent === 'claude' ? 'Claude Code' : 'Codex';
