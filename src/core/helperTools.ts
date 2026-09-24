/**
 * The actions Hydra adds to Claude Code and Codex (docs/Official_Extensions_Plan.md).
 * Shared by the stdio bridge (what the model sees) and the extension host (what it
 * accepts). A caller's role comes from its token, never from the call.
 */
export type HelperRole = 'lead' | 'helper';
export interface HelperToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const jobId = string('A helper job id returned by hydra_start_helper.', { pattern: '^[a-f0-9]{12}$' });

export const leadTools: readonly HelperToolDefinition[] = [
  {
    name: 'hydra_start_helper',
    description: 'Start a Hydra helper: a separate agent that works on one independent piece of this task in its own git worktree and branch, branched from this folder\'s current HEAD (commit first if the helper must see your changes). Use it only for work that can proceed in parallel without your context. Returns a job id immediately; call hydra_wait_for_helpers to get results. Merge a finished helper\'s branch yourself with git.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'brief', 'write_scope', 'idempotency_key'],
      properties: {
        title: string('A short name for the work, under 200 characters.'),
        brief: string('Everything the helper needs: goal, constraints, files, and how to know it is done. The helper has no other context.'),
        write_scope: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, description: 'Repository-relative paths the helper may change, e.g. ["src/parser/", "tests/parser.test.ts"]. Changes outside are refused.' },
        provider: string('Which agent runs the helper. Defaults to claude.', { enum: ['claude', 'codex'] }),
        model: string('Optional model for the helper.'),
        depends_on: { type: 'array', items: jobId, description: 'Job ids that must finish first.' },
        idempotency_key: string('A unique key for this request. Repeating a call with the same key returns the same job instead of starting another.'),
        limits: { type: 'object', additionalProperties: false, properties: { wall_clock_minutes: { type: 'number' }, max_turns: { type: 'number' }, max_budget_usd: { type: 'number' } }, description: 'Optional caps. Defaults: 30 minutes, 60 turns, 5 USD.' },
      },
    },
  },
  {
    name: 'hydra_wait_for_helpers',
    description: 'Wait until the given helpers finish (done, failed, cancelled) or ask a question (blocked), then return their results. Returns early with current states after max_wait_s. Safe to call again.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_ids'], properties: { job_ids: { type: 'array', items: jobId, minItems: 1, maxItems: 16 }, max_wait_s: { type: 'number', description: 'Longest wait in seconds, 1–3000. Default 1800.' } } },
  },
  { name: 'hydra_get_helper', description: 'Get one helper\'s state, summary, branch, commit, changed files and check results.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: jobId } } },
  { name: 'hydra_list_helpers', description: 'List this window\'s helpers and their states.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'hydra_reply_to_helper', description: 'Answer a helper that is blocked on a question. Hydra delivers the message and the helper continues.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id', 'message'], properties: { job_id: jobId, message: string('The answer, under 8000 characters.') } } },
  { name: 'hydra_cancel_helper', description: 'Stop a helper and mark it cancelled. Its branch is kept.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: jobId, reason: string('Why, for the record.') } } },
];

export const helperTools: readonly HelperToolDefinition[] = [
  { name: 'hydra_done', description: 'Report that your work is finished. Commit all your changes first. Hydra then checks the changes are inside your write scope and runs the project checks; if they fail you will be told what to fix.', inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: string('What you changed and why, and anything the lead must know. Under 8000 characters.') } } },
  { name: 'hydra_stuck', description: 'Report that you cannot continue without a decision or information from the lead. Ask one clear question. You will receive the answer as your next message.', inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: string('What is blocking you.'), question: string('The question for the lead.') } } },
  { name: 'hydra_progress', description: 'Optionally report a short progress note shown in Hydra\'s helper dashboard.', inputSchema: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: string('Under 500 characters.') } } },
];

export const toolsFor = (role: HelperRole): readonly HelperToolDefinition[] => role === 'lead' ? leadTools : helperTools;
export const toolAllowed = (role: HelperRole, name: string): boolean => toolsFor(role).some(tool => tool.name === name);

/** Guidance sent to the lead's agent when it connects (MCP `instructions`). */
export const leadInstructions = 'Hydra can run helper agents in parallel, each in its own git worktree. For independent pieces of a larger task, call hydra_start_helper with a complete brief and a narrow write_scope, then hydra_wait_for_helpers. When helpers finish, review and merge their branches yourself with git. Don\'t start helpers for small or tightly coupled work.';
export const helperInstructions = 'You are a Hydra helper working in your own git worktree. Stay inside your write scope, commit your work, then call hydra_done with a summary. If you cannot continue, call hydra_stuck with one clear question. Never stop without calling one of them.';
