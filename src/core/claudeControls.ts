import { StringDecoder } from 'node:string_decoder';
import type { EffectiveModel, ModelOption, ModelSelection } from './modelSelection';

export function claudeRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude control response.');
  return value as Record<string, any>;
}
const modelId = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[a-z0-9][a-z0-9._:/-]*(?:\[1m\])?$/i.test(value);
const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
export function readClaudeModels(value: unknown): ModelOption[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid Claude model catalog.');
  const seen = new Set<string>();
  return value.map(item => {
    const model = claudeRecord(item);
    if (!modelId(model.value) || seen.has(model.value) || typeof model.displayName !== 'string' || model.displayName.length > 200 ||
      model.resolvedModel !== undefined && !modelId(model.resolvedModel) ||
      model.supportsEffort !== undefined && typeof model.supportsEffort !== 'boolean' ||
      model.supportedEffortLevels !== undefined && (!Array.isArray(model.supportedEffortLevels) || model.supportedEffortLevels.length > 5 || !model.supportedEffortLevels.every((level: unknown) => efforts.includes(level as string)) || new Set(model.supportedEffortLevels).size !== model.supportedEffortLevels.length)) throw new Error('Invalid Claude model/effort metadata.');
    seen.add(model.value);
    const supported = model.supportsEffort === true ? model.supportedEffortLevels || [] : [];
    // The catalog has no default-effort field. Never invent one.
    return { model: model.value, displayName: model.displayName, efforts: supported, defaultEffort: '', ...(model.resolvedModel ? { canonicalModel: model.resolvedModel } : {}) };
  });
}
export function requireClaudeSelection(models: ModelOption[], selection: ModelSelection): ModelOption {
  const model = models.find(item => item.model === selection.model);
  if (!model || !model.canonicalModel || !model.efforts.includes(selection.effort)) throw new Error('Claude does not advertise this model with the requested effort and canonical identity. Refresh models or use the official client. No turn submitted.');
  return model;
}
export function readClaudeEffective(value: unknown, models: ModelOption[], selection?: ModelSelection): EffectiveModel {
  const applied = claudeRecord(claudeRecord(value).applied);
  if (!modelId(applied.model) || applied.effort !== null && !efforts.includes(applied.effort)) throw new Error('Claude did not report effective model and effort. No turn submitted.');
  const effective = { model: applied.model, effort: applied.effort as string | null };
  if (selection) {
    const advertised = requireClaudeSelection(models, selection);
    if (effective.model !== advertised.canonicalModel || effective.effort !== selection.effort) throw new Error(`Claude applied ${effective.model} / ${effective.effort ?? 'no effort parameter'} instead of ${selection.model} / ${selection.effort}. No turn submitted; check provider policy and environment overrides.`);
  }
  return effective;
}
/** Bounded, UTF-8 safe stdio framing shared by metadata discovery and owned turns. */
export class ClaudeMessages {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(private readonly message: (value: Record<string, any>) => void) {}
  push(data: Buffer): void { this.pending += this.decoder.write(data); this.drain(false); }
  end(): void { this.pending += this.decoder.end(); this.drain(true); }
  private drain(final: boolean): void {
    let newline;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline); this.pending = this.pending.slice(newline + 1); this.line(line);
    }
    if (Buffer.byteLength(this.pending) > 1024 * 1024) throw new Error('Claude control line exceeded 1 MiB.');
    if (final && this.pending.trim()) { this.line(this.pending); this.pending = ''; }
  }
  private line(line: string): void {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Claude control line exceeded 1 MiB.');
    const value = claudeRecord(JSON.parse(line));
    if (typeof value.type !== 'string') throw new Error('Invalid Claude message envelope.');
    this.message(value);
  }
}
