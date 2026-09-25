import { maskSpec, type McpServerSpec } from '../../core/mcpServers';
import { resolvePlaceholders, type PackManifest, type ValidPack } from '../../core/packs/format';
import { sourceLabel, type InstalledPack, type PackSource } from '../../core/packs/registry';
import type { PackState, ProjectPack } from '../../core/packs/project';

/**
 * Pure display logic for Settings → Packs (docs/Packs_Plan.md, section 6): what
 * each card shows, which one button it gets, and exactly what the "What it
 * contains" disclosure and the review panel list (section 4) — the same
 * content, laid out the same way. No `vscode` import, so this is unit tested
 * directly (tests/packsPage.test.ts); packs.ts's client-side script re-implements
 * the same shapes in plain JS, the same split as the Gates and MCP servers pages.
 *
 * Nothing here decides to allow a pack: the review panel's own button message,
 * handled in packs.ts, is the only caller of PackService.turnOn.
 */

const gateKindLabel: Record<string, string> = { command: 'Command', screenshots: 'Screenshots', review: 'Review' };
/** Every pack gate runs at the same two points (docs/Packs_Plan.md, section 4). */
export const gateRunsWhen = "Before a head's work is accepted, and when you merge a lane.";

export interface PackCommandLine { text: string; parts: readonly string[] }
export interface ReviewGateView {
  id: string; kind: string; required: boolean; when: string;
  /** The argument list for a command or screenshots gate, with {pack}/{node} resolved; undefined for a review gate. */
  command?: PackCommandLine;
  /** A review gate's focus and, when it names a role, that role's title. */
  focus?: string; role?: string;
}
export interface ReviewServerView {
  id: string; kind: 'stdio' | 'http' | 'sse';
  /** The stdio command line, masked (docs/Packs_Plan.md, section 4: "env names ... masked with maskSpec"). */
  command?: PackCommandLine;
  url?: string;
  /** Env or header names Hydra fills in from your environment, and their (masked) values. */
  env: { name: string; value: string }[];
  /** The roles that use this server. */
  roles: string[];
  claudeOnly?: string;
  downloads?: string;
  note: string;
}
export interface ReviewRoleView {
  id: string; title: string; description: string; provider: string;
  tools: string[]; toolsSentence?: string;
  changes: 'required' | 'optional';
  instructions: string;
  skills: string[];
}
export interface ReviewSkillView {
  id: string; description: string; files: readonly string[]; scripts: readonly string[];
}
/** What the review panel lists, and what the card's "What it contains" disclosure lists (the same content). */
export interface PackContentsView {
  gates: ReviewGateView[];
  servers: ReviewServerView[];
  roles: ReviewRoleView[];
  skills: ReviewSkillView[];
}

const commandLine = (parts: readonly string[], packFolder: string, nodeExecutable: string): PackCommandLine => {
  const resolved = resolvePlaceholders(parts, packFolder, nodeExecutable).parts;
  return { parts: resolved, text: resolved.join(' ') };
};

/** "Heads with this role can browse the web." — decision-4-style plain sentence for a role's tools. */
const toolsSentence = (tools: readonly string[]): string | undefined => tools.includes('web') ? 'Heads with this role can browse the web.' : undefined;

/**
 * Every gate, server, role and skill a pack has, laid out exactly as section 4
 * says the review panel must: resolved command lines, masked server values,
 * the roles using each server, and scripts flagged.
 */
export function buildPackContents(manifest: PackManifest, valid: Pick<ValidPack, 'skills' | 'instructions' | 'servers'>, packFolder: string, nodeExecutable = 'node'): PackContentsView {
  const roleTitle = (id: string) => manifest.roles.find(role => role.id === id)?.title ?? id;
  const gates: ReviewGateView[] = manifest.gates.map(gate => {
    if (gate.type === 'command') return { id: gate.id, kind: gateKindLabel.command!, required: gate.required, when: gateRunsWhen, command: commandLine(gate.command, packFolder, nodeExecutable) };
    if (gate.type === 'screenshots') return { id: gate.id, kind: gateKindLabel.screenshots!, required: gate.required, when: gateRunsWhen, command: commandLine(gate.start, packFolder, nodeExecutable) };
    return { id: gate.id, kind: gateKindLabel.review!, required: gate.required, when: gateRunsWhen, ...(gate.focus ? { focus: gate.focus } : {}), ...(gate.role ? { role: roleTitle(gate.role) } : {}) };
  });
  const servers: ReviewServerView[] = Object.entries(manifest.mcpServers).map(([id, spec]) => {
    const masked = maskSpec(spec.type === 'stdio' ? { ...spec, ...(() => { const resolved = resolvePlaceholders([spec.command, ...spec.args], packFolder, nodeExecutable); return { command: resolved.parts[0]!, args: resolved.parts.slice(1) }; })() } : spec) as McpServerSpec;
    const roles = manifest.roles.filter(role => role.mcpServers.includes(id)).map(role => role.title);
    const info = valid.servers[id];
    const note = 'Heads call its tools without asking.';
    if (masked.type === 'stdio') {
      return {
        id, kind: 'stdio', command: { parts: [masked.command, ...masked.args], text: [masked.command, ...masked.args].join(' ') },
        env: Object.entries(masked.env).map(([name, value]) => ({ name, value })), roles, note,
        ...(info?.claudeOnly ? { claudeOnly: info.claudeOnly } : {}), ...(info?.downloads ? { downloads: info.downloads } : {}),
      };
    }
    return {
      id, kind: masked.type, url: masked.url, env: Object.entries(masked.headers).map(([name, value]) => ({ name, value })), roles, note,
      ...(info?.claudeOnly ? { claudeOnly: info.claudeOnly } : {}),
    };
  });
  const roles: ReviewRoleView[] = manifest.roles.map(role => ({
    id: role.id, title: role.title, description: role.description, provider: role.provider === 'codex' ? 'Codex' : 'Claude',
    tools: role.tools, ...(toolsSentence(role.tools) ? { toolsSentence: toolsSentence(role.tools) } : {}),
    changes: role.changes, instructions: valid.instructions[role.id] ?? '', skills: role.skills,
  }));
  const skills: ReviewSkillView[] = valid.skills.map(skill => ({ id: skill.id, description: skill.description, files: skill.files, scripts: skill.scripts }));
  return { gates, servers, roles, skills };
}

