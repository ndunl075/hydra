import type { PtyLike, PtyModule, PtySpawnOptions } from '../src/core/lanePty';

/** A pseudo-terminal stand-in for lane tests: records what Hydra does to it and lets a test play the process. */
export class FakePty implements PtyLike {
  written: string[] = []; sizes: [number, number][] = []; killed = false;
  private readonly dataListeners: ((data: string) => void)[] = [];
  private readonly exitListeners: ((event: { exitCode: number }) => void)[] = [];
  constructor(readonly pid = 4242, readonly file = '', readonly args: string[] = [], readonly options?: PtySpawnOptions) {}
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); return { dispose() {} }; }
  write(data: string) { this.written.push(data); }
  resize(cols: number, rows: number) { this.sizes.push([cols, rows]); }
  kill() { this.killed = true; setTimeout(() => this.exit(1), 0); }
  emit(data: string) { for (const listener of this.dataListeners) listener(data); }
  exit(code: number) { for (const listener of this.exitListeners) listener({ exitCode: code }); }
}
/** A node-pty stand-in that hands out FakePty processes and keeps them for the test. */
export function fakePtyModule(): PtyModule & { spawned: FakePty[] } {
  const spawned: FakePty[] = [];
  return { spawned, spawn: (file, args, options) => { const pty = new FakePty(5000 + spawned.length, file, args, options); spawned.push(pty); return pty; } };
}
