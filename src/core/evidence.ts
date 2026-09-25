import path from 'node:path';
import { gateBlocks, gateKind, gateState, type GateFinding, type JobCheckResult } from './jobs';
import { providerName } from './gates/types';

/**
 * View evidence (docs/Gates_Plan.md, "Seeing results"): a read-only Markdown
 * document listing a head's or a lane's gate results — the state, the summary,
 * the output tail, findings with file:line links into the worktree under
 * review, and the screenshots as images. Built once, as plain text, so it can
 * be served by a virtual document provider (`hydra-evidence:`) and unit tested
 * without vscode.
 */
export interface EvidenceSubject {
  /** What the gates ran against: a head's title, or a lane's name. */
  title: string;
  /** The worktree findings' file:line links open in. */
  worktree: string;
  /** Every log directory these results' evidence files may live under (a head's gate log root, or a lane's). Anything else is refused. */
  logDirectories: readonly string[];
  results: readonly JobCheckResult[];
}

const stateLabel: Record<'passed' | 'failed' | 'notRun', string> = { passed: '✓ Passed', failed: '✗ Failed', notRun: '– Not run' };
const kindLabel: Record<'command' | 'screenshots' | 'review', string> = { command: 'command', screenshots: 'screenshots', review: 'review' };

/** True only for a path under one of `logDirectories` (resolved, so `..` can't escape it). Evidence never points outside a run's own log directory. */
export function underLogDirectories(file: string, logDirectories: readonly string[]): boolean {
  const resolved = path.resolve(file);
  return logDirectories.some(directory => {
    const base = path.resolve(directory);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

const isImage = (file: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(file);
const fileUri = (file: string): string => `file:///${path.resolve(file).replace(/\\/g, '/').replace(/^\/+/, '')}`;
const escapeText = (text: string): string => text.replace(/[[\]]/g, char => `\\${char}`);

/** A finding's file:line, as a link into the worktree under review when it has a file; otherwise plain text. */
export function findingLink(finding: GateFinding, worktree: string): string {
  if (!finding.file) return '(no location)';
  const label = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
  const target = path.isAbsolute(finding.file) ? finding.file : path.join(worktree, finding.file);
  const uri = `${fileUri(target)}${finding.line ? `#${finding.line}` : ''}`;
  return `[${escapeText(label)}](${uri})`;
}

const severityLabel: Record<GateFinding['severity'], string> = { blocker: 'blocker', major: 'major', minor: 'minor' };

function findingLine(finding: GateFinding, worktree: string): string {
  return `- **${severityLabel[finding.severity]}** ${findingLink(finding, worktree)} — ${finding.note}`;
}

function resultSection(result: JobCheckResult, worktree: string, logDirectories: readonly string[]): string {
  const kind = gateKind(result), state = gateState(result);
  const lines: string[] = [
    `## ${result.id} — ${stateLabel[state]} (${kindLabel[kind]}${!result.required ? ', not required' : ''}${gateBlocks(result) ? ', blocked it' : ''})`,
  ];
  if (kind === 'review' && result.reviewer) lines.push(`Reviewed by ${providerName(result.reviewer)}.`);
  if (result.summary) lines.push('', result.summary);
  const findings = (result.findings ?? []);
  if (findings.length) {
    lines.push('', 'Findings:');
    for (const finding of findings) lines.push(findingLine(finding, worktree));
  }
  if (result.outputTail?.trim()) lines.push('', '```', result.outputTail.trimEnd().slice(-8000), '```');
  const evidence = result.evidence ?? [];
  const images = evidence.filter(file => underLogDirectories(file, logDirectories) && isImage(file));
  const other = evidence.filter(file => !images.includes(file));
  for (const file of other) {
    if (!underLogDirectories(file, logDirectories)) continue; // never linked: outside the run's own logs
    lines.push('', `Evidence: [${escapeText(path.basename(file))}](${fileUri(file)})`);
  }
  for (const file of images) lines.push('', `![${escapeText(path.basename(file))}](${fileUri(file)})`);
  return lines.join('\n');
}

/** The whole document: a heading, then one section per gate, in the order the gates ran. */
export function buildEvidenceMarkdown(subject: EvidenceSubject): string {
  if (!subject.results.length) return `# ${subject.title} — gate evidence\n\nNo gates have run.\n`;
  const sections = subject.results.map(result => resultSection(result, subject.worktree, subject.logDirectories));
  return [`# ${subject.title} — gate evidence`, '', ...sections, ''].join('\n');
}

/** The \`hydra-evidence:\` scheme's authority/path encode which subject to build for; see src/extension.ts's content provider. */
export const evidenceScheme = 'hydra-evidence';
