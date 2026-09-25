import { homedir } from 'node:os';
import path from 'node:path';
import { loadGates } from '../gates/config';
import type { GatesLoader } from '../gates';
import type { Provider } from '../model';
import { allowPack, canonicalProject, revokePack } from './allowed';
import { buildRolePlugin } from './cache';
import { effectiveGates, overGateCap, type EffectiveGates } from './gates';
import { RoleUnavailable, activeRolesSentence, findRole, parseRoleRef, roleRefPattern, roleSummaries, roleUnavailableReason, type ResolvedRole, type RoleSource, type RoleSummary } from './launch';
import { activePacks, projectPacks, readPacksFile, withPack, withSkipGate, writePacksFile, type PackPlaces, type ProjectPack } from './project';

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
  /**
   * The names of your own MCP servers, per agent (read-only, as the MCP servers page
   * reads them): a pack server with the same name is left out. Missing: none.
   */
  userServers?: () => Promise<Partial<Record<Provider, readonly string[]>>>;
}

/** Decision 1: your packs live in ~/.hydra/packs unless hydra.packs.folder names another absolute folder. */
export const defaultUserPacksFolder = (): string => path.join(homedir(), '.hydra', 'packs');

export class PackService implements RoleSource {
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

  // ---- Roles (docs/Packs_Plan.md, section 5) ----

  /** The active packs' roles, in packs.json order: the lead's instructions, hydra_start_head's `role`, and the pickers. */
  async roles(folder: string): Promise<RoleSummary[]> {
    const active = await activePacks(folder, this.places());
    return roleSummaries(active.map(pack => ({ id: pack.id, title: pack.title, roles: pack.pack?.valid?.manifest.roles ?? [] })));
  }

  /** The active role a name means ("builder" or "coding/builder"), or why there's none, listing the active roles. */
  async pick(folder: string, name: string): Promise<RoleSummary> {
    const roles = await this.roles(folder);
    try { return findRole(roles, name); }
    catch (error) {
      const ref = roleRefPattern.exec(name);
      if (!ref) throw error;
      const unavailable = await this.unavailable(folder, ref[1]!, ref[2]!);
      throw new Error(`The role ${name} isn't available (${unavailable.reason}). ${activeRolesSentence(roles)}`);
    }
  }

  /**
   * A role for one launch, from its active pack's checked copy: the copy's hash is
   * verified (and the copy repaired) here, at every launch, since a head can write
   * outside its worktree (R8). Its Claude plugin is built beside the copy. Throws
   * RoleUnavailable with the reason when the pack isn't on or has no such role.
   */
  async resolve(folder: string, ref: string): Promise<ResolvedRole> {
    const { pack: packId, role: roleId } = parseRoleRef(ref);
    const listed = (await projectPacks(folder, this.places(), { listedOnly: true })).packs.find(pack => pack.id === packId);
    const valid = listed?.state === 'on' ? listed.pack?.valid : undefined;
    const role = valid?.manifest.roles.find(candidate => candidate.id === roleId);
    if (!listed || !valid || !role || !listed.copy || !listed.pack?.hash || !listed.pack.files) throw await this.unavailable(folder, packId, roleId);
    const plugin = role.skills.length
      ? await buildRolePlugin(this.places().cacheRoot, { id: packId, hash: listed.pack.hash, files: listed.pack.files, title: listed.title }, role).catch(() => undefined)
      : undefined;
    const userServers = await this.options.userServers?.().catch(() => ({})) ?? {};
    return {
      ref: `${packId}/${roleId}`, pack: packId, packTitle: listed.title, role, copy: listed.copy,
      instructions: valid.instructions[roleId] ?? '',
      skills: role.skills.map(id => ({ id, description: valid.skills.find(skill => skill.id === id)?.description ?? '' })),
      servers: role.mcpServers.flatMap(id => valid.manifest.mcpServers[id] && valid.servers[id] ? [{ id, spec: valid.manifest.mcpServers[id]!, info: valid.servers[id]! }] : []),
      ...(plugin ? { plugin } : {}),
      nodeExecutable: this.options.nodeExecutable ?? process.execPath,
      userServers,
    };
  }

  /** Why a pack's role can't be used here, with its title when the pack can still be read. */
  private async unavailable(folder: string, packId: string, roleId: string): Promise<RoleUnavailable> {
    const pack = (await this.state(folder).catch(() => ({ packs: [] as ProjectPack[] }))).packs.find(candidate => candidate.id === packId);
    const title = pack?.pack?.valid?.manifest.roles.find(candidate => candidate.id === roleId)?.title ?? roleId;
    return new RoleUnavailable(`${packId}/${roleId}`, title, roleUnavailableReason(packId, pack?.pack?.valid ? pack.title : undefined, pack?.state, roleId));
  }

  /** "Skip in this project" for one pack gate, written to packs.json. */
  async skipGate(folder: string, id: string, gate: string, skip: boolean): Promise<void> {
    const { pack } = await this.installed(folder, id);
    if (skip && !pack!.valid!.manifest.gates.some(candidate => candidate.id === gate)) throw new Error(`The ${pack!.valid!.manifest.title} pack has no gate "${gate}".`);
    const { file } = await readPacksFile(folder);
    await writePacksFile(folder, withSkipGate(file, id, gate, skip));
  }
}
