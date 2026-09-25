import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What has to pass before a head's work is accepted, or a lane is merged
 * (docs/Gates_Plan.md, section 1). Read from the lead's folder only, never from
 * a worktree, so the agent being checked can't edit its own gates away.
 *
 * `.hydra/gates.json` wins. Without it, an older `.hydra/checks.json` still
 * works, its checks read as command gates. With neither, there are no gates.
 * Everything in gates.json is validated; anything unknown is refused with the
 * reason, so a typo never silently turns a gate off.
 */
export type GateType = 'command' | 'screenshots' | 'review';
/** Who reviews: the other agent (the default), the same one, or a fixed one. */
export type ReviewerChoice = 'other' | 'same' | 'claude' | 'codex';
export type LanePolicy = 'onMerge' | 'off';
interface GateBase {
  id: string; required: boolean;
  /** The pack this gate comes from (docs/Packs_Plan.md). Set only by the packs loader; gates.json can't set it. */
  pack?: string;
}
/** Extra environment for the process a pack gate starts: `{node}` runs Hydra's executable with ELECTRON_RUN_AS_NODE. Set only by the packs loader. */
interface GateProcess { env?: Record<string, string> }
export interface CommandGate extends GateBase, GateProcess { type: 'command'; command: string[]; timeoutSeconds: number }
export interface ScreenshotsGate extends GateBase, GateProcess { type: 'screenshots'; start: string[]; url: string; widths: number[]; readyTimeoutSeconds: number }
export interface ReviewGate extends GateBase {
  type: 'review'; reviewer: ReviewerChoice; focus: string;
  /** A pack's review gate may name one of that pack's roles. gates.json can't. */
  role?: string;
  /** That role, filled in by the packs loader, so the reviewer's prompt includes its instructions. */
  reviewerRole?: { title: string; instructions: string };
}
export type Gate = CommandGate | ScreenshotsGate | ReviewGate;
export interface GatesConfig {
  /** Where the gates came from: gates.json, checks.json (as command gates), or neither. */
  source: 'gates' | 'checks' | 'none';
  /** From gates.json; otherwise the head's default applies. */
  maxAttempts?: number;
  lanes: LanePolicy;
  gates: Gate[];
}

export const maxGates = 12;
export const gateIdPattern = /^[a-z0-9-]{1,24}$/;
export const defaultScreenshotWidths: readonly number[] = [390, 768, 1280];
const reviewerChoices: readonly ReviewerChoice[] = ['other', 'same', 'claude', 'codex'];
const gateKeys: Readonly<Record<GateType, readonly string[]>> = {
  command: ['id', 'type', 'required', 'command', 'timeoutSeconds'],
  screenshots: ['id', 'type', 'required', 'start', 'url', 'widths', 'readyTimeoutSeconds'],
  review: ['id', 'type', 'required', 'reviewer', 'focus'],
};

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} must be an object.`);
  return value as Record<string, unknown>;
};
const onlyKeys = (source: Record<string, unknown>, allowed: readonly string[], what: string): void => {
  const unknown = Object.keys(source).filter(key => !allowed.includes(key));
  if (unknown.length) throw new Error(`${what} has an unknown setting "${unknown[0]}".`);
};
const wholeNumber = (value: unknown, fallback: number, min: number, max: number, what: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error(`${what} must be a whole number from ${min} to ${max}.`);
  return value;
};
/** A command as an argument list, like ["npm", "test"]. Never a shell string. */
const argumentList = (value: unknown, what: string): string[] => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || value.some(part => typeof part !== 'string' || !part || part.length > 4000 || part.includes('\0'))) {
    throw new Error(`${what} must be a list of 1–64 strings, like ["npm", "test"].`);
  }
  return [...value] as string[];
};
/** Only the local machine: http or https on localhost or 127.0.0.1. `{port}` is allowed as the port. */
export function validScreenshotUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url.replaceAll('{port}', '1')); } catch { return false; }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') && !parsed.username && !parsed.password;
}

/**
 * One gate, from gates.json or from a pack. A pack's review gate may also name
 * one of the pack's roles (`options.roles`); everything else is the same.
 */
export function parseGate(value: unknown, index: number, options: { roles?: readonly string[] } = {}): Gate {
  const source = record(value, `Gate ${index + 1}`);
  const id = source.id;
  if (typeof id !== 'string' || !gateIdPattern.test(id)) throw new Error(`Gate ${index + 1} needs an "id" of 1–24 lowercase letters, digits or dashes.`);
  const what = `Gate "${id}"`;
  const type = source.type;
  if (type !== 'command' && type !== 'screenshots' && type !== 'review') throw new Error(`${what} has an unknown "type"; use "command", "screenshots" or "review".`);
  onlyKeys(source, options.roles && type === 'review' ? [...gateKeys.review, 'role'] : gateKeys[type], what);
  if (source.required !== undefined && typeof source.required !== 'boolean') throw new Error(`${what}: "required" must be true or false.`);
  const required = source.required !== false;
  if (type === 'command') {
    return { id, type, required, command: argumentList(source.command, `${what}: "command"`), timeoutSeconds: wholeNumber(source.timeoutSeconds, 600, 1, 900, `${what}: "timeoutSeconds"`) };
  }
  if (type === 'screenshots') {
    const start = argumentList(source.start, `${what}: "start"`);
    if (typeof source.url !== 'string' || source.url.length > 2000 || !validScreenshotUrl(source.url)) throw new Error(`${what}: "url" must be an http or https address on localhost or 127.0.0.1, like "http://localhost:{port}/".`);
    let widths = [...defaultScreenshotWidths];
    if (source.widths !== undefined) {
      if (!Array.isArray(source.widths) || source.widths.length < 1 || source.widths.length > 4) throw new Error(`${what}: "widths" must list 1–4 widths.`);
      widths = source.widths.map(width => wholeNumber(width, 0, 240, 3840, `${what}: each width`));
      if (new Set(widths).size !== widths.length) throw new Error(`${what}: "widths" lists a width twice.`);
    }
    return { id, type, required, start, url: source.url, widths, readyTimeoutSeconds: wholeNumber(source.readyTimeoutSeconds, 90, 1, 600, `${what}: "readyTimeoutSeconds"`) };
  }
  const reviewer = source.reviewer ?? 'other';
  if (!reviewerChoices.includes(reviewer as ReviewerChoice)) throw new Error(`${what}: "reviewer" must be "other", "same", "claude" or "codex".`);
  if (source.focus !== undefined && (typeof source.focus !== 'string' || source.focus.length > 2000)) throw new Error(`${what}: "focus" must be text of up to 2000 characters.`);
  if (source.role !== undefined && (typeof source.role !== 'string' || !options.roles?.includes(source.role))) throw new Error(`${what}: "role" must name one of this pack's roles.`);
  return { id, type, required, reviewer: reviewer as ReviewerChoice, focus: typeof source.focus === 'string' ? source.focus.trim() : '', ...(typeof source.role === 'string' ? { role: source.role } : {}) };
}

