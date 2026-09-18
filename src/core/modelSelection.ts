import type { ModelListParams } from './generated/codex-0.154.0/v2/ModelListParams';
import type { ModelListResponse } from './generated/codex-0.154.0/v2/ModelListResponse';

export interface ModelSelection { model: string; effort: string }
export interface ModelOption { model: string; displayName: string; efforts: string[]; defaultEffort: string; canonicalModel?: string }
export interface ModelCatalog { status: 'checking' | 'ready' | 'error'; models: ModelOption[]; checkedAt: string; error?: string }
export interface EffectiveModel { model: string; effort: string | null }
export interface TurnModelSettings { requested?: ModelSelection; effective?: EffectiveModel; rerouted?: { from: string; to: string; reason: string } }
const modelId = (value: unknown): value is string => typeof value === 'string' && value.length <= 200 && /^[a-z0-9][a-z0-9._:/-]*(?:\[1m\])?$/i.test(value);
const effortId = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^[a-z][a-z0-9_-]*$/i.test(value);
export function parseModelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a model and effort reported by the provider.');
  const selection = value as ModelSelection;
  if (!modelId(selection.model) || !effortId(selection.effort)) throw new Error('Invalid model or effort selection.');
  return { model: selection.model, effort: selection.effort };
}
export function parseEffectiveModel(value: unknown): EffectiveModel {
  if (!value || typeof value !== 'object') throw new Error('Codex did not report effective model settings.');
  const response = value as { model: unknown; reasoningEffort: unknown };
  if (!modelId(response.model) || response.reasoningEffort !== null && !effortId(response.reasoningEffort)) throw new Error('Codex did not report effective model and effort. No turn submitted.');
  return { model: response.model, effort: response.reasoningEffort };
}
export function verifyEffectiveModel(value: unknown, selection: ModelSelection): EffectiveModel {
  const effective = parseEffectiveModel(value);
  if (effective.model !== selection.model || effective.effort !== selection.effort) throw new Error(`Codex applied ${effective.model} / ${effective.effort ?? 'unspecified effort'} instead of ${selection.model} / ${selection.effort}. No turn submitted; check official provider settings.`);
  return effective;
}
export function requireAdvertisedSelection(models: ModelOption[], selection: ModelSelection): void {
  const model = models.find(model => model.model === selection.model);
  if (!model || !model.efforts.includes(selection.effort)) throw new Error(`Codex does not currently advertise ${selection.model} with ${selection.effort} effort. Refresh available models or use the official client. No model was substituted.`);
}
export async function readModelCatalog(request: (method: string, params: ModelListParams) => Promise<unknown>): Promise<ModelOption[]> {
  const models: ModelOption[] = [], seenModels = new Set<string>(), cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const response = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }) as ModelListResponse;
    if (!response || !Array.isArray(response.data) || response.data.length > 100 || response.nextCursor !== null && (typeof response.nextCursor !== 'string' || !response.nextCursor || response.nextCursor.length > 4096)) throw new Error('Invalid Codex model catalog.');
    for (const model of response.data) {
      if (!model || !modelId(model.model) || typeof model.hidden !== 'boolean' || typeof model.displayName !== 'string' || model.displayName.length > 200 || !effortId(model.defaultReasoningEffort) || !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 32) throw new Error('Invalid Codex model metadata.');
      const efforts = model.supportedReasoningEfforts.map(option => option?.reasoningEffort);
      if (!efforts.every(effortId) || new Set(efforts).size !== efforts.length || seenModels.has(model.model)) throw new Error('Invalid or duplicate Codex model/effort metadata.');
      seenModels.add(model.model);
      if (!model.hidden) models.push({ model: model.model, displayName: model.displayName, efforts, defaultEffort: model.defaultReasoningEffort });
    }
    if (response.nextCursor === null) return models;
    if (cursors.has(response.nextCursor)) throw new Error('Codex model catalog repeated a pagination cursor.');
    cursors.add(response.nextCursor); cursor = response.nextCursor;
  }
  throw new Error('Codex model catalog exceeded 20 pages.');
}
export function validateTurnModelSettings(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model settings history.');
  const settings = value as TurnModelSettings;
  if (settings.requested !== undefined) parseModelSelection(settings.requested);
  if (settings.effective !== undefined) parseEffectiveModel({ model: settings.effective?.model, reasoningEffort: settings.effective?.effort });
  if (settings.rerouted !== undefined && (!settings.rerouted || !modelId(settings.rerouted.from) || !modelId(settings.rerouted.to) || typeof settings.rerouted.reason !== 'string' || settings.rerouted.reason.length > 200)) throw new Error('Invalid model reroute history.');
}
