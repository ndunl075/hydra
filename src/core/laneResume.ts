import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Provider } from './model';

/**
 * Whether Resume would find a real conversation to continue (docs/Heads.md, "Restarting Hydra"):
 * today, `laneLaunch`/`LaneService.resume` just run `claude --continue` or `codex resume --last`.
 * If the CLI never started a conversation in the lane's worktree (it stopped at its own update or
 * folder-trust prompt, or the user quit before sending anything), that opens an empty session and
 * the lane's goal is lost. `laneHasConversation` checks first, so the caller can fall back to
 * Start fresh instead. Pure and injectable (home/env/fs), so it's unit-tested against a temp fake
 * home — never against the real `~/.claude` or `~/.codex`.
 */

export interface ConversationDirEntry { name: string; isDirectory: boolean }
/** A small filesystem seam: swapped for a fake in tests. */
export interface ConversationFs {
  readdir(dir: string): Promise<ConversationDirEntry[]>;
  /** Only the first line of the file (Codex's rollout files can be large; only the first line matters). */
  readFirstLine(file: string): Promise<string | undefined>;
}
const defaultFs: ConversationFs = {
  readdir: async dir => (await readdir(dir, { withFileTypes: true })).map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() })),
  readFirstLine: async file => {
    const text = await readFile(file, 'utf8');
    const newline = text.indexOf('\n');
    const line = (newline === -1 ? text : text.slice(0, newline)).trim();
    return line || undefined;
  },
};

export interface LaneConversationOptions {
  /** `%USERPROFILE%` (Windows) or `~` — overridden by a temp fake home in tests. */
  home: string;
  /** For `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  fs?: ConversationFs;
}

const isWindows = (platform: NodeJS.Platform) => platform === 'win32';
/** Case-insensitive and separator-insensitive on Windows, as the task's matching rules ask. */
const normalizePath = (value: string, platform: NodeJS.Platform): string => {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return isWindows(platform) ? slashed.toLowerCase() : slashed;
};
/** Claude Code's own encoding: every character that isn't [A-Za-z0-9] becomes '-'. */
const encodeClaudeCwd = (worktree: string): string => worktree.replace(/[^A-Za-z0-9]/g, '-');
const isNotFound = (error: unknown): boolean => !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT';

/** Claude Code: `<config>/projects/<encoded cwd>/*.jsonl`. */
async function claudeHasConversation(worktree: string, options: LaneConversationOptions): Promise<boolean> {
  const fs = options.fs ?? defaultFs;
  const configured = options.env.CLAUDE_CONFIG_DIR?.trim();
  const projectsDir = path.join(configured || path.join(options.home, '.claude'), 'projects');
  const wanted = encodeClaudeCwd(worktree);
  let entries: ConversationDirEntry[];
  try { entries = await fs.readdir(projectsDir); }
  catch (error) { return isNotFound(error) ? false : true; }
  const folder = entries.find(entry => entry.isDirectory && (isWindows(options.platform) ? entry.name.toLowerCase() === wanted.toLowerCase() : entry.name === wanted));
  if (!folder) return false;
  try {
    const files = await fs.readdir(path.join(projectsDir, folder.name));
    return files.some(entry => !entry.isDirectory && entry.name.toLowerCase().endsWith('.jsonl'));
  } catch (error) { return isNotFound(error) ? false : true; }
}

/** Day folders (`YYYY/MM/DD`) on or after `since`, oldest first, as full paths. */
async function codexDayDirs(sessionsDir: string, since: Date, fs: ConversationFs): Promise<string[]> {
  const sinceKey = [since.getFullYear(), since.getMonth() + 1, since.getDate()].map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('/');
  const years = (await fs.readdir(sessionsDir)).filter(entry => entry.isDirectory && /^\d{4}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  const dirs: string[] = [];
  for (const year of years) {
    const months = await fs.readdir(path.join(sessionsDir, year.name)).catch(() => []);
    for (const month of months.filter(entry => entry.isDirectory && /^\d{2}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
      const days = await fs.readdir(path.join(sessionsDir, year.name, month.name)).catch(() => []);
      for (const day of days.filter(entry => entry.isDirectory && /^\d{2}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
        const key = `${year.name}/${month.name}/${day.name}`;
        if (key >= sinceKey) dirs.push(path.join(sessionsDir, year.name, month.name, day.name));
      }
    }
  }
  return dirs;
}
function codexCwd(firstLine: string): string | undefined {
  try {
    const record = JSON.parse(firstLine) as { payload?: { cwd?: unknown } };
    return typeof record.payload?.cwd === 'string' ? record.payload.cwd : undefined;
  } catch { return undefined; }
}
/** At most this many rollout files are opened; past it, a conversation is assumed to exist (the task's "bound the work"). */
export const maxCodexFilesRead = 300;

/** Codex: `sessions/YYYY/MM/DD/rollout-*.jsonl`, whose first line's `session_meta` payload names the cwd it started in. */
async function codexHasConversation(worktree: string, since: Date, options: LaneConversationOptions): Promise<boolean> {
  const fs = options.fs ?? defaultFs;
  const configured = options.env.CODEX_HOME?.trim();
  const sessionsDir = path.join(configured || path.join(options.home, '.codex'), 'sessions');
  let dayDirs: string[];
  try { dayDirs = await codexDayDirs(sessionsDir, since, fs); }
  catch (error) { return isNotFound(error) ? false : true; }
  const target = normalizePath(worktree, options.platform);
  let read = 0;
  for (const dir of dayDirs) {
    const files = await fs.readdir(dir).catch(() => [] as ConversationDirEntry[]);
    for (const file of files.filter(entry => !entry.isDirectory && /^rollout-.*\.jsonl$/i.test(entry.name))) {
      if (read >= maxCodexFilesRead) return true; // the bound was hit: assume one exists (resume as today)
      read++;
      const line = await fs.readFirstLine(path.join(dir, file.name)).catch(() => undefined);
      const cwd = line ? codexCwd(line) : undefined;
      if (cwd !== undefined && normalizePath(cwd, options.platform) === target) return true;
    }
  }
  return false;
}

/**
 * Whether the CLI has an earlier conversation for this lane's worktree, started on or after
 * `since` (the lane's `createdAt`) for Codex. On a detection failure that isn't simply "there's
 * nothing there yet" (an unreadable folder, a permissions error), this assumes a conversation
 * exists, so Resume behaves as it does today.
 */
export async function laneHasConversation(provider: Provider, worktree: string, since: Date, options: LaneConversationOptions): Promise<boolean> {
  try { return provider === 'claude' ? await claudeHasConversation(worktree, options) : await codexHasConversation(worktree, since, options); }
  catch { return true; }
}
