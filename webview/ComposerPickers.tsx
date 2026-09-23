import React, { useEffect, useRef } from 'react';
import type { ClientMessage, Provider, ProviderInfo } from '../src/core/model';
import type { ModelCatalog, ModelOption, ModelSelection } from '../src/core/modelSelection';
import { permissionModeChoices, type ClaudePermissionMode, type CodexPermissionMode, type TaskPermissionMode } from '../src/core/permissionMode';
import type { ContextUsage } from '../src/core/contextUsage';
import { ComposerIcon } from './ComposerIcons';

// Shared by the composer that starts a task and the one inside a conversation, so
// both show the same controls in the same places.
type Send = (message: ClientMessage) => void;
export const providerLabel: Record<Provider, string> = { claude: 'Claude', codex: 'Codex' };

/** Details menus close on an outside click, like the provider's own menus. */
function useOutsideClose(ref: React.RefObject<HTMLDetailsElement | null>, onOpen?: () => void) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onOutsideClick = (event: MouseEvent) => { if (element.open && !element.contains(event.target as Node)) element.open = false; };
    const onToggle = () => { if (element.open) onOpen?.(); };
    document.addEventListener('click', onOutsideClick, true);
    element.addEventListener('toggle', onToggle);
    return () => { document.removeEventListener('click', onOutsideClick, true); element.removeEventListener('toggle', onToggle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onOpen]);
}

const capitalize = (value: string) => value ? value[0]!.toUpperCase() + value.slice(1) : value;

/**
 * Why a model cannot be picked, or undefined when it can. The backend refuses the
 * same cases, so disabling them here turns a failed save into a visible reason.
 */
function unavailableReason(provider: Provider, model: ModelOption): string | undefined {
  if (!model.efforts.length) return 'Reports no effort levels, so Hydra cannot verify the run.';
  if (provider === 'claude' && !model.canonicalModel) return 'Has no canonical model id for Hydra to verify.';
  return undefined;
}

/**
 * The effort a model starts on when picked. Codex advertises a default. Claude's
 * catalog has none, and the catalog parser deliberately never invents one, so the
 * picker starts on medium (or the middle level) and shows it, instead of silently
 * taking the first level, which is the lowest.
 */
function startingEffort(model: ModelOption): string {
  if (model.efforts.includes(model.defaultEffort)) return model.defaultEffort;
  if (model.efforts.includes('medium')) return 'medium';
  return model.efforts[Math.floor((model.efforts.length - 1) / 2)] || '';
}

