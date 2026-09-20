import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { replaceAtomic } from './atomicFile.js';
import type { VerifiedDesktopUpdate } from './desktopSignedUpdate.js';

export type DesktopUpdatePhase = 'available' | 'downloading' | 'verified' | 'awaitingRestart' | 'installing' | 'installed' | 'healthy' | 'refused' | 'failed';
export interface DesktopUpdateOperation {
  id: string;
  phase: DesktopUpdatePhase;
  sequence: number;
  payloadSha256: string;
  version: string;
  artifactSha256: string;
  artifactBytes: number;
  authorizedAt: string | null;
  reason: string | null;
}
interface JournalData { version: 1; operations: DesktopUpdateOperation[]; }
export type DesktopUpdateRecovery =
  | { status: 'none' }
  | { status: 'review'; operation: DesktopUpdateOperation }
  | { status: 'pending'; operation: DesktopUpdateOperation };

const maxBytes = 128 * 1024;
const maxOperations = 32;
const digest = /^[a-f0-9]{64}$/;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const operationId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const phases: DesktopUpdatePhase[] = ['available', 'downloading', 'verified', 'awaitingRestart', 'installing', 'installed', 'healthy', 'refused', 'failed'];
const terminal = new Set<DesktopUpdatePhase>(['healthy', 'refused', 'failed']);
const next: Partial<Record<DesktopUpdatePhase, DesktopUpdatePhase>> = {
  available: 'downloading', downloading: 'verified', verified: 'awaitingRestart',
  awaitingRestart: 'installing', installing: 'installed', installed: 'healthy'
};
const clone = <T>(value: T): T => structuredClone(value);
function fail(reason: string): never { throw new Error(`Desktop update journal refused: ${reason}`); }
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== fields.length ||
      !fields.every(field => Object.prototype.hasOwnProperty.call(value, field))) fail('journal schema is invalid.');
  return value as Record<string, unknown>;
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}
function parseOperation(raw: unknown): DesktopUpdateOperation {
  const value = exact(raw, ['id', 'phase', 'sequence', 'payloadSha256', 'version', 'artifactSha256', 'artifactBytes', 'authorizedAt', 'reason']);
  if (typeof value.id !== 'string' || !operationId.test(value.id) || !phases.includes(value.phase as DesktopUpdatePhase) ||
      !Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0 ||
      typeof value.payloadSha256 !== 'string' || !digest.test(value.payloadSha256) ||
      typeof value.version !== 'string' || !stableVersion.test(value.version) || value.version.length > 32 ||
      typeof value.artifactSha256 !== 'string' || !digest.test(value.artifactSha256) ||
      !Number.isSafeInteger(value.artifactBytes) || (value.artifactBytes as number) <= 0 || (value.artifactBytes as number) > 1024 * 1024 * 1024 ||
      (value.authorizedAt !== null && !iso(value.authorizedAt)) ||
      (value.reason !== null && (typeof value.reason !== 'string' || value.reason.length === 0 || value.reason.length > 256)) ||
      (['available', 'downloading', 'verified'].includes(value.phase as string) && value.authorizedAt !== null) ||
      (['awaitingRestart', 'installing', 'installed', 'healthy'].includes(value.phase as string) && value.authorizedAt === null) ||
      (['refused', 'failed'].includes(value.phase as string) !== (value.reason !== null))) fail('operation record is invalid.');
  return value as unknown as DesktopUpdateOperation;
}
function parseJournal(bytes: Buffer): JournalData {
  if (!bytes.length || bytes.length > maxBytes) fail('journal size is invalid.');
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return fail('journal JSON is invalid.'); }
  const value = exact(raw, ['version', 'operations']);
  if (value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > maxOperations) fail('journal header is invalid.');
  const operations = value.operations.map(parseOperation);
  if (new Set(operations.map(item => item.id)).size !== operations.length ||
      operations.filter(item => !terminal.has(item.phase)).length > 1 ||
      operations.slice(0, -1).some(item => !terminal.has(item.phase))) fail('journal operation order is invalid.');
  for (let i = 1; i < operations.length; i++) {
    if (operations[i]!.sequence <= operations[i - 1]!.sequence) fail('release sequence did not increase.');
  }
  return { version: 1, operations };
}

