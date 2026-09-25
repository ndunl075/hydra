import type { LimitEvent } from './limitEvents';
import { otherProvider } from './limitEvents';
import type { Provider } from './model';

/**
 * Phase 3 (docs/Hydra_Agent_Plan.md, "Offer where to continue"): decide whether to
 * show one notification for a limit event, what it says, and which buttons it
 * offers. Pure — no vscode API — so it is unit-testable; src/extensionLimitOffer.ts
 * wires this to the real notification, clipboard and dispatch.
 */

export const providerLabel: Readonly<Record<Provider, string>> = { claude: 'Claude Code', codex: 'Codex' };
/** Short form used in the "Continued in X after Y's usage limit" history line. */
const shortLabel: Readonly<Record<Provider, string>> = { claude: 'Claude', codex: 'Codex' };

export const defaultDedupeMs = 10 * 60_000;
/** How long a limit is assumed to still be active when the provider gave no reset time. */
export const defaultLimitWindowMs = 60 * 60_000;

/** A key identifying "the same chat/head/lane" for dedupe: provider + source + session/job/lane. */
export function limitEventKey(event: LimitEvent): string {
  const identity = event.source === 'head' ? (event.jobId ?? '') : event.source === 'lane' ? (event.laneId ?? '') : (event.sessionId ?? '');
  return `${event.provider}|${event.source}|${identity}`;
}

/** Same provider+source+session/job as `previous`, seen again within `dedupeMs`: ignore it. */
export function shouldOfferHandoff(event: LimitEvent, previous: LimitEvent | undefined, now: Date, dedupeMs = defaultDedupeMs): boolean {
  if (!previous) return true;
  if (limitEventKey(event) !== limitEventKey(previous)) return true;
  return now.getTime() - Date.parse(previous.at) >= dedupeMs;
}

/** Whether a provider's limit (from its most recent event) is still expected to be in force. */
export function otherStillLimited(otherEvent: LimitEvent | undefined, now: Date, windowMs = defaultLimitWindowMs): boolean {
  if (!otherEvent) return false;
  if (otherEvent.resetsAt) { const resets = Date.parse(otherEvent.resetsAt); return Number.isFinite(resets) && resets > now.getTime(); }
  const at = Date.parse(otherEvent.at);
  return Number.isFinite(at) && now.getTime() - at < windowMs;
}

/** "3:45 PM", relative to `now`'s locale/timezone. Undefined when there is nothing to show. */
export function formatResetTime(resetsAt: string | undefined, now: Date): string | undefined {
  if (!resetsAt) return undefined;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return undefined;
  void now;
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function buildOfferMessage(event: LimitEvent, now: Date, otherAlsoLimited: boolean): string {
  const mine = providerLabel[event.provider];
  const other = providerLabel[otherProvider(event.provider)];
  const resets = formatResetTime(event.resetsAt, now);
  const resetsText = resets ? `, resets at ${resets}` : '';
  if (otherAlsoLimited) return `${mine} hit its usage limit${resetsText}. ${other} hit its usage limit too. Continue anyway once one resets.`;
  return `${mine} hit its usage limit${resetsText}. Continue in ${other}?`;
}

export type LimitOfferButtonId = 'continueOther' | 'setupOther' | 'viewHandoff' | 'wait';
export interface LimitOfferButton { id: LimitOfferButtonId; label: string }

/**
 * Which buttons to show: only "View handoff" when the other provider is also
 * limited; otherwise "Continue in <Other>" (or "Set up <Other>" when it isn't
 * ready), "View handoff", and "Wait".
 */
export function offerButtons(event: LimitEvent, otherAlsoLimited: boolean, otherReady: boolean): LimitOfferButton[] {
  const other = providerLabel[otherProvider(event.provider)];
  const viewHandoff: LimitOfferButton = { id: 'viewHandoff', label: 'View handoff' };
  if (otherAlsoLimited) return [viewHandoff];
  const first: LimitOfferButton = otherReady ? { id: 'continueOther', label: `Continue in ${other}` } : { id: 'setupOther', label: `Set up ${other}` };
  return [first, viewHandoff, { id: 'wait', label: 'Wait' }];
}

export interface LimitOffer { message: string; buttons: LimitOfferButton[] }
export function buildOffer(event: LimitEvent, now: Date, otherAlsoLimited: boolean, otherReady: boolean): LimitOffer {
  return { message: buildOfferMessage(event, now, otherAlsoLimited), buttons: offerButtons(event, otherAlsoLimited, otherReady) };
}

/** The "Continue in X after Y's usage limit" line recorded on a continued head. */
export function continuedHistoryReason(fromProvider: Provider, toProvider: Provider): string {
  return `Continued in ${shortLabel[toProvider]} after ${shortLabel[fromProvider]}'s usage limit.`;
}

// ---- Lanes (docs/Gates_Plan.md, section 2): the tile banner, not a notification ----

export type LaneOfferButtonId = 'continueOther' | 'viewHandoff' | 'wait';
/** "Claude Code hit its usage limit (resets 3:40 PM)." — the buttons say what to do about it. */
export function laneOfferMessage(event: LimitEvent, now: Date): string {
  const mine = providerLabel[event.provider];
  const resets = formatResetTime(event.resetsAt, now);
  return `${mine} hit its usage limit${resets ? ` (resets ${resets})` : ''}.`;
}
/** Only Wait when the other provider is also limited (otherStillLimited); otherwise all three. */
export function laneOfferButtons(otherAlsoLimited: boolean): LaneOfferButtonId[] {
  return otherAlsoLimited ? ['wait'] : ['continueOther', 'viewHandoff', 'wait'];
}
/** `hydra.lanes.onLimit: "switch"`: how long the tile counts down before switching, with Cancel. */
export const laneSwitchCountdownSeconds = 10;

/**
 * Tracks the latest event per dedupe key (to ignore repeats) and per provider (to
 * tell whether the *other* provider is also currently limited). One instance per
 * window; not itself vscode-aware.
 */
export class LimitOfferTracker {
  private readonly lastByKey = new Map<string, LimitEvent>();
  private readonly latestByProvider = new Map<Provider, LimitEvent>();
  constructor(private readonly dedupeMs = defaultDedupeMs, private readonly windowMs = defaultLimitWindowMs) {}

  /** Records the event. Returns undefined when it's a repeat that should be ignored. */
  consider(event: LimitEvent, now: Date): { otherAlsoLimited: boolean; otherEvent?: LimitEvent } | undefined {
    const key = limitEventKey(event);
    const previous = this.lastByKey.get(key);
    if (!shouldOfferHandoff(event, previous, now, this.dedupeMs)) return undefined;
    this.lastByKey.set(key, event);
    const otherEvent = this.latestByProvider.get(otherProvider(event.provider));
    this.latestByProvider.set(event.provider, event);
    const otherAlsoLimited = otherStillLimited(otherEvent, now, this.windowMs);
    return { otherAlsoLimited, ...(otherAlsoLimited ? { otherEvent } : {}) };
  }
}