export function ModelPicker({ selection, provider, catalogs, providers, busy, send, onSelect, locked }: {
  selection: ModelSelection | null; provider: Provider; catalogs: Partial<Record<Provider, ModelCatalog>>; providers: ProviderInfo[]; busy: boolean; send: Send;
  onSelect: (selection: ModelSelection | null, provider: Provider) => void;
  /** Set once a task has launched: its session belongs to one provider and model. */
  locked?: string;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const load = () => {
    for (const item of ['claude', 'codex'] as const) {
      const available = providers.find(entry => entry.provider === item)?.available;
      if (available && !catalogs[item]) send({ type: 'checkModelsForProvider', provider: item });
    }
  };
  useOutsideClose(ref, load);
  const selected = selection ? catalogs[provider]?.models.find(model => model.model === selection.model) : undefined;
  const label = selection ? `${selected?.displayName || selection.model} ${capitalize(selection.effort)}` : providerLabel[provider];
  if (locked) return <span className="composer-chip" title={locked}>{label}</span>;
  return <details className="model-picker" ref={ref}>
    <summary title={selection ? 'Model and effort' : `${providerLabel[provider]} with its default model`}>{label}</summary>
    <div className="model-picker-body">
      {(['claude', 'codex'] as const).map(item => {
        const available = providers.find(entry => entry.provider === item)?.available;
        const catalog = catalogs[item];
        return <div key={item} className="model-picker-group">
          <div className="model-picker-group-header">
            <span>{providerLabel[item]}</span>
            {available && catalog?.status === 'error' && <button type="button" className="text-button" disabled={busy} onClick={() => send({ type: 'checkModelsForProvider', provider: item })}>Retry</button>}
          </div>
          {!available && <p className="form-note">Not connected.</p>}
          {available && (!catalog || catalog.status === 'checking') && <p className="form-note">Loading…</p>}
          {available && catalog?.status === 'error' && <p role="status" className="session-error">{catalog.error}</p>}
          {available && catalog?.status === 'ready' && !catalog.models.length && <p className="form-note">No models advertised.</p>}
          <button type="button" className="model-picker-option" aria-pressed={provider === item && !selection} disabled={busy || !available}
            onClick={() => onSelect(null, item)}>{providerLabel[item]} default<span className="muted">provider settings</span></button>
          {available && catalog?.status === 'ready' && catalog.models.map(model => {
            const reason = unavailableReason(item, model);
            return <button key={model.model} type="button" className="model-picker-option" aria-pressed={provider === item && selection?.model === model.model} disabled={busy || !!reason} title={reason}
              onClick={() => onSelect({ model: model.model, effort: startingEffort(model) }, item)}>
              {model.displayName}<span className="muted">{reason ? 'unavailable' : model.efforts.join(' · ')}</span>
            </button>;
          })}
        </div>;
      })}
      {/* Effort for the chosen model, as a row of its own levels. */}
      {selection && selected && <div className="model-picker-effort" role="group" aria-label="Effort">
        <span>Effort</span>
        <div className="effort-options">
          {selected.efforts.map(effort => <button key={effort} type="button" aria-pressed={selection.effort === effort} disabled={busy}
            onClick={() => onSelect({ model: selection.model, effort }, provider)}>{capitalize(effort)}</button>)}
        </div>
      </div>}
    </div>
  </details>;
}

export type DelegationMode = 'solo' | 'auto';
export function DelegationModePicker({ mode, send, locked }: { mode: DelegationMode; send: Send; locked?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useOutsideClose(ref);
  const options: { id: DelegationMode; label: string; description: string }[] = [
    { id: 'solo', label: 'Solo', description: 'One agent keeps the whole task.' },
    { id: 'auto', label: 'Auto', description: 'The agent may split independent work into child agents, each in its own worktree.' },
  ];
  const label = options.find(option => option.id === mode)?.label;
  if (locked) return <span className="composer-mode" title={locked}><ComposerIcon name="agents" size={12} />{label}</span>;
  return <details className="mode-picker" ref={ref}>
    <summary title="Subagent delegation"><ComposerIcon name="agents" size={12} />{label}</summary>
    <div className="mode-picker-body">
      {options.map(option => (
        <button key={option.id} type="button" className="mode-picker-option" aria-pressed={mode === option.id}
          onClick={() => { send({ type: 'setDelegationMode', mode: option.id }); if (ref.current) ref.current.open = false; }}>
          <span className="mode-picker-option-text"><span>{option.label}</span><span className="muted">{option.description}</span></span>
          {mode === option.id && <span className="mode-picker-check">✓</span>}
        </button>
      ))}
    </div>
  </details>;
}

// The options carry each provider's own names, so what is shown here is what the
// provider is actually told. Claude takes one --permission-mode; Codex splits the
// same ground across an approval policy and a sandbox, so both are named.
export type PermissionModeName = TaskPermissionMode['mode'];
const permissionModeOptions: Record<Provider, { mode: PermissionModeName; description: string }[]> = permissionModeChoices;
export const defaultPermissionModeName = (provider: Provider): PermissionModeName => provider === 'claude' ? 'default' : 'on-request/workspace-write';
/** Pair the name back with its provider so the saved value is a valid mode for that task. */
export const asTaskPermissionMode = (provider: Provider, mode: PermissionModeName): TaskPermissionMode =>
  provider === 'claude' ? { provider: 'claude', mode: mode as ClaudePermissionMode } : { provider: 'codex', mode: mode as CodexPermissionMode };
export const isPermissionModeFor = (provider: Provider, mode: string): mode is PermissionModeName => permissionModeOptions[provider].some(option => option.mode === mode);

export function PermissionModePicker({ provider, mode, busy, onSelect, locked }: { provider: Provider; mode: PermissionModeName | null; busy: boolean; onSelect: (mode: PermissionModeName) => void; locked?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useOutsideClose(ref);
  const options = permissionModeOptions[provider];
  const current = mode && options.some(option => option.mode === mode) ? mode : defaultPermissionModeName(provider);
  const label = current.replace('/', ' · ');
  if (locked) return <span className="composer-mode" title={locked}><ComposerIcon name="shield" size={12} />{label}</span>;
  return <details className="mode-picker mode-picker-plain" ref={ref}>
    <summary title={`${providerLabel[provider]} permission mode`}><ComposerIcon name="shield" size={12} />{label}</summary>
    <div className="mode-picker-body">
      {options.map(option => (
        <button key={option.mode} type="button" className="mode-picker-option" aria-pressed={current === option.mode} disabled={busy}
          onClick={() => { onSelect(option.mode); if (ref.current) ref.current.open = false; }}>
          <span className="mode-picker-option-text"><span>{option.mode.replace('/', ' · ')}</span><span className="muted">{option.description}</span></span>
          {current === option.mode && <span className="mode-picker-check">✓</span>}
        </button>
      ))}
    </div>
  </details>;
}

/**
 * How full the context window was after the latest turn. Read-only: it reports and
 * never compacts. It only appears once a Claude turn has reported usage; Codex
 * 0.154.0 exposes no equivalent, so a Codex task shows none rather than a guess.
 */
export function ContextRing({ usage }: { usage?: ContextUsage }) {
  if (!usage) return null;
  const radius = 5.5, circumference = 2 * Math.PI * radius;
  const level = usage.percentage >= 90 ? 'high' : usage.percentage >= 70 ? 'rising' : 'normal';
  const description = `${usage.percentage}% of context used · ${usage.totalTokens.toLocaleString()} of ${usage.maxTokens.toLocaleString()} tokens`;
  return <span className={`context-ring context-ring-${level}`} role="img" aria-label={description} title={description}>
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle className="context-ring-track" cx="8" cy="8" r={radius} />
      <circle className="context-ring-fill" cx="8" cy="8" r={radius} strokeDasharray={`${(circumference * usage.percentage) / 100} ${circumference}`} transform="rotate(-90 8 8)" />
    </svg>
  </span>;
}
