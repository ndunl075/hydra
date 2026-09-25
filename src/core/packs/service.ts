import { homedir } from 'node:os';
import path from 'node:path';
import { loadGates } from '../gates/config';
import type { GatesLoader } from '../gates';
import { allowPack, canonicalProject, revokePack } from './allowed';
import { effectiveGates, overGateCap, type EffectiveGates } from './gates';
import { projectPacks, readPacksFile, withPack, withSkipGate, writePacksFile, type PackPlaces, type ProjectPack } from './project';

/**
 * Packs for one Hydra window (docs/Packs_Plan.md): where they live, each
 * project's state, the gates loader for heads and lanes, and the few writes
 * the Packs page makes. No editor API here, so it is tested directly;
 * src/extensionPacks.ts builds it from the extension's paths and settings.
 *
 * Nothing here decides on its own to allow a pack: `allow` and `turnOn` are for
 * the button at the end of a pack's review panel, and take the hash that panel
 * showed, so a pack that changed while you were reading it isn't allowed.
 */
export interface PackServiceOptions {
  /** `<extensionPath>/packs`. */
  builtin: string;
  /** Your packs folder, read at each use (the hydra.packs.folder setting, else ~/.hydra/packs). */
  userFolder: () => string;
  /** `globalStorage/packs`: the allow record and the cache. */
  storage: string;
  /** This Hydra's version. */
  version: string;
  /** Hydra's own executable, run as Node for `{node}`. */
  nodeExecutable?: string;
}

/** Decision 1: your packs live in ~/.hydra/packs unless hydra.packs.folder names another absolute folder. */
export const defaultUserPacksFolder = (): string => path.join(homedir(), '.hydra', 'packs');

export class PackService {
  constructor(private readonly options: PackServiceOptions) {}

  places(): PackPlaces {
    return {
      builtin: this.options.builtin, user: this.options.userFolder(),
      allowedFile: path.join(this.options.storage, 'allowed.json'), cacheRoot: path.join(this.options.storage, 'cache'),
      version: this.options.version,
    };
  }

  /** Every pack's state in a project, for the Packs page: listed packs first, then the rest as Off. */
  state(folder: string): Promise<{ exists: boolean; packs: ProjectPack[] }> { return projectPacks(folder, this.places()); }

  effectiveGates(folder: string): Promise<EffectiveGates> { return effectiveGates(folder, this.places(), this.options.nodeExecutable ?? process.execPath); }

  /** The loader HelperService and LaneService read gates with. */
  readonly gates: GatesLoader = folder => this.effectiveGates(folder);

  private async installed(folder: string, id: string): Promise<ProjectPack> {
    const pack = (await this.state(folder)).packs.find(candidate => candidate.id === id && candidate.pack && candidate.state !== 'invalid' && candidate.state !== 'notInstalled');
    if (!pack?.pack?.valid) throw new Error(`There's no usable pack "${id}".`);
    return pack;
  }

  /** Turn a pack on or off in packs.json. Turning on doesn't allow it: that is `allow`. */
  async setEnabled(folder: string, id: string, on: boolean): Promise<void> {
    const { file } = await readPacksFile(folder);
    if (on) {
      const adding = await this.installed(folder, id);
      const listed = (await projectPacks(folder, this.places(), { listedOnly: true })).packs;
      const over = overGateCap(await loadGates(folder), listed, adding);
      if (over) throw new Error(over);
    }
    await writePacksFile(folder, withPack(file, id, on));
  }

  /**
   * Record your OK for a pack in this project. `reviewedHash` is the hash the
   * review panel showed: if the pack changed since, nothing is recorded.
   */
  async allow(folder: string, id: string, reviewedHash: string): Promise<void> {
    const { pack } = await this.installed(folder, id);
    if (pack!.hash !== reviewedHash) throw new Error(`The ${id} pack changed while you were reviewing it. Review it again.`);
    await allowPack(this.places().allowedFile, await canonicalProject(folder), pack!, this.options.version);
  }

  /** The review panel's button: allow, then turn on. */
  async turnOn(folder: string, id: string, reviewedHash: string): Promise<void> {
    await this.allow(folder, id, reviewedHash);
    await this.setEnabled(folder, id, true);
  }

  /** Forget your OK for a pack in this project. */
  async forget(folder: string, id: string): Promise<void> {
    await revokePack(this.places().allowedFile, await canonicalProject(folder), id);
  }

  /** "Skip in this project" for one pack gate, written to packs.json. */
  async skipGate(folder: string, id: string, gate: string, skip: boolean): Promise<void> {
    const { pack } = await this.installed(folder, id);
    if (skip && !pack!.valid!.manifest.gates.some(candidate => candidate.id === gate)) throw new Error(`The ${pack!.valid!.manifest.title} pack has no gate "${gate}".`);
    const { file } = await readPacksFile(folder);
    await writePacksFile(folder, withSkipGate(file, id, gate, skip));
  }
}
