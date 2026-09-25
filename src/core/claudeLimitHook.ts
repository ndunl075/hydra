import path from 'node:path';
import { parseCliVersion } from './cliVersions';

/**
 * Hydra's Claude Code `StopFailure` hook (docs/Hydra_Agent_Plan.md, "Detect the
 * limit"). One matcher group in the user's ~/.claude/settings.json runs
 * dist/hydra-limit-hook.cjs when a turn ends on `rate_limit`; the script drops an
 * event file that Hydra's windows pick up (limitWatcher.ts).
 *
 * The hook uses exec form (`args`, Claude Code 2.1.139+): no shell parses Hydra's
 * paths. Hooks can't set environment variables, and Hydra's executable only runs
 * as Node with ELECTRON_RUN_AS_NODE=1, so a system shell sets it:
 * - Windows: powershell.exe (absolute path) `-Command` with single-quoted paths.
 *   Every Windows has it; it isn't subject to the script execution policy, and
 *   the child inherits the hook's stdin untouched.
 * - Elsewhere: /bin/sh -c 'ELECTRON_RUN_AS_NODE=1 exec "$0" "$@"' with the paths as
 *   separate arguments.
 *
 * The group is inserted and removed like the allow rule: without reformatting the
 * file, next to any hooks the user has, and removal is the byte-exact inverse of
 * insertion whenever the user hasn't edited around it. (Two originals can fill to
 * the same text: an empty `"hooks": {}` and no "hooks" at all, or empty lists in a
 * one-line file. Removal then gives equal settings, not the same bytes.)
 */
export const limitHookMarker = 'hydra-limit-hook';
/** Hook `args` (exec form) arrived in Claude Code 2.1.139; older versions would run `command` through a shell. */
export const limitHookMinimumClaude = { major: 2, minor: 1, patch: 139 };
export interface ClaudeCommandHook { type: 'command'; command: string; args: string[]; timeout: number }
export interface LimitHookGroup { matcher: string; hooks: ClaudeCommandHook[] }