/** Main-process-owned persistence primitive. No method launches or authorizes an installer. */
export class DesktopUpdateJournal {
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;
  private readonly directory: string;
  constructor(directory: string, private readonly assertOwner: () => Promise<void> = async () => {}) {
    if (!isAbsolute(directory) || resolve(directory) !== directory) fail('journal directory is invalid.');
    this.directory = directory;
    this.file = join(directory, 'desktop-update-operations.json');
  }
  private async checkDirectory(): Promise<void> {
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() ||
        (await realpath(this.directory)).toLowerCase() !== this.directory.toLowerCase()) fail('journal directory is reparsed.');
  }
  private async read(): Promise<JournalData> {
    try { await this.checkDirectory(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, operations: [] };
      throw error;
    }
    let info;
    try {
      info = await lstat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, operations: [] };
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) fail('journal storage is invalid.');
    const handle = await open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > maxBytes) fail('journal changed during open.');
      return parseJournal(await handle.readFile());
    } finally { await handle.close(); }
  }
  private async mutate<T>(change: (data: JournalData) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true });
      await this.checkDirectory();
      const lock = `${this.file}.lock`, token = randomUUID();
      try { await writeFile(lock, token, { flag: 'wx' }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('another writer or retained lock requires review.');
        throw error;
      }
      try {
        const data = await this.read();
        const result = change(data);
        const bytes = Buffer.from(JSON.stringify(data));
        if (bytes.length > maxBytes) fail('journal capacity is exhausted.');
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, 'wx');
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        try { await this.assertOwner(); await replaceAtomic(temporary, this.file); }
        catch (error) { await unlink(temporary).catch(() => {}); throw error; }
        return clone(result);
      } finally {
        if (await readFile(lock, 'utf8').catch(() => '') === token) await unlink(lock).catch(() => {});
      }
    });
    this.queue = operation.then(() => {}, () => {});
    return operation;
  }
  async load(): Promise<DesktopUpdateOperation[]> { return clone((await this.read()).operations); }
  /** Recovery never returns permission to run a cached installer. */
  async recovery(): Promise<DesktopUpdateRecovery> {
    const current = (await this.read()).operations.at(-1);
    if (!current || terminal.has(current.phase)) return { status: 'none' };
    return { status: ['awaitingRestart', 'installing', 'installed'].includes(current.phase) ? 'review' : 'pending', operation: clone(current) };
  }
  async start(update: VerifiedDesktopUpdate): Promise<DesktopUpdateOperation> {
    if (!Number.isSafeInteger(update.sequence) || update.sequence <= 0 || !digest.test(update.payloadSha256) ||
        !stableVersion.test(update.availableVersion) || update.availableVersion.length > 32 ||
        !digest.test(update.artifact.sha256) || !Number.isSafeInteger(update.artifactBytes) ||
        update.artifactBytes <= 0 || update.artifactBytes > 1024 * 1024 * 1024) fail('candidate binding is invalid.');
    return this.mutate(data => {
      const latest = data.operations.at(-1);
      if (latest && (!terminal.has(latest.phase) || update.sequence <= latest.sequence)) fail('active operation or release sequence prevents start.');
      if (data.operations.length >= maxOperations) fail('journal capacity is exhausted; preserve evidence before rotation.');
      const operation: DesktopUpdateOperation = {
        id: randomUUID(), phase: 'available', sequence: update.sequence, payloadSha256: update.payloadSha256,
        version: update.availableVersion, artifactSha256: update.artifact.sha256, artifactBytes: update.artifactBytes,
        authorizedAt: null, reason: null
      };
      data.operations.push(operation);
      return operation;
    });
  }
  /** The caller must independently prove consent and native checks before advancing. */
  async advance(id: string, expected: DesktopUpdatePhase, phase: DesktopUpdatePhase,
    options: { authorizedAt?: string; reason?: string } = {}): Promise<DesktopUpdateOperation> {
    return this.mutate(data => {
      const current = data.operations.at(-1);
      if (!current || current.id !== id || current.phase !== expected || terminal.has(current.phase)) fail('operation state is stale.');
      if (phase !== next[expected] && phase !== 'refused' && phase !== 'failed') fail('state transition is invalid.');
      if (phase === 'awaitingRestart') {
        if (!iso(options.authorizedAt)) fail('restart authorization timestamp is invalid.');
        current.authorizedAt = options.authorizedAt;
      } else if (options.authorizedAt !== undefined) fail('unexpected restart authorization.');
      if (phase === 'refused' || phase === 'failed') {
        if (typeof options.reason !== 'string' || !options.reason || options.reason.length > 256) fail('refusal reason is invalid.');
        current.reason = options.reason;
      } else if (options.reason !== undefined) fail('unexpected refusal reason.');
      current.phase = phase;
      return current;
    });
  }
}
