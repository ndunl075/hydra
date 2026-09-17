import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Turn } from './model';

export const testedCodexVersion = '0.154.0';
export type RpcId = string | number;
export const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex protocol object.');
  return value as Record<string, any>;
};
export function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) throw new Error('Invalid Codex thread/turn ID.');
  return value;
}
export function validateCodexThread(value: unknown, cwd: string, expectedId?: string): string {
  const response = record(value), thread = record(response.thread);
  const id = providerId(thread.id);
  if (expectedId && id !== expectedId) throw new Error('Codex resumed a different thread.');
  if (typeof response.cwd !== 'string' || path.relative(cwd, response.cwd) !== '' || typeof thread.cwd !== 'string' || path.relative(cwd, thread.cwd) !== '') throw new Error('Codex returned a different working directory.');
  if (record(response.sandbox).type !== 'workspaceWrite') throw new Error('Codex did not grant the requested worktree sandbox. Check sandbox setup and managed configuration in the official client, or use the provider terminal.');
  if (thread.cliVersion !== testedCodexVersion || response.approvalPolicy !== 'on-request') throw new Error('Codex returned an unverified version or task policy. Use the provider terminal.');
  return id;
}

/** JSONL transport framing only. Unknown notifications remain in the raw evidence. */
export class CodexMessages {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  constructor(private readonly message: (value: Record<string, any>) => void) {}
  push(data: Buffer): void { this.buffer += this.decoder.write(data); this.drain(false); }
  end(): void { this.buffer += this.decoder.end(); this.drain(true); }
  private drain(final: boolean): void {
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); this.line(line);
    }
    if (Buffer.byteLength(this.buffer) > 1024 * 1024) throw new Error('Codex message exceeded 1 MiB.');
    if (final && this.buffer.trim()) { this.line(this.buffer); this.buffer = ''; }
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Codex message exceeded 1 MiB.');
    this.message(record(JSON.parse(line)));
  }
}

/** Only the selected root thread and its current turn can update the visible response. */
export class CodexTurn {
  id?: string;
  completed = false;
  private readonly messages = new Map<string, string>();
  constructor(readonly threadId: string, private readonly turn: Turn) {}
  started(value: unknown): void {
    const event = record(value), id = providerId(event.id);
    if (this.id && this.id !== id) throw new Error('Codex started a different turn.');
    if (!['inProgress', 'completed', 'failed', 'interrupted'].includes(event.status)) throw new Error('Invalid Codex turn status.');
    this.id = id;
  }
  notification(method: string, value: unknown): boolean {
    const params = record(value);
    if (params.threadId !== this.threadId) return false;
    if (method === 'turn/started') { this.started(params.turn); return true; }
    if (method === 'turn/completed') {
      const final = record(params.turn);
      if (!this.id || final.id !== this.id || this.completed) throw new Error('Unmatched or duplicate Codex completion.');
      if (!['completed', 'failed', 'interrupted'].includes(final.status)) throw new Error('Invalid Codex completion status.');
      this.completed = true;
      this.turn.status = final.status === 'failed' ? 'error' : final.status;
      if (final.status !== 'completed') this.turn.error = final.error?.message || `Codex turn ${final.status}.`;
      return true;
    }
    if (!this.id || params.turnId !== this.id || this.completed) return false;
    if (method === 'item/agentMessage/delta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string') throw new Error('Invalid Codex message delta.');
      this.messages.set(params.itemId, (this.messages.get(params.itemId) || '') + params.delta);
      this.render(); return true;
    }
    if (method === 'item/completed' && record(params.item).type === 'agentMessage') {
      const item = params.item;
      if (typeof item.id !== 'string' || typeof item.text !== 'string') throw new Error('Invalid Codex final message.');
      this.messages.set(item.id, item.text); this.render(); return true;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = record(record(params.tokenUsage).last);
      const valid = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
      if (![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens, usage.cacheWriteInputTokens].every(valid)) throw new Error('Invalid Codex token usage.');
      this.turn.usage = { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cachedInputTokens, cacheCreated: usage.cacheWriteInputTokens };
      this.turn.usageSource = 'codex-last-request';
      // `last` is the most recent model response, not all requests inside this turn.
      // Keep the root-thread cumulative snapshot independently for aggregation.
      if (params.tokenUsage.total !== undefined) {
        const total = record(params.tokenUsage.total);
        if (![total.inputTokens, total.outputTokens, total.cachedInputTokens, total.cacheWriteInputTokens].every(valid)) throw new Error('Invalid Codex cumulative token usage.');
        this.turn.threadUsage = { sessionId: this.threadId, input: total.inputTokens, output: total.outputTokens, cacheRead: total.cachedInputTokens, cacheCreated: total.cacheWriteInputTokens };
      }
      return true;
    }
    return false;
  }
  private render(): void { this.turn.text = [...this.messages.values()].join('\n\n'); }
}