/** A PowerShell single-quoted string. PowerShell also treats the typographic single quotes as quotes; doubling escapes each. */
function powershellLiteral(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('A Hydra path contains a line break.');
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
}
export function limitHookGroup(options: { executable: string; script: string; eventsDir: string; platform?: NodeJS.Platform; systemRoot?: string }): LimitHookGroup {
  const { executable, script, eventsDir } = options;
  if ((options.platform ?? process.platform) === 'win32') {
    const root = options.systemRoot || process.env.SystemRoot || 'C:\\Windows';
    const run = `$env:ELECTRON_RUN_AS_NODE='1'; & ${powershellLiteral(executable)} ${powershellLiteral(script)} ${powershellLiteral(eventsDir)}; exit 0`;
    return { matcher: 'rate_limit', hooks: [{ type: 'command', command: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', run], timeout: 30 }] };
  }
  return { matcher: 'rate_limit', hooks: [{ type: 'command', command: '/bin/sh', args: ['-c', 'ELECTRON_RUN_AS_NODE=1 exec "$0" "$@"', executable, script, eventsDir], timeout: 30 }] };
}
/** Whether `claude --version` output is new enough for exec-form hooks. */
export function claudeSupportsLimitHook(versionOutput: string): boolean {
  const version = parseCliVersion(versionOutput), min = limitHookMinimumClaude;
  if (!version) return false;
  return version.major !== min.major ? version.major > min.major : version.minor !== min.minor ? version.minor > min.minor : version.patch >= min.patch;
}
/** A matcher group Hydra wrote: one command hook whose command line names hydra-limit-hook. */
export function isHydraLimitGroup(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const hooks = (value as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks) || hooks.length !== 1) return false;
  const hook = hooks[0] as { command?: unknown; args?: unknown } | undefined;
  const line = [hook?.command, ...(Array.isArray(hook?.args) ? hook.args : [])].filter(part => typeof part === 'string').join(' ');
  return line.includes(limitHookMarker);
}

// ---- A JSON scanner that keeps source positions, so edits touch only Hydra's bytes ----

interface JsonNode { start: number; end: number; kind: 'object' | 'array' | 'value'; members?: { key: string; keyStart: number; value: JsonNode }[]; elements?: JsonNode[] }
function scanJson(text: string): JsonNode {
  let at = 0;
  const space = () => { while (at < text.length && ' \t\r\n\uFEFF'.includes(text[at]!)) at++; };
  const string = (): string => {
    const start = at++;
    while (text[at] !== '"') { if (at >= text.length) throw new Error('Unterminated string.'); at += text[at] === '\\' ? 2 : 1; }
    at++;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const value = (): JsonNode => {
    space();
    const start = at, char = text[at];
    if (char === '{') {
      at++; const members: NonNullable<JsonNode['members']> = [];
      space();
      if (text[at] === '}') { at++; return { start, end: at, kind: 'object', members }; }
      for (;;) {
        space(); const keyStart = at; const key = string();
        space(); if (text[at++] !== ':') throw new Error('Expected ":".');
        members.push({ key, keyStart, value: value() });
        space(); const next = text[at++];
        if (next === '}') return { start, end: at, kind: 'object', members };
        if (next !== ',') throw new Error('Expected "," or "}".');
      }
    }
    if (char === '[') {
      at++; const elements: JsonNode[] = [];
      space();
      if (text[at] === ']') { at++; return { start, end: at, kind: 'array', elements }; }
      for (;;) {
        elements.push(value());
        space(); const next = text[at++];
        if (next === ']') return { start, end: at, kind: 'array', elements };
        if (next !== ',') throw new Error('Expected "," or "]".');
      }
    }
    if (char === '"') { string(); return { start, end: at, kind: 'value' }; }
    while (at < text.length && !',}] \t\r\n'.includes(text[at]!)) at++;
    if (at === start) throw new Error('Expected a value.');
    return { start, end: at, kind: 'value' };
  };
  const root = value();
  space();
  if (at !== text.length) throw new Error('Unexpected text after JSON.');
  return root;
}

const eolOf = (text: string) => text.includes('\r\n') ? '\r\n' : '\n';
/** The file's indent unit: the first indented line's leading whitespace. */
const unitOf = (text: string) => /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
/** Leading whitespace of the line containing `at`. */
const lineIndent = (text: string, at: number) => /^[ \t]*/.exec(text.slice(text.lastIndexOf('\n', at - 1) + 1))![0];
/** True when only whitespace precedes `at` on its line. */
const startsLine = (text: string, at: number) => /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', at - 1) + 1, at));
const member = (node: JsonNode | undefined, key: string) => node?.members?.find(entry => entry.key === key);

/** Append a member (`key`) or element to an object or array, in the container's own style. */
function append(text: string, container: JsonNode, key: string | undefined, value: unknown): string {
  const eol = eolOf(text), unit = unitOf(text), pretty = text.includes('\n');
  const piece = (base: string, compact: boolean) => {
    const rendered = compact ? JSON.stringify(value) : JSON.stringify(value, null, unit).split('\n').join(eol + base);
    return key === undefined ? rendered : `${JSON.stringify(key)}${compact && !pretty ? ':' : ': '}${rendered}`;
  };
  const items = (container.kind === 'object' ? container.members!.map(entry => ({ start: entry.keyStart, end: entry.value.end })) : container.elements!.map(node => ({ start: node.start, end: node.end })));
  const last = items[items.length - 1];
  if (last) {
    if (text.slice(container.start, container.end).includes('\n')) {
      const indent = startsLine(text, last.start) ? lineIndent(text, last.start) : lineIndent(text, container.start) + unit;
      return text.slice(0, last.end) + `,${eol}${indent}${piece(indent, false)}` + text.slice(last.end);
    }
    const before = items[items.length - 2];
    const separator = before ? text.slice(before.end, items[items.length - 1]!.start) : pretty ? ', ' : ',';
    return text.slice(0, last.end) + separator + piece('', true) + text.slice(last.end);
  }
  const open = text[container.start]!, close = text[container.end - 1]!;
  const base = lineIndent(text, container.start), inner = base + unit;
  // An empty list is filled as `[{ … }]`, so it reads differently from a list Hydra
  // created (`[ { … } ]`) and removal can tell which one to undo.
  const replacement = !pretty ? `${open}${piece('', true)}${close}` : container.kind === 'array' ? `${open}${piece(base, false)}${close}` : `${open}${eol}${inner}${piece(inner, false)}${eol}${base}${close}`;
  return text.slice(0, container.start) + replacement + text.slice(container.end);
}

/** Add the group with no idempotence or upgrade handling. The single definition of "how Hydra inserts", which removal inverts. */
function insert(text: string, group: unknown): string {
  const root = scanJson(text);
  if (root.kind !== 'object') throw new Error('Claude settings.json is not a JSON object.');
  const hooks = member(root, 'hooks');
  if (!hooks) return append(text, root, 'hooks', { StopFailure: [group] });
  if (hooks.value.kind !== 'object') throw new Error('"hooks" in Claude settings.json is not an object. Fix it by hand, then connect again.');
  const stop = member(hooks.value, 'StopFailure');
  if (!stop) return append(text, hooks.value, 'StopFailure', [group]);
  if (stop.value.kind !== 'array') throw new Error('"hooks.StopFailure" in Claude settings.json is not a list. Fix it by hand, then connect again.');
  return append(text, stop.value, undefined, group);
}

interface Found { root: JsonNode; hooks: NonNullable<ReturnType<typeof member>>; stop: NonNullable<ReturnType<typeof member>>; index: number }
function findHydraGroup(text: string): Found | undefined {
  const root = scanJson(text);
  const hooks = member(root, 'hooks'), stop = hooks && member(hooks.value, 'StopFailure');
  if (!hooks || !stop || stop.value.kind !== 'array') return undefined;
  const index = stop.value.elements!.findIndex(node => { try { return isHydraLimitGroup(JSON.parse(text.slice(node.start, node.end))); } catch { return false; } });
  return index < 0 ? undefined : { root, hooks, stop, index };
}
const splice = (text: string, from: number, to: number, replacement = '') => text.slice(0, from) + replacement + text.slice(to);

/** Remove one Hydra group: the text that, with the group inserted, gives `text` back; else a plain structural removal. */
function removeOne(text: string, found: Found): string {
  const { root, hooks, stop, index } = found;
  const elements = stop.value.elements!, element = elements[index]!;
  const group = JSON.parse(text.slice(element.start, element.end)) as unknown;
  const withoutElement = index > 0 ? splice(text, elements[index - 1]!.end, element.end) : elements.length > 1 ? splice(text, element.start, elements[1]!.start) : splice(text, stop.value.start, stop.value.end, '[]');
  const candidates: string[] = [];
  if (elements.length === 1) {
    const hookMembers = hooks.value.members!, stopIndex = hookMembers.indexOf(stop);
    if (hookMembers.length === 1) {
      const rootMembers = root.members!, hooksIndex = rootMembers.indexOf(hooks);
      if (rootMembers.length === 1) candidates.push(splice(text, root.start, root.end, '{}'));
      else if (hooksIndex > 0) candidates.push(splice(text, rootMembers[hooksIndex - 1]!.value.end, hooks.value.end));
      candidates.push(splice(text, hooks.value.start, hooks.value.end, '{}'));
    } else if (stopIndex > 0) candidates.push(splice(text, hookMembers[stopIndex - 1]!.value.end, stop.value.end));
  }
  candidates.push(withoutElement);
  for (const candidate of candidates) { try { if (insert(candidate, group) === text) return candidate; } catch { /* not a valid original */ } }
  return withoutElement;
}

/** Settings text with every Hydra StopFailure group removed, and whether there was one. */
export function removeClaudeLimitHook(text: string | undefined): { text: string | undefined; had: boolean } {
  if (text === undefined || !text.trim()) return { text, had: false };
  let current = text, had = false;
  for (let found = findHydraGroup(current); found; found = findHydraGroup(current)) { current = removeOne(current, found); had = true; }
  return { text: current, had };
}
/** Insert the group, replacing an older Hydra group (a moved Hydra install). Unchanged when it's already there. */
export function addClaudeLimitHook(text: string | undefined, group: LimitHookGroup): string {
  if (!text?.trim()) return JSON.stringify({ hooks: { StopFailure: [group] } }, null, 2) + '\n';
  if (limitHookState(text, group) === 'current') return text;
  return insert(removeClaudeLimitHook(text).text!, group);
}
/** The Hydra groups in the file now. */
export function readClaudeLimitHooks(text: string | undefined): unknown[] {
  if (!text?.trim()) return [];
  try {
    const stop = (JSON.parse(text.replace(/^\uFEFF/, '')) as { hooks?: { StopFailure?: unknown } }).hooks?.StopFailure;
    return Array.isArray(stop) ? stop.filter(isHydraLimitGroup) : [];
  } catch { return []; }
}
export function limitHookState(text: string | undefined, group: LimitHookGroup): 'missing' | 'current' | 'stale' {
  const found = readClaudeLimitHooks(text);
  if (!found.length) return 'missing';
  return found.length === 1 && JSON.stringify(found[0]) === JSON.stringify(group) ? 'current' : 'stale';
}
