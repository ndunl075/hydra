import { spawn } from 'node:child_process';
import { CodexMessages, record, testedCodexVersion } from './codexProtocol';
import { processLaunch, terminateProcessTree } from './process';
import { readModelCatalog, type ModelOption } from './modelSelection';
import { version } from '../../package.json';
import type { InitializeParams } from './generated/codex-0.154.0/InitializeParams';

/** Metadata-only connection. Never creates/resumes a thread, submits a turn, or handles auth. */
export function discoverCodexModels(executable: string, cwd: string, signal?: AbortSignal): Promise<ModelOption[]> {
  if (signal?.aborted) return Promise.reject(new Error('Model discovery cancelled.'));
  return new Promise((resolve, reject) => {
    const launch = processLaunch(executable, ['app-server', '--listen', 'stdio://']);
    const child = spawn(launch.executable, launch.args, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 0, bytes = 0, failure: Error | undefined, result: ModelOption[] | undefined, settled = false;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(cleanupTimer); signal?.removeEventListener('abort', abort);
      const error = failure || (!result || code !== 0 ? new Error('Codex model discovery ended without a complete catalog. Use the official client or retry discovery.') : undefined);
      for (const entry of pending.values()) entry.reject(error || new Error('Model discovery closed.'));
      pending.clear(); if (error) reject(error); else resolve(result!);
    };
    const fail = (error: unknown) => {
      if (failure || settled) return;
      failure = error instanceof Error ? error : new Error(String(error));
      for (const entry of pending.values()) entry.reject(failure);
      pending.clear(); child.stdin.end();
      if (child.pid && child.exitCode === null) void terminateProcessTree(child.pid).catch(cleanup => { failure = new Error(`${failure?.message} Process cleanup failed: ${String(cleanup)}`); child.kill(); });
      cleanupTimer = setTimeout(() => finish(null), 3000);
    };
    const abort = () => fail(new Error('Model discovery cancelled.'));
    const timeout = setTimeout(() => fail(new Error('Codex model discovery timed out.')), 20000);
    const send = (message: unknown) => { if (failure || settled) throw new Error('Model discovery closed.'); child.stdin.write(JSON.stringify(message) + '\n'); };
    const request = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
      const id = ++nextId; pending.set(id, { resolve, reject });
      try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
    });
    const messages = new CodexMessages(message => {
      if (typeof message.method === 'string') {
        if ('id' in message) throw new Error('Codex requested an unsupported interaction during model discovery. Use the official client.');
        return;
      }
      if (typeof message.id !== 'number' || !pending.has(message.id)) throw new Error('Unmatched model discovery response.');
      const entry = pending.get(message.id)!; pending.delete(message.id);
      if ('error' in message) entry.reject(new Error(`Codex model discovery failed: ${record(message.error).message}`));
      else if ('result' in message) entry.resolve(message.result);
      else entry.reject(new Error('Invalid model discovery response.'));
    });
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) { fail(new Error('Model discovery output exceeded 2 MiB.')); return; }
      if (!failure) try { messages.push(data); } catch (error) { fail(error); }
    });
    child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 2 * 1024 * 1024) fail(new Error('Model discovery output exceeded 2 MiB.')); });
    child.stdin.on('error', fail); child.on('error', fail);
    child.on('close', code => { if (!failure) try { messages.end(); } catch (error) { failure = error as Error; } finish(code); });
    signal?.addEventListener('abort', abort, { once: true });
    void (async () => {
      const init = record(await request('initialize', { clientInfo: { name: 'hydra', title: 'Hydra', version }, capabilities: { experimentalApi: false, requestAttestation: false } } satisfies InitializeParams));
      if (typeof init.userAgent !== 'string' || !init.userAgent.includes(testedCodexVersion)) throw new Error('Model discovery requires tested Codex 0.154.0.');
      send({ method: 'initialized', params: {} });
      result = await readModelCatalog(request);
      child.stdin.end();
    })().catch(fail);
  });
}
