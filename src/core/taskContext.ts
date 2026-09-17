import { pendingSchedule } from './scheduler';
import type { SessionView, Task, TaskBrief, TaskHandoffSummary } from './model';

export const briefFields = ['goal', 'constraints', 'relevantPaths', 'acceptance', 'testCommands'] as const;
export const handoffFields = ['summary', 'decisions', 'validation', 'unresolved', 'evidenceRefs'] as const;
export const emptyBrief = (): TaskBrief => ({ goal: '', constraints: '', relevantPaths: '', acceptance: '', testCommands: '' });
export const emptyHandoffSummary = (): TaskHandoffSummary => ({ summary: '', decisions: '', validation: '', unresolved: '', evidenceRefs: '' });

function textFields<T extends string>(value: unknown, fields: readonly T[], limit: number): Record<T, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task context.');
  const record = value as Record<string, unknown>;
  const result = {} as Record<T, string>;
  for (const key of fields) {
    const text = record[key];
    if (typeof text !== 'string' || text.includes('\0') || text.length > limit) throw new Error(`Invalid ${key}.`);
    result[key] = text;
  }
  return result;
}
export function parseBrief(value: unknown, allowEmptyGoal = false): TaskBrief {
  const brief = textFields(value, briefFields, 16000);
  if (!allowEmptyGoal && !brief.goal.trim()) throw new Error('Enter a task goal.');
  if (buildTaskPrompt(brief).length > 32000) throw new Error('The complete task brief must fit within 32,000 characters.');
  return brief;
}
export function parseHandoffSummary(value: unknown): TaskHandoffSummary { return textFields(value, handoffFields, 8000); }

/** References stay references: never reads files, other tasks, or provider history. */
export function buildTaskPrompt(brief: TaskBrief): string {
  const labels: Record<keyof TaskBrief, string> = { goal: 'Goal', constraints: 'Constraints', relevantPaths: 'Relevant paths and symbols', acceptance: 'Acceptance criteria', testCommands: 'Suggested test commands (not run by Hydra)' };
  return briefFields.filter(key => brief[key].trim()).map(key => `## ${labels[key]}\n${brief[key].trim()}`).join('\n\n');
}

export function canEditBrief(task: Task, session?: SessionView): boolean {
  return !task.schedule?.request && !task.schedule?.actualStartingCommit && !pendingSchedule(task) && task.state === 'idle' && task.interface === 'interactive-cli' && !task.contextLockedAt && !task.sessionId && !session?.turns.length;
}

export function taskPromptPreview(task: Task, brief: TaskBrief): { prompt: string; draft: boolean } {
  const saved = task.brief || { ...emptyBrief(), goal: task.prompt };
  const draft = briefFields.some(key => brief[key] !== saved[key]);
  return { prompt: draft ? buildTaskPrompt(brief) : task.prompt, draft };
}

/** Lock before queueing even when the later provider attempt fails. */
export async function lockTaskContext(task: Task, persist: () => Promise<void>): Promise<void> {
  task.contextLockedAt ||= new Date().toISOString();
  await persist();
}

/** A local, user-curated artifact. It never represents automated validation. */
export function renderTaskHandoff(task: Task, historyPath: string, turns: { id: string; status: string; evidencePath: string }[]): string {
  const handoff = task.handoffSummary || emptyHandoffSummary();
  const labels: Record<keyof TaskHandoffSummary, string> = { summary: 'Result summary', decisions: 'Decisions', validation: 'Validation notes (user supplied)', unresolved: 'Unresolved work', evidenceRefs: 'Additional evidence references (user supplied)' };
  return [
    `# ${task.title} — local handoff`,
    `Task: ${task.id}\nRepository: ${task.repository}\nWorktree: ${task.worktree}\nBranch: ${task.branch}\nBase commit: ${task.baseCommit}`,
    task.reviewedCommit ? `Recorded reviewed commit: ${task.reviewedCommit.commit}\nRecorded tree: ${task.reviewedCommit.tree}\nReview recorded: ${task.reviewedCommit.reviewedAt}\nThis receipt may predate later edits; recheck before integration.` : 'No reviewed commit has been recorded.',
    ...handoffFields.map(key => `## ${labels[key]}\n${handoff[key].trim() || 'Not recorded.'}`),
    `## Local managed evidence\nHistory: ${historyPath}\n${turns.length ? turns.map(turn => `- ${turn.id} (${turn.status}): ${turn.evidencePath}`).join('\n') : 'No managed turns recorded.'}`,
    'This document was assembled locally without a model request. Notes are not proof of passing checks. No transcript is attached automatically to another task.'
  ].join('\n\n') + '\n';
}