/** Validate the contents of a gates.json. Throws the first problem found, in plain English. */
export function parseGatesConfig(value: unknown): Omit<GatesConfig, 'source'> {
  const source = record(value, 'The gates file');
  onlyKeys(source, ['$schema', 'maxAttempts', 'lanes', 'gates'], 'The gates file');
  const lanes = source.lanes ?? 'onMerge';
  if (lanes !== 'onMerge' && lanes !== 'off') throw new Error('"lanes" must be "onMerge" or "off".');
  if (!Array.isArray(source.gates)) throw new Error('The gates file needs a "gates" list.');
  if (source.gates.length > maxGates) throw new Error(`There can be at most ${maxGates} gates (found ${source.gates.length}).`);
  const gates = source.gates.map((gate, index) => parseGate(gate, index));
  const seen = new Set<string>();
  for (const gate of gates) { if (seen.has(gate.id)) throw new Error(`Two gates have the id "${gate.id}".`); seen.add(gate.id); }
  return {
    ...(source.maxAttempts !== undefined ? { maxAttempts: wholeNumber(source.maxAttempts, 0, 1, 10, '"maxAttempts"') } : {}),
    lanes, gates,
  };
}

/** One check from the older .hydra/checks.json. */
export interface HelperCheck { id: string; command: string[]; timeoutSeconds: number; required: boolean }

const readOptional = async (file: string, name: string): Promise<string | undefined> => {
  try { return (await readFile(file, 'utf8')).replace(/^﻿/, ''); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`${name} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
};

/** .hydra/checks.json, as heads have read it since before gates. [] when there is no file. */
export async function loadHelperChecks(folder: string): Promise<HelperCheck[]> {
  const raw = await readOptional(path.join(folder, '.hydra', 'checks.json'), '.hydra/checks.json');
  return raw === undefined ? [] : parseHelperChecks(raw);
}
function parseHelperChecks(raw: string): HelperCheck[] {
  const parsed = JSON.parse(raw) as { checks?: unknown };
  if (!Array.isArray(parsed.checks) || parsed.checks.length > 20) throw new Error('.hydra/checks.json must have a "checks" list of up to 20 entries.');
  return parsed.checks.map((value, index) => {
    const check = value as Record<string, unknown>;
    const command = check.command;
    if (!Array.isArray(command) || command.length < 1 || command.some(part => typeof part !== 'string' || !part)) throw new Error(`.hydra/checks.json check ${index + 1}: "command" must be a list like ["npm", "test"].`);
    const id = typeof check.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(check.id) ? check.id : `check-${index + 1}`;
    const timeoutSeconds = typeof check.timeoutSeconds === 'number' ? Math.max(1, Math.min(900, check.timeoutSeconds)) : 600;
    return { id, command: command as string[], timeoutSeconds, required: check.required !== false };
  });
}

/**
 * The gates for a folder: gates.json, else checks.json as command gates, else
 * none. Only ever reads the folder it is given, which must be the lead's.
 */
export async function loadGates(folder: string): Promise<GatesConfig> {
  const raw = await readOptional(path.join(folder, '.hydra', 'gates.json'), '.hydra/gates.json');
  if (raw !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`.hydra/gates.json isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    try { return { source: 'gates', ...parseGatesConfig(parsed) }; }
    catch (error) { throw new Error(`.hydra/gates.json: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const checks = await readOptional(path.join(folder, '.hydra', 'checks.json'), '.hydra/checks.json');
  if (checks === undefined) return { source: 'none', lanes: 'onMerge', gates: [] };
  return {
    source: 'checks', lanes: 'onMerge',
    gates: parseHelperChecks(checks).map(check => ({ id: check.id, type: 'command', required: check.required, command: check.command, timeoutSeconds: check.timeoutSeconds })),
  };
}
