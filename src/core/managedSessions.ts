import { ManagedClaude } from './managedClaude';
import { ManagedCodex } from './managedCodex';
import { SessionStore } from './sessionStore';
import type { Task, SessionView, Provider } from './model';

export class ManagedSessions {
  private readonly claude: ManagedClaude;
  private readonly codex: ManagedCodex;
  private readonly providers = new Map<string, Provider>();
  constructor(readonly store: SessionStore, persist: () => Promise<void>, changed: () => void, report: (error: unknown) => void) {
    this.claude = new ManagedClaude(store, persist, changed, report);
    this.codex = new ManagedCodex(store, persist, changed, report);
  }
  get count(): number { return this.claude.count + this.codex.count; }
  has(id: string): boolean { return this.claude.has(id) || this.codex.has(id); }
  private owner(id: string): ManagedClaude | ManagedCodex { return this.providers.get(id) === 'codex' ? this.codex : this.claude; }
  async load(task: Task): Promise<void> {
    // Version 0.5 only stored Claude sessions. Preserve that ownership after a provider handoff.
    if (task.sessionId && !task.sessionProvider) task.sessionProvider = 'claude';
    this.providers.set(task.id, task.sessionProvider || task.provider);
    await this.owner(task.id).load(task);
  }
  view(id: string): SessionView | undefined { return this.owner(id).view(id); }
  displayView(id: string): SessionView | undefined {
    const view = this.view(id);
    return view ? { ...view, totalTurns: view.turns.length, turns: view.turns.slice(-10).map(turn => ({ ...turn, text: turn.text.slice(0, 50000), textTruncated: turn.text.length > 50000 })) } : undefined;
  }
  async start(task: Task, executable: string, prompt: string, beforeTurn: () => void | Promise<void> = () => {}, environment: Record<string, string> = {}): Promise<void> {
    if (task.state === 'discarded') throw new Error('Restore this discarded task before launching a writer.');
    if (this.has(task.id)) throw new Error('Stop the existing task writer first.');
    if (task.sessionId && (task.sessionProvider || 'claude') !== task.provider) throw new Error('The recorded session belongs to another provider. Create a separate task for this provider.');
    this.providers.set(task.id, task.provider);
    await beforeTurn();
    await this.owner(task.id).start(task, executable, prompt, beforeTurn, environment);
  }
  async reconcile(id: string): Promise<void> {
    if (this.has(id)) throw new Error('Stop the managed writer first.');
    const view = this.view(id); if (!view?.writerUncertain) return;
    const previous = view.writerUncertain; view.writerUncertain = undefined;
    try { await this.store.save(id, view); await this.owner(id).load({ id, sessionProvider: this.providers.get(id) } as Task); }
    catch (error) { view.writerUncertain = previous; throw error; }
  }
  approve(id: string, approvalId: string, decision: 'accept' | 'decline'): void { this.owner(id).approve(id, approvalId, decision); }
  async stop(id: string): Promise<void> { await this.owner(id).stop(id); }
  async shutdown(): Promise<void> { await Promise.all([this.claude.shutdown(), this.codex.shutdown()]); }
}
