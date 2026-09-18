import type { AccountRpc } from './accountSetup';
import type { GetAccountRateLimitsResponse } from './generated/codex-0.154.0/v2/GetAccountRateLimitsResponse';
import type { RateLimitSnapshot } from './generated/codex-0.154.0/v2/RateLimitSnapshot';
import type { InitializeParams } from './generated/codex-0.154.0/InitializeParams';

export interface QuotaWindow { usedPercent: number; remainingPercent: number; windowDurationMins?: number; resetsAt?: number }
export interface QuotaBucket { id?: string; name?: string; primary?: QuotaWindow; secondary?: QuotaWindow }
export interface QuotaSnapshot { fetchedAt: string; ordinaryUsageAllowed?: boolean; buckets: QuotaBucket[] }
export interface QuotaState { status: 'unchecked' | 'checking' | 'checked' | 'unavailable' | 'error' | 'cancelled'; text: string; snapshot?: QuotaSnapshot }
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unsupported provider quota response.');
  return value as Record<string, unknown>;
};
function label(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Unsupported quota bucket label.');
  return value;
}
function window(value: unknown): QuotaWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const data = object(value), percent = data.usedPercent;
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) throw new Error('Unsupported quota percentage.');
  const duration = data.windowDurationMins, reset = data.resetsAt;
  if (duration !== null && duration !== undefined && (!Number.isSafeInteger(duration) || Number(duration) <= 0) ||
      reset !== null && reset !== undefined && (!Number.isSafeInteger(reset) || Number(reset) < 0 || Number(reset) > 8640000000000)) throw new Error('Unsupported quota window.');
  return { usedPercent: percent, remainingPercent: Math.max(0, Math.min(100, 100 - percent)), ...(duration === null || duration === undefined ? {} : { windowDurationMins: Number(duration) }), ...(reset === null || reset === undefined ? {} : { resetsAt: Number(reset) }) };
}
function bucket(value: unknown, key?: string): QuotaBucket {
  const data = object(value) as unknown as RateLimitSnapshot;
  const id = label(data.limitId);
  if (key && id && key !== id) throw new Error('Quota bucket identity mismatch.');
  return { ...(id || key ? { id: id || key } : {}), ...(data.limitName === null || data.limitName === undefined ? {} : { name: label(data.limitName) }), primary: window(data.primary), secondary: window(data.secondary) };
}
/** Extract only window measurements. Identities, credits, purchase banners and reset tokens are not retained. */
export function publicCodexQuota(value: unknown, fetchedAt = new Date().toISOString()): QuotaSnapshot {
  const data = object(value) as unknown as GetAccountRateLimitsResponse;
  if (typeof fetchedAt !== 'string' || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid quota observation time.');
  if (data.ordinaryUsageAllowed !== undefined && data.ordinaryUsageAllowed !== null && typeof data.ordinaryUsageAllowed !== 'boolean') throw new Error('Unsupported usage permission.');
  let buckets: QuotaBucket[];
  if (data.rateLimitsByLimitId !== null && data.rateLimitsByLimitId !== undefined) {
    const entries = Object.entries(object(data.rateLimitsByLimitId));
    if (entries.length > 100) throw new Error('Too many quota buckets.');
    buckets = entries.map(([key, value]) => bucket(value, label(key)));
  } else buckets = [bucket(data.rateLimits)];
  return { fetchedAt, ...(typeof data.ordinaryUsageAllowed === 'boolean' ? { ordinaryUsageAllowed: data.ordinaryUsageAllowed } : {}), buckets };
}
/** Three read-only messages, no thread, prompt, login, reset or billing mutation. */
export async function readCodexQuota(connect: () => AccountRpc, signal?: AbortSignal): Promise<QuotaSnapshot> {
  if (signal?.aborted) throw new Error('Quota refresh cancelled.');
  const rpc = connect();
  let rejectStop!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // Close once in finally: reentrant transport.close calls can return before the
  // first owned-tree termination finishes, allowing cancellation to settle early.
  const abort = () => { rejectStop(new Error('Quota refresh cancelled.')); };
  const timer = setTimeout(() => { rejectStop(new Error('Quota refresh timed out.')); }, 18000);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Quota refresh cancelled.');
    const init = object(await Promise.race([rpc.request('initialize', { clientInfo: { name: 'hydra_quota_status', title: 'Hydra usage limits', version: '1' }, capabilities: { experimentalApi: false, requestAttestation: false } } satisfies InitializeParams), stopped]));
    if (signal?.aborted) throw new Error('Quota refresh cancelled.');
    if (typeof init.userAgent !== 'string' || !/(?:^|[^0-9])0\.154\.0(?:[^0-9A-Za-z_.-]|$)/.test(init.userAgent)) throw new Error('Quota refresh requires tested Codex 0.154.0.');
    const result = await Promise.race([rpc.request('account/rateLimits/read', undefined), stopped]);
    if (signal?.aborted) throw new Error('Quota refresh cancelled.');
    return publicCodexQuota(result);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await rpc.close(); }
}
