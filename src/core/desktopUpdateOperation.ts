import type { request } from 'node:https';
import type { VerifiedDesktopUpdate } from './desktopSignedUpdate';
import { DesktopUpdateJournal } from './desktopUpdateJournal';
import { stageDesktopUpdateArtifact, type StagedDesktopUpdate } from './desktopUpdateStaging';

export interface DesktopUpdateDownloadOptions {
  /** Already authenticated by the installed main-process metadata key. */
  update: VerifiedDesktopUpdate;
  /** Immutable installed origin; never from the feed or renderer. */
  origin: string;
  /** Main-owned profile path. Journal files must be outside hydra-updater. */
  userDataDirectory: string;
  journal: DesktopUpdateJournal;
  operationId: string;
  signal?: AbortSignal;
  requestFactory?: typeof request;
}

/**
 * Commits available -> downloading before staging creates any file. A staged
 * SHA-256 match is not Authenticode acceptance or permission to install.
 */
export async function downloadDesktopUpdateOperation(options: DesktopUpdateDownloadOptions): Promise<StagedDesktopUpdate> {
  const current = (await options.journal.load()).at(-1);
  if (!current || current.id !== options.operationId || current.phase !== 'available' ||
      current.sequence !== options.update.sequence || current.payloadSha256 !== options.update.payloadSha256 ||
      current.version !== options.update.availableVersion || current.artifactSha256 !== options.update.artifact.sha256 ||
      current.artifactBytes !== options.update.artifactBytes) {
    throw new Error('Desktop update operation does not match the durable signed candidate.');
  }
  await options.journal.advance(current.id, 'available', 'downloading');
  try {
    return await stageDesktopUpdateArtifact({
      userDataDirectory: options.userDataDirectory, origin: options.origin, update: options.update,
      operationId: current.id, signal: options.signal, requestFactory: options.requestFactory
    });
  } catch (error) {
    try { await options.journal.advance(current.id, 'downloading', 'failed', { reason: 'download-failed' }); }
    catch { throw new Error('Desktop update download outcome could not be persisted; operation requires review.', { cause: error }); }
    throw error;
  }
}
