import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { git as realGit } from './git';
import { maskSecret } from './mcpServers';
import type { Handoff, LimitEvent } from './limitEvents';
import type { Job } from './jobs';

/**
 * Phase 2 (docs/Hydra_Agent_Plan.md, "Build the handoff without asking a
 * model"): assemble a continuation brief mechanically — no model call — from
 * a Claude transcript, a Codex rollout, or a head's own state, plus git.
 * Phase 3 decides where the result is written and offered; this module only
 * builds the `Handoff`.
 */

// ---- Injectable IO (real filesystem/git by default; fakes in tests) ----

export interface CodexRolloutCandidate { path: string; mtimeMs: number }

export interface HandoffDeps {
  /** Last `maxBytes` of a file as utf8 text. Empty string when the file is missing or unreadable. */
  readTail(filePath: string, maxBytes: number): Promise<string>;
  /** First `maxBytes` of a file as utf8 text. Empty string when the file is missing or unreadable. */
  readHead(filePath: string, maxBytes: number): Promise<string>;
  /** Every `rollout-*.jsonl` under `<codexHome>/sessions/**`, with its mtime. */
  listCodexRollouts(codexHome: string): Promise<CodexRolloutCandidate[]>;
  /** `git <args>` in `cwd`. Throws on failure — callers never let this fail the whole handoff. */
  git(cwd: string, args: string[]): Promise<string>;
  now(): Date;
  env: NodeJS.ProcessEnv;
}

async function readRange(filePath: string, start: number, length: number): Promise<string> {
  if (length <= 0) return '';
  let handle;
  try { handle = await open(filePath, 'r'); } catch { return ''; }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; }
  finally { await handle.close(); }
}

async function defaultReadHead(filePath: string, maxBytes: number): Promise<string> { return readRange(filePath, 0, maxBytes); }
async function defaultReadTail(filePath: string, maxBytes: number): Promise<string> {
  let size: number;
  try { size = (await stat(filePath)).size; } catch { return ''; }
  return readRange(filePath, Math.max(0, size - maxBytes), Math.min(maxBytes, size));
}

async function defaultListCodexRollouts(codexHome: string): Promise<CodexRolloutCandidate[]> {
  const sessionsDir = path.join(codexHome, 'sessions');
  let entries;
  try { entries = await readdir(sessionsDir, { recursive: true, withFileTypes: true }); }
  catch { return []; }
  const out: CodexRolloutCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
    const full = path.join((entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? sessionsDir, entry.name);
    try { out.push({ path: full, mtimeMs: (await stat(full)).mtimeMs }); } catch { /* gone between listing and stat */ }
  }
  return out;
}

export function defaultHandoffDeps(env: NodeJS.ProcessEnv = process.env): HandoffDeps {
  return {
    readTail: defaultReadTail,
    readHead: defaultReadHead,
    listCodexRollouts: defaultListCodexRollouts,
    git: realGit,
    now: () => new Date(),
    env,
  };
}

// ---- Input ----

/** One handoff request. `job` present selects the head branch; otherwise `event.provider` picks Claude vs. Codex chat. */
export interface HandoffInput { event: LimitEvent; job?: Job }

const providerLabel = { claude: 'Claude Code', codex: 'Codex' } as const;

export function handoffFileName(event: LimitEvent): string {
  const stamp = event.at.replace(/[:.]/g, '-').replace(/[^0-9A-Za-z-]/g, '');
  return `HANDOFF-${event.provider}-${event.source}-${stamp}.md`;
}

// ---- Transcript extraction (pure; fed strings) ----

export interface ExtractedTranscript {
  ask?: string;
  recentUserMessages: string[];
  filesTouched: string[];
  commands: string[];
  lastAssistantText?: string;
  todoPending: string[];
  todoInProgress: string[];
}

const emptyExtraction = (): ExtractedTranscript => ({ recentUserMessages: [], filesTouched: [], commands: [], todoPending: [], todoInProgress: [] });

