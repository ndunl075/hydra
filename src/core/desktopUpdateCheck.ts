import type { DesktopUpdateCurrent } from './desktopUpdateFeed.js';
import { DesktopUpdateJournal, type DesktopUpdateOperation } from './desktopUpdateJournal.js';
import type { InstalledDesktopUpdateTrust, VerifiedDesktopUpdate } from './desktopSignedUpdate.js';
import { fetchDesktopUpdateEnvelope } from './desktopUpdateStaging.js';

export interface DesktopUpdateCheckOptions {
  journal: DesktopUpdateJournal;
  origin: string;
  current: DesktopUpdateCurrent;
  trust: InstalledDesktopUpdateTrust;
  clock: () => number;
  fetchEnvelope?: typeof fetchDesktopUpdateEnvelope;
}

/** No renderer-controlled URL, path, trust root, or release fields enter this coordinator. */
export async function checkDesktopUpdateCandidate(options: DesktopUpdateCheckOptions): Promise<{ operation: DesktopUpdateOperation; update: VerifiedDesktopUpdate }> {
  const existing = (await options.journal.load()).at(-1);
  if (existing && !['healthy', 'refused', 'failed'].includes(existing.phase)) {
    if (existing.phase !== 'available') throw new Error('Pending Hydra update requires review before another check.');
    return { operation: existing, update: await options.journal.loadSignedCandidate(existing.id, options.current, options.trust, options.clock()) };
  }
  const raw = await (options.fetchEnvelope ?? fetchDesktopUpdateEnvelope)(options.origin);
  const operation = await options.journal.startSigned(raw, options.current, options.trust, options.clock());
  return { operation, update: await options.journal.loadSignedCandidate(operation.id, options.current, options.trust, options.clock()) };
}
