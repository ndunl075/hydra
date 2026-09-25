import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { isInside, maxEventAgeMs, maxEventFileBytes, parseLimitEventFile } from './limitDetection';
import type { LimitEvent } from './limitEvents';

/**
 * Picks up the event files the Claude StopFailure hook drops into one per-user
 * folder (Hydra's global storage, shared by every Hydra window).
 *
 * Which window takes an event: the one whose workspace contains the chat's cwd
 * claims it at once. If no window does, the first window to see it after a short
 * grace period takes it, so an event is never lost. Claiming is an atomic rename,
 * so exactly one window wins; the winner deletes the file and emits the event.
 * Stale, oversized or malformed files are deleted unread or unused.
 */
export interface LimitWatcherOptions {
  directory: string;
  /** Claude's projects folder (CLAUDE_CONFIG_DIR or ~/.claude, plus "projects"): transcripts elsewhere are dropped. */
  claudeProjectsDir: string;
  /** Whether this window's workspace contains a folder. */
  owns: (cwd: string) => boolean;
  now?: () => number;
  graceMs?: number;
  scanMs?: number;
  /** A repeat for the same chat within this long is ignored. */
  dedupeMs?: number;
}
const eventName = /^(\d{13})-[0-9a-f]{16}\.json$/;

export class LimitWatcher {
  private readonly listeners = new Set<(event: LimitEvent) => void>();
  private readonly recent = new Map<string, number>();
  private readonly now: () => number;
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private scanning?: Promise<void>;
  private again = false;
  private disposed = false;
  constructor(private readonly options: LimitWatcherOptions) { this.now = options.now || Date.now; }

  onLimit(listener: (event: LimitEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  async start(): Promise<void> {
    await mkdir(this.options.directory, { recursive: true });
    try {
      this.watcher = watch(this.options.directory, () => { void this.scan(); });
      this.watcher.on('error', () => undefined);
    } catch { /* the periodic scan still runs */ }
    this.timer = setInterval(() => { void this.scan(); }, this.options.scanMs ?? 15_000);
    this.timer.unref?.();
    await this.scan();
  }
  dispose(): void {
    this.disposed = true;
    this.watcher?.close(); clearInterval(this.timer); clearTimeout(this.retry);
    this.listeners.clear();
  }
  /** One pass over the folder. Calls during a pass run one more pass after it. */
  scan(): Promise<void> {
    if (this.scanning) { this.again = true; return this.scanning; }
    this.scanning = (async () => {
      try { do { this.again = false; await this.pass(); } while (this.again && !this.disposed); }
      finally { this.scanning = undefined; }
    })();
    return this.scanning;
  }

  private async pass(): Promise<void> {
    const directory = this.options.directory, now = this.now(), grace = this.options.graceMs ?? 4000;
    let names: string[];
    try { names = await readdir(directory); } catch { return; }
    let waiting = false;
    for (const name of names) {
      if (this.disposed) return;
      const file = path.join(directory, name), match = eventName.exec(name);
      if (!match) {
        // Leftovers: a hook that died mid-write, or a window that died mid-claim.
        if (/\.(tmp|claimed-[0-9a-f]+)$/.test(name)) { const info = await stat(file).catch(() => undefined); if (info && now - info.mtimeMs > 60_000) await rm(file, { force: true }); }
        continue;
      }
      const written = Number(match[1]);
      if (now - written > maxEventAgeMs) { await rm(file, { force: true }); continue; }
      const info = await stat(file).catch(() => undefined);
      if (!info) continue;
      if (info.size > maxEventFileBytes) { await rm(file, { force: true }); continue; }
      const event = parseLimitEventFile(await readFile(file, 'utf8').catch(() => ''), { now, claudeProjectsDir: this.options.claudeProjectsDir });
      if (!event) { await rm(file, { force: true }); continue; }
      const mine = !!event.cwd && this.owns(event.cwd);
      if (!mine && now - written < grace) { waiting = true; continue; }
      const claimed = `${file}.claimed-${randomBytes(6).toString('hex')}`;
      try { await rename(file, claimed); } catch { continue; } // another window won
      await rm(claimed, { force: true });
      this.emit(event);
    }
    if (waiting && !this.disposed) { clearTimeout(this.retry); this.retry = setTimeout(() => { void this.scan(); }, grace); this.retry.unref?.(); }
  }
  private owns(cwd: string): boolean { try { return this.options.owns(cwd); } catch { return false; } }
  private emit(event: LimitEvent): void {
    const now = this.now(), dedupe = this.options.dedupeMs ?? 120_000;
    for (const [key, at] of this.recent) if (now - at > dedupe) this.recent.delete(key);
    const key = `${event.provider}|${event.sessionId ?? event.cwd ?? ''}`;
    if (this.recent.has(key)) return;
    this.recent.set(key, now);
    for (const listener of [...this.listeners]) { try { listener(event); } catch { /* a listener's problem stays its own */ } }
  }
}

/** A window owns a chat when one of its folders contains (or is) the chat's cwd. */
export const workspaceOwns = (folders: readonly string[]) => (cwd: string) => folders.some(folder => isInside(cwd, folder) || samePath(cwd, folder));
function samePath(a: string, b: string): boolean {
  const pathApi = process.platform === 'win32' ? path.win32 : path;
  return pathApi.relative(pathApi.resolve(a), pathApi.resolve(b)) === '';
}
