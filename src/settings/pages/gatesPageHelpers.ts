import { defaultScreenshotWidths, type Gate, type GateType, type ReviewerChoice } from '../../core/gates/config';

/**
 * Pure parsing/formatting for the Gates page's Add/Edit form and row
 * summaries. No `vscode` import, so these are unit tested directly
 * (tests/gatesPage.test.ts); the client-side script embedded in gates.ts
 * re-implements the same shapes in plain JS (the shell's script is a
 * string, not a module — see src/settings/pages/mcpServersHelpers.ts for
 * the same split).
 */

/** Non-blank, trimmed lines, in order. One argument (or start command word) per line. */
export function parseLines(text: string): string[] {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
}
export const formatLines = (values: readonly string[]): string => values.join('\n');

/** Widths as a comma- or newline-separated list of numbers, in the order given. Blanks and non-numbers are dropped. */
export function parseWidths(text: string): number[] {
  return text.split(/[\s,]+/).map(part => part.trim()).filter(Boolean).map(Number).filter(value => Number.isFinite(value));
}
export const formatWidths = (widths: readonly number[]): string => widths.join(', ');

/** What the Add/Edit form holds; every field is text, so the form never has to guess at types itself. */
export interface GateFormValues {
  id: string; type: GateType; required: boolean;
  command: string; timeoutSeconds: string;
  start: string; url: string; widths: string; readyTimeoutSeconds: string;
  reviewer: ReviewerChoice; focus: string;
}
export const blankGateForm: GateFormValues = {
  id: '', type: 'command', required: true,
  command: '', timeoutSeconds: '600',
  start: '', url: 'http://localhost:{port}/', widths: formatWidths(defaultScreenshotWidths), readyTimeoutSeconds: '90',
  reviewer: 'other', focus: '',
};

/** A saved gate, as the form's fields (for Edit). */
export function gateToForm(gate: Gate): GateFormValues {
  return {
    ...blankGateForm, id: gate.id, type: gate.type, required: gate.required,
    ...(gate.type === 'command' ? { command: formatLines(gate.command), timeoutSeconds: String(gate.timeoutSeconds) } : {}),
    ...(gate.type === 'screenshots' ? { start: formatLines(gate.start), url: gate.url, widths: formatWidths(gate.widths), readyTimeoutSeconds: String(gate.readyTimeoutSeconds) } : {}),
    ...(gate.type === 'review' ? { reviewer: gate.reviewer, focus: gate.focus } : {}),
  };
}

/**
 * The form's fields as a raw gate object — not validated here. Only the
 * fields config.ts's parser reads for this type are included, so an unknown
 * key can never sneak in from a stale field. The Gates page's Save then
 * round-trips the whole config through parseGatesConfig, so error messages
 * always match config.ts's, never a second copy of its rules.
 */
export function gateFromForm(form: GateFormValues): Record<string, unknown> {
  const base = { id: form.id.trim(), type: form.type, required: form.required };
  if (form.type === 'command') return { ...base, command: parseLines(form.command), timeoutSeconds: Number(form.timeoutSeconds) || 0 };
  if (form.type === 'screenshots') return { ...base, start: parseLines(form.start), url: form.url.trim(), widths: parseWidths(form.widths), readyTimeoutSeconds: Number(form.readyTimeoutSeconds) || 0 };
  return { ...base, reviewer: form.reviewer, focus: form.focus.trim() };
}

/** One row's summary line, for the gates list. */
export function summarizeGate(gate: Gate): string {
  if (gate.type === 'command') return gate.command.join(' ');
  if (gate.type === 'screenshots') return `${gate.start.join(' ')} → ${gate.url}`;
  return `reviewed by ${gate.reviewer === 'other' ? 'the other agent' : gate.reviewer === 'same' ? 'the same agent' : gate.reviewer === 'claude' ? 'Claude Code' : 'Codex'}`;
}
export const gateTypeLabel: Record<GateType, string> = { command: 'Command', screenshots: 'Screenshots', review: 'Review' };

/** .hydra/checks.json's checks, read as command gates — the same reading src/core/gates/config.ts's loadGates gives a head. */
export function checksAsGates(checks: readonly { id: string; command: string[]; timeoutSeconds: number; required: boolean }[]): Gate[] {
  return checks.map(check => ({ id: check.id, type: 'command' as const, required: check.required, command: check.command, timeoutSeconds: check.timeoutSeconds }));
}
