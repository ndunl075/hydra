import { spawn } from 'node:child_process';
import { ClaudeMessages, claudeRecord, readClaudeModels } from './claudeControls';
import { testedClaudeVersion } from './claudeProtocol';
import { processLaunch, terminateProcessTree } from './process';
import type { ModelOption } from './modelSelection';

/** Official CLI metadata only. No SDK, prompt, resume/history, or settings mutation. */
export function discoverClaudeModels(executable: string, cwd: string, signal?: AbortSignal): Promise<ModelOption[]> {
  if (signal?.aborted) return Promise.reject(new Error('Model discovery cancelled.'));
  return new Promise((resolve, reject) => {
    const launch = processLaunch(executable, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--safe-mode', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence', '--permission-prompts', 'none']);
    const child = spawn(launch.executable, launch.args, { cwd, env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    let nextId = 0, bytes = 0, failure: Error | undefined, result: ModelOption[] | undefined, cleanup: Promise<void> | undefined;
    let closeTimer: ReturnType<typeof setTimeout> | undefined, settled = false;
    const finish = async (code: number | null) => {
      if (settled) return; settled = true;
      clearTimeout(timeout); clearTimeout(closeTimer); signal?.removeEventListener('abort', abort);
      await cleanup;
      const error = failure || (!result || code !== 0 ? new Error('Claude model discovery closed without a complete catalog.') : undefined);
      for (const entry of pending.values()) entry.reject(error || new Error('Discovery closed.'));
      pending.clear(); if (error) reject(error); else resolve(result!);
    };
    const kill = () => { if (!cleanup && child.pid && child.exitCode === null && child.signalCode === null) cleanup = terminateProcessTree(child.pid).catch(error => { failure = new Error(`Claude discovery cleanup failed: ${String(error)}`); child.kill(); }); return cleanup; };
    const fail = (error: unknown) => {
      if (failure || settled) return;
      failure = error instanceof Error ? error : new Error(String(error));
      for (const entry of pending.values()) entry.reject(failure); pending.clear(); child.stdin.end(); void kill();
      closeTimer = setTimeout(() => { void finish(null); }, 3000);
    };
    const abort = () => fail(new Error('Claude model discovery cancelled.'));
    const timeout = setTimeout(() => fail(new Error('Claude model discovery timed out.')), 20000);
    const request = (subtype: 'initialize' | 'get_binary_version') => new Promise<unknown>((resolve, reject) => {
      if (failure || settled) { reject(failure || new Error('Discovery closed.')); return; }
      const request_id = `hydra-models-${++nextId}`; pending.set(request_id, { resolve, reject });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id, request: { subtype } }) + '\n');
    });
    const messages = new ClaudeMessages(message => {
      if (message.type !== 'control_response') throw new Error('Claude requested an unsupported interaction during metadata discovery. Use the official client.');
      const response = claudeRecord(message.response), entry = pending.get(response.request_id);
      if (!entry) throw new Error('Unmatched Claude metadata response.'); pending.delete(response.request_id);
      if (response.subtype === 'success') entry.resolve(response.response);
      else entry.reject(new Error('Claude rejected metadata discovery. Use the official client.'));
    });
    child.stdout.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 2 * 1024 * 1024) { fail(new Error('Claude metadata output exceeded 2 MiB.')); return; } if (!failure) try { messages.push(data); } catch (error) { fail(error); } });
    child.stderr.on('data', (data: Buffer) => { bytes += data.length; if (bytes > 2 * 1024 * 1024) fail(new Error('Claude metadata output exceeded 2 MiB.')); });
    child.stdin.on('error', fail); child.on('error', fail);
    child.on('close', code => { if (!failure) try { messages.end(); } catch (error) { failure = error as Error; } void finish(code); });
    signal?.addEventListener('abort', abort, { once: true });
    void (async () => {
      const init = claudeRecord(await request('initialize'));
      const version = claudeRecord(await request('get_binary_version'));
      if (version.version !== testedClaudeVersion) throw new Error('Claude discovery requires tested CLI 2.1.270.');
      result = readClaudeModels(init.models); child.stdin.end();
      closeTimer = setTimeout(() => { fail(new Error('Claude metadata connection did not close.')); }, 3000);
    })().catch(fail);
  });
}
