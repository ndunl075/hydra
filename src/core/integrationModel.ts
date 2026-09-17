import type { FileChange } from './model';
export interface IntegrationCommand { executable: string; args: string[] }
export interface IntegrationCheck extends IntegrationCommand { status: 'pending' | 'running' | 'passed' | 'failed'; exitCode?: number | null; error?: string; stdout?: string; stderr?: string }
export type IntegrationPhase = 'preparing' | 'conflicted' | 'checking' | 'failed' | 'resolution-review' | 'validated' | 'promoting' | 'promoted' | 'interrupted';
export interface IntegrationOperation {
  version: 1; id: string; taskId: string; repository: string; taskWorktree: string; taskBranch: string; targetBranch: string;
  baseCommit: string; taskCommit: string; taskTree: string; targetCommit: string; candidate: string;
  candidateCommit?: string; candidateTree?: string; reviewToken?: string; rollbackRef?: string;
  phase: IntegrationPhase; checks: IntegrationCheck[]; files: FileChange[]; createdAt: string; updatedAt: string; error?: string;
}
export function parseIntegrationCommands(value: unknown): IntegrationCommand[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new Error('Choose between one and ten explicit acceptance commands.');
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid acceptance command.');
    const { executable, args } = item as IntegrationCommand;
    const valid = (text: unknown): text is string => typeof text === 'string' && text.length <= 4000 && !text.includes('\0');
    if (!valid(executable) || !executable.trim() || !Array.isArray(args) || args.length > 128 || !args.every(valid) || args.join('').length > 16000) throw new Error('Acceptance commands require an executable and a bounded array of literal arguments.');
    if (/\.(cmd|bat)$/i.test(executable) && [executable, ...args].some(text => /[&|<>^%!\r\n]/.test(text))) throw new Error('Windows command shims require simple arguments. Use an executable for arguments containing shell metacharacters.');
    return { executable, args: [...args] };
  });
}
