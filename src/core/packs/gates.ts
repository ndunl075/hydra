import { loadGates, type Gate, type GatesConfig } from '../gates/config';
import { notRun } from '../gates/types';
import type { JobCheckResult } from '../jobs';
import { packCaps, resolvePlaceholders } from './format';
import { projectPacks, type PackPlaces, type ProjectPack } from './project';

/**
 * A project's gates with its packs' (docs/Packs_Plan.md, section 1, "Gates"):
 *
 * 1. `.hydra/gates.json` (or checks.json) comes first.
 * 2. Then each active pack's gates, in the order packs.json lists the packs.
 * 3. The first gate with an id wins: a project replaces a pack's gate by
 *    defining the same id, and a later pack's gate with a taken id is dropped.
 *    Dropped gates are always reported, with why.
 * 4. `skipGates` in packs.json turns a pack gate off for the project.
 *
 * Only gates.json sets `maxAttempts` and the `lanes` policy. A listed pack that
 * isn't active runs nothing: each of its gates comes back as "not run" with the
 * reason, so a missing or changed pack shows on every head and lane merge
 * instead of its checks silently stopping. "Not run" never blocks.
 */
export interface DroppedGate { id: string; pack: string; reason: string }
export interface EffectiveGates extends GatesConfig {
  /** Results for the gates of listed packs that can't run, and for listed packs that aren't installed or valid. */
  notRun: JobCheckResult[];
  /** Pack gates that won't run here, with why: "Replaced by gates.json", "Replaced by the Coding pack", "Skipped in this project". */
  dropped: DroppedGate[];
}

/** A pack gate made runnable: `{pack}` is its checked copy, `{node}` is Hydra's executable as Node, and it says which pack it's from. */
function packGate(gate: Gate, pack: ProjectPack, nodeExecutable: string): Gate {
  const copy = pack.copy!;
  if (gate.type === 'command') {
    const { parts, env } = resolvePlaceholders(gate.command, copy, nodeExecutable);
    return { ...gate, command: parts, ...(env ? { env } : {}), pack: pack.id, packTitle: pack.title };
  }
  if (gate.type === 'screenshots') {
    const { parts, env } = resolvePlaceholders(gate.start, copy, nodeExecutable);
    return { ...gate, start: parts, ...(env ? { env } : {}), pack: pack.id, packTitle: pack.title };
  }
  const role = gate.role ? pack.pack?.valid?.manifest.roles.find(candidate => candidate.id === gate.role) : undefined;
  const instructions = role ? pack.pack?.valid?.instructions[role.id] : undefined;
  return { ...gate, pack: pack.id, packTitle: pack.title, ...(role && instructions ? { reviewerRole: { title: `${role.title} (${pack.title} pack)`, instructions, ...(role.tools.includes('web') ? { web: true } : {}) } } : {}) };
}

/**
 * Combine a project's own gates with its listed packs' (pure). `listed` is in
 * packs.json order, with each pack's state; only packs that are on contribute
 * runnable gates.
 */
export function combineGates(base: GatesConfig, listed: readonly ProjectPack[], nodeExecutable: string): EffectiveGates {
  const gates = [...base.gates];
  const owner = new Map<string, string | undefined>(gates.map(gate => [gate.id, undefined]));
  const notRunResults: JobCheckResult[] = [];
  const dropped: DroppedGate[] = [];
  const replacedBy = (id: string) => { const by = owner.get(id); return by === undefined ? 'Replaced by gates.json.' : `Replaced by the ${listed.find(pack => pack.id === by)?.title ?? by} pack.`; };
  for (const pack of listed) {
    const manifest = pack.pack?.valid?.manifest;
    if (pack.state !== 'on') {
      const reason = pack.reason ?? `The ${pack.title} pack isn't on.`;
      if (!manifest) { notRunResults.push({ ...notRun({ id: pack.id, type: 'command', required: false }, reason), pack: pack.id, packTitle: pack.title }); continue; }
      for (const gate of manifest.gates) {
        if (pack.entry?.skipGates?.includes(gate.id) || owner.has(gate.id)) continue;
        notRunResults.push({ ...notRun(gate, reason), pack: pack.id, packTitle: pack.title });
      }
      continue;
    }
    for (const gate of manifest!.gates) {
      if (pack.entry?.skipGates?.includes(gate.id)) { dropped.push({ id: gate.id, pack: pack.id, reason: 'Skipped in this project.' }); continue; }
      if (owner.has(gate.id)) { dropped.push({ id: gate.id, pack: pack.id, reason: replacedBy(gate.id) }); continue; }
      if (gates.length >= packCaps.effectiveGates) { notRunResults.push({ ...notRun(gate, `Not run: the project would have more than ${packCaps.effectiveGates} gates.`), pack: pack.id, packTitle: pack.title }); continue; }
      gates.push(packGate(gate, pack, nodeExecutable));
      owner.set(gate.id, pack.id);
    }
  }
  return { ...base, gates, notRun: notRunResults, dropped };
}

/**
 * How many gates a project would have with one more pack turned on, and the
 * reason it's refused when that passes 24 (the Packs page asks before turning it on).
 */
export function overGateCap(base: GatesConfig, listed: readonly ProjectPack[], adding: ProjectPack): string | undefined {
  const ids = new Set(base.gates.map(gate => gate.id));
  for (const pack of [...listed.filter(other => other.id !== adding.id && other.state === 'on'), adding]) {
    for (const gate of pack.pack?.valid?.manifest.gates ?? []) if (!pack.entry?.skipGates?.includes(gate.id)) ids.add(gate.id);
  }
  return ids.size > packCaps.effectiveGates ? `Turning on the ${adding.title} pack would give this project ${ids.size} gates; the limit is ${packCaps.effectiveGates}.` : undefined;
}

/**
 * The gates loader for heads and lanes: gates.json plus the active packs'
 * gates, from the lead folder only. Throws when gates.json or packs.json can't
 * be used, as loadGates does, so a broken file is never mistaken for no gates.
 */
export async function effectiveGates(folder: string, places: PackPlaces, nodeExecutable: string = process.execPath): Promise<EffectiveGates> {
  const base = await loadGates(folder);
  const { packs } = await projectPacks(folder, places, { listedOnly: true });
  return combineGates(base, packs, nodeExecutable);
}
