import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Turn } from './model';

export const testedClaudeVersion = '2.1.270';
export const sessionIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function claudeArguments(sessionId?: string): string[] {
  if (sessionId && !sessionIdPattern.test(sessionId)) throw new Error('Invalid Claude session ID.');
  return ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'default', '--permission-prompts', 'none', ...(sessionId ? ['--resume', sessionId] : [])];
}
export class ClaudeProtocol {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  sessionId?: string;
  resultReceived = false;
  initialized = false;
  constructor(readonly turn: Turn, private readonly cwd: string, private readonly expectedSession?: string) {}
  push(bytes: Buffer): void { this.pending += this.decoder.write(bytes); this.drain(false); }
  end(): void { this.pending += this.decoder.end(); this.drain(true); }
  private drain(final: boolean): void {
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.pending) > 1024 * 1024) throw new Error('Claude protocol line exceeded 1 MiB.');
    if (final && this.pending.trim()) { this.line(this.pending); this.pending = ''; }
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Claude protocol line exceeded 1 MiB.');
    const event = JSON.parse(line) as Record<string, any>;
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('Invalid Claude event envelope.');
    if (event.parent_tool_use_id) return; // Subagent text is retained in raw diagnostics, not mixed into the main response.
    if (event.type === 'system' && event.subtype === 'init') {
      if (this.initialized || event.claude_code_version !== testedClaudeVersion || typeof event.cwd !== 'string' || path.relative(this.cwd, event.cwd) !== '' || !['default', 'manual'].includes(event.permissionMode)) throw new Error('Claude initialization did not match the tested version, worktree, or permission mode.');
      this.captureSession(event.session_id); this.initialized = true;
    } else if (event.type === 'stream_event' && event.event?.delta?.type === 'text_delta') {
      if (!this.initialized || typeof event.event.delta.text !== 'string') throw new Error('Invalid Claude text delta.');
      this.turn.text += event.event.delta.text;
    } else if (event.type === 'system' && event.subtype === 'permission_denied') {
      this.turn.permissionDenials = (this.turn.permissionDenials || 0) + 1;
    } else if (event.type === 'result') {
      if (!this.initialized || this.resultReceived || typeof event.is_error !== 'boolean' || typeof event.subtype !== 'string') throw new Error('Invalid or duplicate Claude final result.');
      this.captureSession(event.session_id); this.resultReceived = true;
      if (typeof event.result === 'string') this.turn.text = event.result;
      if (event.permission_denials !== undefined) {
        if (!Array.isArray(event.permission_denials)) throw new Error('Invalid Claude permission-denial metadata.');
        this.turn.permissionDenials = Math.max(this.turn.permissionDenials || 0, event.permission_denials.length);
      }
      if (event.is_error || event.subtype !== 'success') this.turn.error = `Claude returned ${event.subtype}. ${Array.isArray(event.errors) ? event.errors.join(' ') : typeof event.result === 'string' ? event.result : 'See raw diagnostics.'}`;
      if (event.usage) {
        const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
        if (number(event.usage.input_tokens) && number(event.usage.output_tokens)) this.turn.usage = {
          input: event.usage.input_tokens, output: event.usage.output_tokens,
          cacheRead: number(event.usage.cache_read_input_tokens) ? event.usage.cache_read_input_tokens : undefined,
          cacheCreated: number(event.usage.cache_creation_input_tokens) ? event.usage.cache_creation_input_tokens : undefined,
          estimatedUsd: number(event.total_cost_usd) ? event.total_cost_usd : undefined
        };
      }
    }
    // Future event types remain available in the owned append-only raw log.
  }
  private captureSession(value: unknown): void {
    if (typeof value !== 'string' || !sessionIdPattern.test(value) || (this.expectedSession && value !== this.expectedSession) || (this.sessionId && this.sessionId !== value)) throw new Error('Claude returned a mismatched or invalid session ID.');
    this.sessionId = value;
  }
}