/** Whole-text wrapped entirely in one XML-ish tag (`<system-reminder>…</…>`, `<command-name>…`) — injected framework text, not something the user wrote. */
function isWrapperOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^<([a-zA-Z][\w-]*)>[\s\S]*<\/\1>\s*$/.test(trimmed) || /^<[a-zA-Z][\w-]*[^>]*\/>\s*$/.test(trimmed);
}

function relativeToCwd(filePath: string, cwd: string): string {
  if (!filePath) return filePath;
  try {
    const relative = path.relative(cwd, filePath);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative.replace(/\\/g, '/');
  } catch { /* fall through */ }
  return filePath.replace(/\\/g, '/');
}

function pushUnique(list: string[], value: string, max: number): void {
  if (!value || list.includes(value)) return;
  if (list.length < max) list.push(value);
}

function maskCommandLine(line: string): string {
  return line.split(/(\s+)/).map(token => {
    if (!token || /^\s+$/.test(token)) return token;
    const assignment = /^([A-Za-z_][\w.-]*)=(.+)$/.exec(token);
    if (assignment) return `${assignment[1]}=${maskSecret(assignment[1], assignment[2] ?? '')}`;
    return maskSecret(undefined, token);
  }).join('');
}

function parseJsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed/truncated lines */ }
  }
  return out;
}

interface TodoItem { content?: string; activeForm?: string; status?: string }

/**
 * Claude Code session transcript (JSONL): lines of `type: "user"|"assistant"`
 * with `message.content` a string or array of blocks (`text`, `tool_use`
 * `{name, input}`, `tool_result`). Fields used: `type`, `message.role`,
 * `message.content[].type/text/name/input`.
 */
export function parseClaudeTranscript(text: string, cwd: string): ExtractedTranscript {
  const result = emptyExtraction();
  const userTexts: string[] = [];
  let lastTodos: TodoItem[] | undefined;
  for (const raw of parseJsonLines(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const line = raw as { type?: string; message?: { role?: string; content?: unknown } };
    const content = line.message?.content;
    if (line.type === 'user') {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && !isWrapperOnly(block.text)) userTexts.push(block.text.trim());
      }
    } else if (line.type === 'assistant') {
      const blocks = Array.isArray(content) ? content : [];
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) result.lastAssistantText = block.text.trim();
        if (block.type === 'tool_use' && typeof block.name === 'string') {
          const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>;
          if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name) && typeof input.file_path === 'string') {
            pushUnique(result.filesTouched, relativeToCwd(input.file_path, cwd), 200);
          } else if ((block.name === 'Bash' || block.name === 'PowerShell') && typeof input.command === 'string') {
            result.commands.push(maskCommandLine(input.command.slice(0, 400)));
          } else if (block.name === 'TodoWrite' && Array.isArray(input.todos)) {
            lastTodos = input.todos as TodoItem[];
          }
        }
      }
    }
  }
  result.ask = userTexts[0];
  result.recentUserMessages = userTexts.slice(-3);
  result.commands = result.commands.slice(-8);
  if (lastTodos) {
    for (const item of lastTodos) {
      const label = (item.content || item.activeForm || '').trim();
      if (!label) continue;
      if (item.status === 'pending') result.todoPending.push(label);
      else if (item.status === 'in_progress') result.todoInProgress.push(label);
    }
  }
  return result;
}

/**
 * Codex session rollout (JSONL): `session_meta` (payload.cwd), `response_item`
 * with `payload.type: "message"` (`role`, `content[].type: "input_text"|"output_text"`)
 * or `payload.type: "function_call"` (`name`, `arguments` — a JSON string with
 * `command`, or an `apply_patch` body with `*** Update/Add/Delete File:` lines).
 */
