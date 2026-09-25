import path from 'node:path';
import { gateBlocks, gateKind, gateState, type GateFinding, type JobCheckResult } from './jobs';
import { providerName } from './gates/types';

/**
 * View evidence (docs/Gates_Plan.md, "Seeing results"): a read-only Markdown
 * document listing a head's or a lane's gate results — the state, the summary,
 * the output tail, findings with file:line links into the worktree under
 * review, and the screenshots as images. Built as plain text (unit tested
 * without vscode) and written next to the evidence as a real .md file: the
 * Markdown preview won't follow `file:` links, but it does follow links, and
 * show images, relative to the document.
 */
export interface EvidenceSubject {
  /** What the gates ran against: a head's title, or a lane's name. */
  title: string;
  /** The worktree findings' file:line links open in. */
  worktree: string;
  /** Every log directory these results' evidence files may live under (a head's gate log root, or a lane's). Anything else is refused. */
  logDirectories: readonly string[];
  /** Where the .md file is written; every link is relative to it. */
  baseDirectory: string;
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
/** A link target relative to `base`, URL-encoded per segment; undefined when there is no relative path (another drive). */
export function relativeTarget(file: string, base: string): string | undefined {
  const relative = path.relative(path.resolve(base), path.resolve(file));
  if (!relative || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).map(encodeURIComponent).join('/');
}
const escapeText = (text: string): string => text.replace(/[[\]]/g, char => `\\${char}`);

/** A finding's file:line, as a link (with a #L line anchor) into the worktree under review when it has a file; otherwise plain text. */
export function findingLink(finding: GateFinding, worktree: string, base: string): string {
  if (!finding.file) return '(no location)';
  const label = `${finding.file}${finding.line ? `:${finding.line}` : ''}`;
  const target = relativeTarget(path.isAbsolute(finding.file) ? finding.file : path.join(worktree, finding.file), base);
  return target ? `[${escapeText(label)}](${target}${finding.line ? `#L${finding.line}` : ''})` : `\`${label}\``;
}

const severityLabel: Record<GateFinding['severity'], string> = { blocker: 'blocker', major: 'major', minor: 'minor' };

function findingLine(finding: GateFinding, worktree: string, base: string): string {
  return `- **${severityLabel[finding.severity]}** ${findingLink(finding, worktree, base)} — ${finding.note}`;
}

function resultSection(result: JobCheckResult, worktree: string, logDirectories: readonly string[], base: string): string {
  const kind = gateKind(result), state = gateState(result);
  const lines: string[] = [
    `## ${result.id} — ${stateLabel[state]} (${kindLabel[kind]}${!result.required ? ', not required' : ''}${gateBlocks(result) ? ', blocked it' : ''})`,
  ];
  if (kind === 'review' && result.reviewer && !result.summary?.startsWith('Reviewed by')) lines.push(`Reviewed by ${providerName(result.reviewer)}.`);
  if (result.summary) lines.push('', result.summary);
  const findings = (result.findings ?? []);
  if (findings.length) {
    lines.push('', 'Findings:');
    for (const finding of findings) lines.push(findingLine(finding, worktree, base));
  }
  if (result.outputTail?.trim()) lines.push('', '```', result.outputTail.trimEnd().slice(-8000), '```');
  // Evidence is only ever linked from under the run's own logs.
  const evidence = (result.evidence ?? []).filter(file => underLogDirectories(file, logDirectories));
  for (const file of evidence) {
    const target = relativeTarget(file, base), name = escapeText(path.basename(file));
    if (!target) { lines.push('', `Evidence: \`${path.basename(file)}\``); continue; }
    lines.push('', isImage(file) ? `![${name}](${target})` : `Evidence: [${name}](${target})`);
  }
  return lines.join('\n');
}

/** The whole document: a heading, then one section per gate, in the order the gates ran. */
export function buildEvidenceMarkdown(subject: EvidenceSubject): string {
  if (!subject.results.length) return `# ${subject.title} — gate evidence\n\nNo gates have run.\n`;
  const sections = subject.results.map(result => resultSection(result, subject.worktree, subject.logDirectories, subject.baseDirectory));
  return [`# ${subject.title} — gate evidence`, '', ...sections, ''].join('\n');
}
