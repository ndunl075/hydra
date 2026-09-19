import type { Provider } from './model';

export interface ProviderReadinessInput { provider: Provider; adapter?: { version: string; controls: string[]; advertised?: { model: string; effort: string } }; selected?: { model: string; effort: string }; taskTemplate?: { goal: string; evidencePaths: string[] }; authorization?: { operator: string; budget: string; approved: boolean }; }
export interface ProviderReadinessReport { provider: Provider; adapter: 'ready' | 'unavailable'; controls: 'ready' | 'unavailable'; template: 'ready' | 'missing'; authorization: 'missing' | 'required'; ready: false; }
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0');
const controls: Record<Provider, readonly string[]> = { claude: ['model', 'effort'], codex: ['model', 'effort'] };

/** Passive local report. It consumes supplied metadata only and never probes adapters, accounts, or providers. */
export function providerReadiness(value: unknown): ProviderReadinessReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider readiness input.');
  const input = value as ProviderReadinessInput;
  if (Object.keys(input).some(key => !['provider', 'adapter', 'selected', 'taskTemplate', 'authorization'].includes(key))) throw new Error('Invalid provider readiness input.');
  if (input.provider !== 'claude' && input.provider !== 'codex') throw new Error('Invalid provider readiness input.');
  const exact = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => key in value);
  if (input.adapter && (!exact(input.adapter, input.adapter.advertised === undefined ? ['version', 'controls'] : ['version', 'controls', 'advertised']) || !/^\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(input.adapter.version) || !Array.isArray(input.adapter.controls) || input.adapter.controls.length > 16 || !input.adapter.controls.every(control => text(control, 80)) || (input.adapter.advertised !== undefined && (!exact(input.adapter.advertised, ['model', 'effort']) || !text(input.adapter.advertised.model, 120) || !text(input.adapter.advertised.effort, 40))))) throw new Error('Invalid provider readiness adapter.');
  if (input.selected && (!exact(input.selected, ['model', 'effort']) || !text(input.selected.model, 120) || !text(input.selected.effort, 40))) throw new Error('Invalid provider readiness selected controls.');
  if (input.taskTemplate && (!exact(input.taskTemplate, ['goal', 'evidencePaths']) || !Array.isArray(input.taskTemplate.evidencePaths) || input.taskTemplate.evidencePaths.length > 32)) throw new Error('Invalid provider readiness template.');
  if (input.authorization && (!exact(input.authorization, ['operator', 'budget', 'approved']) || typeof input.authorization.approved !== 'boolean' || !text(input.authorization.operator, 160) || !text(input.authorization.budget, 200))) throw new Error('Invalid provider readiness authorization.');
  const adapter = input.adapter && text(input.adapter.version, 100) ? 'ready' : 'unavailable';
  const supported = input.adapter?.controls;
  const controlState = Array.isArray(supported) && new Set(supported).size === supported.length && supported.every(control => typeof control === 'string') && controls[input.provider].every(control => supported.includes(control)) && !!input.adapter?.advertised && !!input.selected && input.selected.model === input.adapter.advertised.model && input.selected.effort === input.adapter.advertised.effort && text(input.selected.model, 120) && text(input.selected.effort, 40) ? 'ready' : 'unavailable';
  const portable = (path: string) => text(path, 4096) && !path.startsWith('/') && !path.includes(':') && !path.includes('\\') && !path.split('/').some(part => !part || part === '.' || part === '..');
  const template = input.taskTemplate && text(input.taskTemplate.goal, 32000) && Array.isArray(input.taskTemplate.evidencePaths) && input.taskTemplate.evidencePaths.length > 0 && input.taskTemplate.evidencePaths.every(portable) ? 'ready' : 'missing';
  const authorization = input.authorization?.approved === true && text(input.authorization.operator, 160) && text(input.authorization.budget, 200) ? 'required' : 'missing';
  return { provider: input.provider, adapter, controls: controlState, template, authorization, ready: false };
}