export function parseCodexRollout(text: string, cwd: string): ExtractedTranscript {
  const result = emptyExtraction();
  const userTexts: string[] = [];
  for (const raw of parseJsonLines(text)) {
    if (!raw || typeof raw !== 'object') continue;
    const line = raw as { type?: string; payload?: Record<string, unknown> };
    if (line.type !== 'response_item' || !line.payload) continue;
    const payload = line.payload;
    if (payload.type === 'message') {
      const role = payload.role;
      const blocks = Array.isArray(payload.content) ? payload.content : [];
      for (const block of blocks as Array<Record<string, unknown>>) {
        const value = typeof block.text === 'string' ? block.text : undefined;
        if (!value) continue;
        if (role === 'user' && (block.type === 'input_text' || block.type === 'text') && !isWrapperOnly(value)) userTexts.push(value.trim());
        if (role === 'assistant' && (block.type === 'output_text' || block.type === 'text') && value.trim()) result.lastAssistantText = value.trim();
      }
    } else if (payload.type === 'function_call' && typeof payload.name === 'string') {
      const rawArguments = typeof payload.arguments === 'string' ? payload.arguments : '';
      let parsedArguments: Record<string, unknown> | undefined;
      try { parsedArguments = JSON.parse(rawArguments); } catch { parsedArguments = undefined; }
      if (['shell_command', 'shell', 'exec_command', 'local_shell_call', 'container.exec'].includes(payload.name)) {
        const command = parsedArguments?.command;
        const commandText = typeof command === 'string' ? command : Array.isArray(command) ? command.join(' ') : undefined;
        if (commandText) result.commands.push(maskCommandLine(commandText.slice(0, 400)));
      } else if (payload.name === 'apply_patch') {
        const patchText = typeof parsedArguments?.input === 'string' ? parsedArguments.input : rawArguments;
        for (const match of patchText.matchAll(/\*\*\* (?:Update|Add|Delete) File: (.+)/g)) { const file = match[1]; if (file) pushUnique(result.filesTouched, relativeToCwd(file.trim(), cwd), 200); }
      }
    }
  }
  result.ask = userTexts[0];
  result.recentUserMessages = userTexts.slice(-3);
  result.commands = result.commands.slice(-8);
  return result;
}

// ---- Codex rollout selection ----

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const withForwardSlashes = value.replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? withForwardSlashes.toLowerCase() : withForwardSlashes;
  };
  return normalize(a) === normalize(b);
}

function readSessionMetaCwd(headText: string): string | undefined {
  const firstLine = headText.split('\n', 1)[0]?.trim();
  if (!firstLine) return undefined;
  try {
    const parsed = JSON.parse(firstLine) as { type?: string; payload?: { cwd?: string } };
    if (parsed.type === 'session_meta' && typeof parsed.payload?.cwd === 'string') return parsed.payload.cwd;
  } catch { /* truncated or malformed first line */ }
  return undefined;
}

const dayMs = 24 * 3600_000;

/** The most recently modified rollout from the last ~24h whose session cwd matches `cwd`. */
export async function findCodexRollout(deps: HandoffDeps, codexHome: string, cwd: string): Promise<string | undefined> {
  const candidates = await deps.listCodexRollouts(codexHome);
  const cutoff = deps.now().getTime() - dayMs;
  const recent = candidates.filter(candidate => candidate.mtimeMs >= cutoff).sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const candidate of recent) {
    const head = await deps.readHead(candidate.path, 8192);
    const metaCwd = readSessionMetaCwd(head);
    if (metaCwd && samePath(metaCwd, cwd)) return candidate.path;
  }
  return undefined;
}

export function codexHomeFrom(env: NodeJS.ProcessEnv): string { return env.CODEX_HOME || path.join(homedir(), '.codex'); }

// ---- Git ----

export interface GitSummary { branch?: string; status?: string; diffStat?: string; log?: string }

