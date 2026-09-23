import type { Turn } from './model';

/**
 * How full the provider's context window was after a turn: a read-only snapshot
 * for the composer's usage ring. Hydra never acts on it; compacting is a separate,
 * deliberate provider turn.
 */
export interface ContextUsage { totalTokens: number; maxTokens: number; percentage: number }

const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Reads Claude's get_context_usage response. The percentage is derived from the
 * token counts rather than taken from the reply, so the ring does not depend on
 * whether the provider reports a fraction or a percent. Anything malformed yields
 * undefined: the ring is optional and must never fail the turn it describes.
 */
export function parseContextUsage(value: unknown): ContextUsage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { totalTokens, maxTokens } = value as Record<string, unknown>;
  if (!tokens(totalTokens) || !tokens(maxTokens) || maxTokens === 0) return undefined;
  return { totalTokens, maxTokens, percentage: Math.min(100, Math.round((totalTokens / maxTokens) * 1000) / 10) };
}

export function validContextUsage(value: unknown): boolean {
  const parsed = parseContextUsage(value);
  return !!parsed && (value as ContextUsage).percentage === parsed.percentage;
}

/** The ring shows the most recent turn that reported usage. */
export function latestContextUsage(turns: readonly Pick<Turn, 'contextUsage'>[]): ContextUsage | undefined {
  for (let index = turns.length - 1; index >= 0; index--) if (turns[index]!.contextUsage) return turns[index]!.contextUsage;
  return undefined;
}
