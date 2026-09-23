import type { SandboxPolicy } from './generated/codex-0.154.0/v2/SandboxPolicy';

/**
 * The permission modes Hydra exposes, named exactly as each provider names them.
 * Claude takes a single `--permission-mode`; Codex splits the same ground across
 * an approval policy and a sandbox, so a Codex mode spells out both knobs.
 *
 * All three keep the agent inside the task worktree, which is the containment
 * every other Hydra guarantee assumes. `plan`/`read-only` cannot write at all;
 * `auto`/`never` still writes only inside the worktree, and for Codex the OS
 * sandbox enforces that independently of the model's own judgement.
 */
export const claudePermissionModes = ['default', 'plan', 'auto'] as const;
export type ClaudePermissionMode = typeof claudePermissionModes[number];
export const codexPermissionModes = ['on-request/workspace-write', 'on-request/read-only', 'never/workspace-write'] as const;
export type CodexPermissionMode = typeof codexPermissionModes[number];
export type PermissionModeProvider = 'claude' | 'codex';
export type TaskPermissionMode =
  | { provider: 'claude'; mode: ClaudePermissionMode }
  | { provider: 'codex'; mode: CodexPermissionMode };

/**
 * Provider modes Hydra deliberately does not expose, with the reason reported
 * verbatim so a refusal explains itself instead of looking like a gap. The first
 * two remove worktree containment outright; the rest resolve prompts in ways
 * Hydra cannot record as an approval it could later replay.
 */
export const refusedPermissionModes: ReadonlyMap<string, string> = new Map([
  ['bypassPermissions', 'skips every permission check and requires allowDangerouslySkipPermissions'],
  ['danger-full-access', 'disables the sandbox, so writes can leave the worktree'],
  ['acceptEdits', 'auto-accepts edits without an approval record Hydra can replay'],
  ['dontAsk', 'denies silently instead of surfacing the prompt'],
  ['untrusted', 'escalates every command to an approval Hydra does not model'],
  ['granular', 'splits approvals into per-capability rules Hydra does not model']
]);

/**
 * The selectable modes per provider, with the one-line description each surface
 * shows. Both the editor composer and the task settings panel read this, so the
 * names offered stay the provider's own everywhere.
 */
export const permissionModeChoices: {
  claude: { mode: ClaudePermissionMode; description: string }[];
  codex: { mode: CodexPermissionMode; description: string }[];
} = {
  claude: [
    { mode: 'default', description: 'Prompts before writes and commands.' },
    { mode: 'plan', description: 'Plans only. Runs no tools and writes nothing.' },
    { mode: 'auto', description: 'A model classifier answers the prompts.' }
  ],
  codex: [
    { mode: 'on-request/workspace-write', description: 'Prompts before writes, sandboxed to the worktree.' },
    { mode: 'on-request/read-only', description: 'Plans only. The sandbox blocks every write.' },
    { mode: 'never/workspace-write', description: 'No prompts, still sandboxed to the worktree.' }
  ]
};

export function defaultPermissionMode(provider: PermissionModeProvider): TaskPermissionMode {
  return provider === 'claude' ? { provider, mode: 'default' } : { provider, mode: 'on-request/workspace-write' };
}

/** Modes are chosen before launch and locked afterwards, so this only ever parses stored or picked values. */
export function parsePermissionMode(value: unknown, provider: PermissionModeProvider): TaskPermissionMode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose a permission mode the provider defines.');
  const candidate = value as { provider?: unknown; mode?: unknown };
  if (candidate.provider !== provider) throw new Error(`This is a ${provider} task; it cannot take a ${String(candidate.provider)} permission mode.`);
  const refusal = typeof candidate.mode === 'string' && refusedPermissionModes.get(candidate.mode);
  if (refusal) throw new Error(`Hydra does not run ${candidate.mode}: it ${refusal}. Use the official client for that.`);
  const allowed: readonly string[] = provider === 'claude' ? claudePermissionModes : codexPermissionModes;
  if (typeof candidate.mode !== 'string' || !allowed.includes(candidate.mode)) throw new Error(`Unsupported ${provider} permission mode. Choose one of: ${allowed.join(', ')}.`);
  return { provider, mode: candidate.mode } as TaskPermissionMode;
}

/**
 * Transport-level parse: the submitted value carries its own provider, which the
 * caller must still check against the task it is being saved onto.
 */
export function parseSubmittedPermissionMode(value: unknown): TaskPermissionMode {
  const provider = (value as { provider?: unknown } | null)?.provider;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Choose a permission mode for a supported provider.');
  return parsePermissionMode(value, provider);
}

/** A read-only mode produces no file changes, so its task has nothing to review or integrate. */
export function permissionModeWrites(mode: TaskPermissionMode): boolean {
  return mode.mode !== 'plan' && mode.mode !== 'on-request/read-only';
}

export function claudePermissionArgument(mode: TaskPermissionMode): ClaudePermissionMode {
  if (mode.provider !== 'claude') throw new Error('Claude cannot launch with a Codex permission mode.');
  return mode.mode;
}

/**
 * Claude reports `manual` for the host-prompt default rather than echoing
 * `default`. Every other mode must echo exactly, so a provider that silently
 * escalates or downgrades the request fails the launch instead of running.
 */
export function claudeInitMatches(mode: TaskPermissionMode, reported: unknown): boolean {
  const requested = claudePermissionArgument(mode);
  return reported === requested || (requested === 'default' && reported === 'manual');
}

export function codexThreadPolicy(mode: TaskPermissionMode): { approvalPolicy: 'on-request' | 'never'; sandbox: 'read-only' | 'workspace-write' } {
  if (mode.provider !== 'codex') throw new Error('Codex cannot start a thread with a Claude permission mode.');
  const [approvalPolicy, sandbox] = mode.mode.split('/') as ['on-request' | 'never', 'read-only' | 'workspace-write'];
  return { approvalPolicy, sandbox };
}

/** The per-turn policy restates the thread's sandbox; read-only still forbids network access. */
export function codexSandboxPolicy(mode: TaskPermissionMode, worktree: string): SandboxPolicy {
  return codexThreadPolicy(mode).sandbox === 'read-only'
    ? { type: 'readOnly', networkAccess: false }
    : { type: 'workspaceWrite', writableRoots: [worktree], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true };
}

/** Codex echoes the sandbox as a camelCase policy type, not the kebab-case request value. */
export function codexThreadMatches(mode: TaskPermissionMode, sandboxType: unknown, approvalPolicy: unknown): boolean {
  const requested = codexThreadPolicy(mode);
  return sandboxType === (requested.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite') && approvalPolicy === requested.approvalPolicy;
}

export function permissionModeLabel(mode: TaskPermissionMode): string {
  return mode.provider === 'claude' ? mode.mode : mode.mode.replace('/', ' · ');
}