// ---- The card: source chip, counts, state, and its one button ----

export const stateLabel: Record<PackState, string> = {
  off: 'Off', on: 'On', needsOk: 'Needs your OK', changed: 'Changed', notInstalled: 'Not installed', invalid: 'Invalid',
};
export type PackButtonId = 'turnOn' | 'turnOff' | 'review' | 'trustAndReview';
export interface PackButtonView { id: PackButtonId; label: string }
/** The one button each state gets (docs/Packs_Plan.md, section 3's table and section 6). No button for notInstalled/invalid. */
export function packButton(state: PackState): PackButtonView | undefined {
  switch (state) {
    case 'off': return { id: 'turnOn', label: 'Turn on' };
    case 'on': return { id: 'turnOff', label: 'Turn off' };
    case 'needsOk': return { id: 'review', label: 'Review and allow' };
    case 'changed': return { id: 'review', label: 'Review changes' };
    default: return undefined;
  }
}
/** The review panel's own button (section 4): built-in packs get a plain "Turn on"; anything else warns first. */
export const reviewButtonLabel = (source: PackSource): string => source === 'builtin' ? 'Turn on' : 'Trust and turn on';
/** Section 4's warning line, shown only for a pack that isn't built into Hydra. */
export const thirdPartyWarning = 'Not from Hydra. Its author, not Hydra, decides what these commands and servers do.';

/** "3 roles · 1 gate · 2 skills · 0 servers" (section 6). */
export function packCounts(manifest: Pick<PackManifest, 'roles' | 'gates' | 'mcpServers'>, skillCount: number): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return [plural(manifest.roles.length, 'role'), plural(manifest.gates.length, 'gate'), plural(skillCount, 'skill'), plural(Object.keys(manifest.mcpServers).length, 'server')].join(' · ');
}

export interface PackCardView {
  id: string; title: string; description?: string; source: PackSource; sourceLabel: string;
  state: PackState; stateLabel: string; reason?: string; notes: readonly string[];
  counts?: string;
  button?: PackButtonView;
  contents?: PackContentsView;
  /** The content hash the review panel shows, and what `turnOn(folder, id, reviewedHash)` is called with. */
  hash?: string;
  reviewButtonLabel?: string;
  thirdParty?: boolean;
}
/** One pack's card, from its project state (docs/Packs_Plan.md, section 3): built-in first is the caller's sort, not this function's. */
export function packCard(pack: ProjectPack, nodeExecutable = 'node'): PackCardView {
  const manifest = pack.pack?.valid?.manifest;
  const contents = pack.pack?.valid
    ? buildPackContents(pack.pack.valid.manifest, pack.pack.valid, pack.copy ?? pack.pack.folder, nodeExecutable)
    : undefined;
  return {
    id: pack.id, title: pack.title, description: manifest?.description, source: pack.pack?.source ?? 'user', sourceLabel: sourceLabel[pack.pack?.source ?? 'user'],
    state: pack.state, stateLabel: stateLabel[pack.state], reason: pack.reason, notes: pack.notes,
    ...(manifest ? { counts: packCounts(manifest, pack.pack?.valid?.skills.length ?? 0) } : {}),
    ...(packButton(pack.state) ? { button: packButton(pack.state) } : {}),
    ...(contents ? { contents } : {}),
    ...(pack.pack?.hash ? { hash: pack.pack.hash } : {}),
    ...(pack.pack ? { reviewButtonLabel: reviewButtonLabel(pack.pack.source), thirdParty: pack.pack.source !== 'builtin' } : {}),
  };
}
/** Built-in packs first, in packs.json order otherwise (section 6: "One card per pack, built-in first"). */
export function sortPackCards(packs: readonly ProjectPack[]): ProjectPack[] {
  return [...packs].sort((a, b) => Number(b.pack?.source === 'builtin') - Number(a.pack?.source === 'builtin'));
}

export const savedNote = 'Saved in .hydra/packs.json. Commit it to share these packs with your team.';

/** Reuse the registry's own labels, so this file never invents a second copy of them. */
export type { InstalledPack };