async function gitSummary(deps: HandoffDeps, cwd: string): Promise<GitSummary | undefined> {
  try {
    const [branch, status, diffStat, log] = await Promise.all([
      deps.git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      deps.git(cwd, ['status', '--porcelain']),
      deps.git(cwd, ['diff', '--stat']),
      deps.git(cwd, ['log', '--oneline', '-5']),
    ]);
    return { branch: branch.trim() || undefined, status: status.trim() || undefined, diffStat: diffStat.trim() || undefined, log: log.trim() || undefined };
  } catch {
    // Never fail the whole handoff over git.
    return undefined;
  }
}

// ---- Markdown rendering ----

const totalCap = 12 * 1024;

function blockquote(text: string): string { return text.split('\n').map(line => `> ${line}`).join('\n'); }
function fence(text: string): string { return '```\n' + text.replace(/```/g, '``​`') + '\n```'; }
function inlineCode(text: string): string {
  const flattened = text.replace(/\n/g, ' ');
  return flattened.includes('`') ? '`` ' + flattened + ' ``' : '`' + flattened + '`';
}
function capText(text: string, max: number): string { return text.length > max ? text.slice(0, max) + '\n\n*(truncated)*' : text; }

interface HandoffContent {
  title: string;
  provider: 'claude' | 'codex';
  source: 'chat' | 'head';
  resetsAt?: string;
  ask?: string;
  recentRequests: string[];
  filesTouched: string[];
  commands: string[];
  git?: GitSummary;
  whatsLeft: string[];
  whereItStopped?: string;
  cwd: string;
}

function renderMarkdown(content: HandoffContent): string {
  const parts: string[] = [];
  parts.push(`# Continue: ${content.title}`);
  const resets = content.resetsAt ? `, resets at ${content.resetsAt}` : '';
  parts.push(`> Handed off from ${providerLabel[content.provider]} (${content.source}) after it hit its usage limit${resets}.`);

  parts.push('## The ask');
  parts.push(content.ask ? blockquote(capText(content.ask, 4000)) : '*Not recorded.*');

  if (content.recentRequests.length) {
    parts.push('## Recent requests');
    parts.push(content.recentRequests.map(request => blockquote(capText(request, 1500))).join('\n\n'));
  }

  parts.push("## What's done");
  const done: string[] = [];
  done.push(content.filesTouched.length
    ? 'Files touched:\n' + content.filesTouched.slice(0, 60).map(file => `- ${inlineCode(file)}`).join('\n') + (content.filesTouched.length > 60 ? `\n- *(${content.filesTouched.length - 60} more, not shown)*` : '')
    : 'Files touched: *none recorded*.');
  done.push(content.commands.length
    ? 'Commands run:\n' + content.commands.map(command => `- ${inlineCode(capText(command, 300))}`).join('\n')
    : 'Commands run: *none recorded*.');
  if (content.git?.branch) done.push(`Branch: ${inlineCode(content.git.branch)}`);
  if (content.git?.status) done.push('Working tree:\n' + fence(capText(content.git.status, 2000)));
  if (content.git?.diffStat) done.push('Diff stat:\n' + fence(capText(content.git.diffStat, 2000)));
  if (content.git?.log) done.push('Recent commits:\n' + fence(capText(content.git.log, 1000)));
  if (!content.git) done.push('*Git status unavailable.*');
  parts.push(done.join('\n\n'));

  parts.push("## What's left");
  parts.push(content.whatsLeft.length ? content.whatsLeft.map(item => `- ${item}`).join('\n') : "Not recorded — check the ask against the diff.");

  parts.push('## Where it stopped');
  parts.push(content.whereItStopped ? blockquote(capText(content.whereItStopped, 4000)) : '*No final message recorded.*');

  parts.push('## Instructions');
  parts.push(`Continue this task in ${inlineCode(content.cwd)}. Check the current state with git first; don't redo finished work.`);

  let markdown = parts.join('\n\n') + '\n';
  if (markdown.length > totalCap) markdown = markdown.slice(0, totalCap - 40) + '\n\n*(handoff truncated to fit the size cap)*\n';
  return markdown;
}

// ---- Building ----

const tailBytes = 2 * 1024 * 1024;
const headBytes = 200 * 1024;

function firstLine(text: string | undefined): string {
  if (!text) return 'the interrupted task';
  const line = text.split('\n').find(part => part.trim())?.trim() ?? text.trim();
  return line.length > 120 ? line.slice(0, 117) + '…' : line;
}

/**
 * Transcripts can be huge; read only the head (carries the original ask) plus
 * the tail (carries the latest activity) instead of the whole file.
 */
async function readTranscript(deps: HandoffDeps, transcriptPath: string): Promise<string> {
  const [head, tail] = await Promise.all([deps.readHead(transcriptPath, headBytes), deps.readTail(transcriptPath, tailBytes)]);
  return head + '\n' + tail;
}

async function buildFromClaudeChat(event: LimitEvent, deps: HandoffDeps): Promise<Handoff> {
  const cwd = event.cwd || process.cwd();
  const extracted = event.transcriptPath ? parseClaudeTranscript(await readTranscript(deps, event.transcriptPath), cwd) : emptyExtraction();
  return finish('claude', 'chat', event, cwd, extracted, deps);
}

async function buildFromCodexChat(event: LimitEvent, deps: HandoffDeps): Promise<Handoff> {
  const cwd = event.cwd || process.cwd();
  const rolloutPath = cwd ? await findCodexRollout(deps, codexHomeFrom(deps.env), cwd) : undefined;
  const extracted = rolloutPath ? parseCodexRollout(await readTranscript(deps, rolloutPath), cwd) : emptyExtraction();
  return finish('codex', 'chat', event, cwd, extracted, deps);
}

async function buildFromHead(job: Job, event: LimitEvent, deps: HandoffDeps): Promise<Handoff> {
  const cwd = job.worktree || event.cwd || process.cwd();
  const whatsLeft: string[] = [];
  if (job.progress?.trim()) whatsLeft.push(job.progress.trim());
  if (job.question?.trim()) whatsLeft.push(`Open question: ${job.question.trim()}`);
  const git = await gitSummary(deps, cwd);
  const content: HandoffContent = {
    title: job.title,
    provider: job.provider,
    source: 'head',
    resetsAt: event.resetsAt,
    ask: job.brief,
    recentRequests: job.replies.slice(-3).map(reply => reply.message),
    filesTouched: job.result?.changedFiles ?? [],
    commands: [],
    git,
    whatsLeft,
    whereItStopped: job.result?.summary || job.reason,
    cwd,
  };
  return { markdown: renderMarkdown(content), title: content.title, cwd };
}

async function finish(provider: 'claude' | 'codex', source: 'chat' | 'head', event: LimitEvent, cwd: string, extracted: ExtractedTranscript, deps: HandoffDeps): Promise<Handoff> {
  const content: HandoffContent = {
    title: firstLine(extracted.ask),
    provider, source,
    resetsAt: event.resetsAt,
    ask: extracted.ask,
    recentRequests: extracted.recentUserMessages.filter(message => message !== extracted.ask),
    filesTouched: extracted.filesTouched,
    commands: extracted.commands,
    git: await gitSummary(deps, cwd),
    whatsLeft: [...extracted.todoInProgress.map(item => `In progress: ${item}`), ...extracted.todoPending.map(item => `Pending: ${item}`)],
    whereItStopped: extracted.lastAssistantText,
    cwd,
  };
  return { markdown: renderMarkdown(content), title: content.title, cwd };
}

export async function buildHandoff(input: HandoffInput, deps: HandoffDeps = defaultHandoffDeps()): Promise<Handoff> {
  const { event, job } = input;
  if (job) return buildFromHead(job, event, deps);
  if (event.provider === 'codex') return buildFromCodexChat(event, deps);
  return buildFromClaudeChat(event, deps);
}
