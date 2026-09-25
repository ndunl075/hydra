import * as vscode from 'vscode';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from './core/jobs';
import { buildHandoff, handoffFileName, type HandoffDeps } from './core/limitHandoff';
import type { LimitEvent } from './core/limitEvents';
import { otherProvider } from './core/limitEvents';
import { buildOffer, LimitOfferTracker, providerLabel } from './core/limitOffer';
import type { Provider } from './core/model';
import { openOfficialExtension } from './extensionBridge';

/**
 * Phase 3 (docs/Hydra_Agent_Plan.md, "Offer where to continue"): on each limit
 * event, save the handoff to global storage and show one notification with
 * "Continue in <Other>" (or "Set up <Other>"), "View handoff" and "Wait". The
 * decision logic (message, buttons, dedupe) is in src/core/limitOffer.ts; this
 * module only wires it to vscode (notifications, clipboard, the other extension,
 * HelperService.continueWith).
 */
export interface LimitOfferDeps {
  limitEvents: vscode.Event<LimitEvent>;
  /** Extension global storage root; handoffs are saved under `<storageDir>/handoffs`. */
  storageDir: string;
  offerEnabled: () => boolean;
  /** Looks up a head's job for a `source: 'head'` event, for the handoff builder and continueWith. */
  job: (jobId: string) => Job | undefined;
  /** Whether the other provider is installed and connected to Hydra. */
  otherReady: (provider: Provider) => Promise<boolean>;
  /** HelperService.continueWith for a head; not called for a chat. */
  continueWith: (jobId: string, provider: Provider, handoffMarkdown: string) => Promise<void>;
  handoffDeps?: HandoffDeps;
  now?: () => Date;
  log?: (line: string) => void;
  /**
   * Shared with the lane banner (extensionLanes.ts LanesController), so
   * "otherStillLimited" reflects every chat, head and lane in this window, not
   * just chats. Defaults to a fresh, unshared tracker.
   */
  tracker?: LimitOfferTracker;
}

const maxSavedHandoffs = 20;

export function registerLimitOffer(deps: LimitOfferDeps): vscode.Disposable {
  const tracker = deps.tracker ?? new LimitOfferTracker();
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const subscription = deps.limitEvents(event => {
    void handle(event).catch(error => log(`[limits] offer failed: ${error instanceof Error ? error.message : String(error)}`));
  });

  async function handle(event: LimitEvent): Promise<void> {
    // Lane events are shown on the lane's tile (LanesController.onLimitEvent), never as a notification.
    if (event.source === 'lane') return;
    if (!deps.offerEnabled()) return;
    const considered = tracker.consider(event, now());
    if (!considered) return; // a repeat of the same chat/head within the dedupe window
    const job = event.source === 'head' && event.jobId ? deps.job(event.jobId) : undefined;
    const handoff = await buildHandoff({ event, job }, deps.handoffDeps);
    const file = await saveHandoff(deps.storageDir, event, handoff.markdown);
    const other = otherProvider(event.provider);
    const otherReady = considered.otherAlsoLimited ? false : await deps.otherReady(other).catch(() => false);
    const offer = buildOffer(event, now(), considered.otherAlsoLimited, otherReady);
    const choice = await vscode.window.showInformationMessage(offer.message, ...offer.buttons.map(button => button.label));
    const button = offer.buttons.find(candidate => candidate.label === choice);
    if (!button) return; // dismissed, or "Wait"
    try {
      switch (button.id) {
        case 'viewHandoff': await openHandoffPreview(file); break;
        case 'setupOther': await vscode.commands.executeCommand('hydra.openSettings', 'connectors'); break;
        case 'continueOther': await continueInOther(event, other, handoff.markdown, deps); break;
        case 'wait': break;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }
  return { dispose: () => subscription.dispose() };
}

async function continueInOther(event: LimitEvent, other: Provider, markdown: string, deps: LimitOfferDeps): Promise<void> {
  if (event.source === 'head' && event.jobId) {
    await deps.continueWith(event.jobId, other, markdown);
    return;
  }
  // A chat: Hydra never types into the other extension. It copies the handoff and
  // opens the other chat (following Docked/Tabs), for the user to paste themselves.
  await vscode.env.clipboard.writeText(markdown);
  await openOfficialExtension(other);
  void vscode.window.showInformationMessage(`Handoff copied. Paste it into the new ${providerLabel[other]} chat to continue.`);
}

export async function openHandoffPreview(file: string): Promise<void> {
  const uri = vscode.Uri.file(file);
  try { await vscode.commands.executeCommand('markdown.showPreview', uri); }
  catch { const doc = await vscode.workspace.openTextDocument(uri); await vscode.window.showTextDocument(doc, { preview: true }); }
}

export async function saveHandoff(storageDir: string, event: LimitEvent, markdown: string): Promise<string> {
  const dir = path.join(storageDir, 'handoffs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, handoffFileName(event));
  await writeFile(file, markdown, 'utf8');
  await pruneHandoffs(dir);
  return file;
}

/** Keeps only the newest `maxSavedHandoffs` handoff files. */
async function pruneHandoffs(dir: string): Promise<void> {
  let names: string[];
  try { names = await readdir(dir); } catch { return; }
  const candidates = names.filter(name => name.startsWith('HANDOFF-') && name.endsWith('.md'));
  if (candidates.length <= maxSavedHandoffs) return;
  const withTimes = (await Promise.all(candidates.map(async name => {
    const full = path.join(dir, name);
    try { return { full, mtimeMs: (await stat(full)).mtimeMs }; } catch { return undefined; }
  }))).filter((entry): entry is { full: string; mtimeMs: number } => !!entry);
  withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of withTimes.slice(maxSavedHandoffs)) await rm(stale.full, { force: true });
}
