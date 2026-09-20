import type { request } from 'node:https';
import type { DesktopUpdateCurrent } from './desktopUpdateFeed.js';
import { DesktopUpdateJournal } from './desktopUpdateJournal.js';
import { downloadDesktopUpdateOperation } from './desktopUpdateOperation.js';
import type { InstalledDesktopUpdateTrust, VerifiedDesktopUpdate } from './desktopSignedUpdate.js';
import type { StagedDesktopUpdate } from './desktopUpdateStaging.js';

export interface ConfirmedDesktopUpdateDownloadOptions {
  journal: DesktopUpdateJournal;
  operationId: string;
  current: DesktopUpdateCurrent;
  trust: InstalledDesktopUpdateTrust;
  clock: () => number;
  origin: string;
  userDataDirectory: string;
  /** Main-owned native confirmation. A renderer boolean is never consent. */
  confirm: (update: VerifiedDesktopUpdate) => Promise<boolean>;
  requestFactory?: typeof request;
  onDownloadStart?: () => void;
  /** Test seam; production always uses the journal-bound staging operation. */
  downloadOperation?: typeof downloadDesktopUpdateOperation;
}

export async function confirmedDesktopUpdateDownload(options: ConfirmedDesktopUpdateDownloadOptions): Promise<{ status: 'cancelled' } | { status: 'staged'; artifact: StagedDesktopUpdate }> {
  const operation = (await options.journal.load()).at(-1);
  if (!operation || operation.id !== options.operationId || operation.phase !== 'available') throw new Error('Hydra update is not available for download.');
  const update = await options.journal.loadSignedCandidate(operation.id, options.current, options.trust, options.clock());
  if (!await options.confirm(update)) return { status: 'cancelled' };
  const reverified = await options.journal.loadSignedCandidate(operation.id, options.current, options.trust, options.clock());
  const artifact = await (options.downloadOperation ?? downloadDesktopUpdateOperation)({
    journal: options.journal, operationId: operation.id, update: reverified, origin: options.origin,
    userDataDirectory: options.userDataDirectory, requestFactory: options.requestFactory,
    onDownloadStart: options.onDownloadStart
  });
  return { status: 'staged', artifact };
}
