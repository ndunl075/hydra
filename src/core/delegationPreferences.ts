export type DelegationMode = 'solo' | 'auto';

/**
 * Auto delegation is paused until Hydra helpers replace the marker-line pipeline
 * (docs/Official_Extensions_Plan.md, Phase 0). A saved "auto" behaves as Solo.
 */
export const autoDelegationAvailable = false;
export const autoDelegationPausedReason = 'Auto delegation is paused while Hydra helpers are rebuilt. Hydra runs Solo.';

export interface DelegationPreferences {
  mode: DelegationMode;
  maxChildren: number;
  status: 'preparation';
}

export function parseDelegationMode(value: unknown): DelegationMode {
  try { return requireDelegationMode(value); } catch { return 'solo'; }
}

export function requireDelegationMode(value: unknown): DelegationMode {
  if (value === 'solo' || value === 'auto') return value;
  throw new Error('Invalid delegation mode.');
}

export function parseDelegationPreferences(value: unknown): DelegationPreferences {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const rawChildren = typeof source.maxChildren === 'number' ? source.maxChildren : 2;
  return { mode: parseDelegationMode(source.mode), maxChildren: Math.max(1, Math.min(8, Number.isInteger(rawChildren) ? rawChildren : 2)), status: 'preparation' };
}
