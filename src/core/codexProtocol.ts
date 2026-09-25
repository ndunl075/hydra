import { StringDecoder } from 'node:string_decoder';

/** Codex app-server JSON-RPC helpers shared by account setup and quota reads. */
export const record = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Codex protocol object.');
  return value as Record<string, any>;
};

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
