/**
 * The actions Hydra adds to Claude Code and Codex (docs/Official_Extensions_Plan.md).
 * Shared by the stdio bridge (what the model sees) and the extension host (what it
 * accepts). A caller's role comes from its token, never from the call.
 */
export type HelperRole = 'lead' | 'helper';
export interface HelperToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const jobId = string('A head job id returned by hydra_start_head.', { pattern: '^[a-f0-9]{12}$' });

export const leadTools: readonly HelperToolDefinition[] = [
  {
    name: 'hydra_start_head',
    description: 'Start a Hydra head: a separate agent that works on one independent piece of this task in its own git worktree and branch, branched from this folder\'s current HEAD (commit first if the head must see your changes). Use it on your own initiative whenever a task splits into independent pieces with separate files; start several at once for parallel work. Returns a job id immediately; call hydra_wait_for_heads to get results. Merge a finished head\'s branch yourself with git.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'brief', 'write_scope', 'idempotency_key'],
      properties: {
        title: string('A short name for the work, under 200 characters.'),
        brief: string('Everything the head needs: goal, constraints, files, and how to know it is done. The head has no other context.'),
        write_scope: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, description: 'Repository-relative paths the head may change, e.g. ["src/parser/", "tests/parser.test.ts"]. Changes outside are refused.' },
        provider: string('Which agent runs the head. Defaults to claude.', { enum: ['claude', 'codex'] }),
        model: string('Optional model for the head.'),
        depends_on: { type: 'array', items: jobId, description: 'Job ids that must finish first.' },
        idempotency_key: string('A unique key for this request. Repeating a call with the same key returns the same job instead of starting another.'),
        limits: { type: 'object', additionalProperties: false, properties: { wall_clock_minutes: { type: 'number' }, max_turns: { type: 'number' }, max_budget_usd: { type: 'number' } }, description: 'Optional caps. Defaults: 30 minutes, 60 turns, 5 USD.' },
      },
    },
  },
  {
    name: 'hydra_wait_for_heads',
    description: 'Wait until the given heads finish (done, failed, cancelled) or ask a question (blocked), then return their results. Returns early with current states after max_wait_s. Safe to call again.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_ids'], properties: { job_ids: { type: 'array', items: jobId, minItems: 1, maxItems: 16 }, max_wait_s: { type: 'number', description: 'Longest wait in seconds, 1–3000. Default 1800.' } } },
  },
  { name: 'hydra_get_head', description: 'Get one head\'s state, summary, branch, commit, changed files and check results.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: jobId } } },
  { name: 'hydra_list_heads', description: 'List this window\'s heads and their states.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'hydra_reply_to_head', description: 'Answer a head that is blocked on a question. Hydra delivers the message and the head continues.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id', 'message'], properties: { job_id: jobId, message: string('The answer, under 8000 characters.') } } },
  { name: 'hydra_cancel_head', description: 'Stop a head and mark it cancelled. Its branch is kept.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: jobId, reason: string('Why, for the record.') } } },
];

export const helperTools: readonly HelperToolDefinition[] = [
  { name: 'hydra_done', description: 'Report that your work is finished. Hydra commits any uncommitted changes for you, then checks the changes are inside your write scope and runs the project checks; if they fail you will be told what to fix.', inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: string('What you changed and why, and anything the lead must know. Under 8000 characters.') } } },
  { name: 'hydra_stuck', description: 'Report that you cannot continue without a decision or information from the lead. Ask one clear question. You will receive the answer as your next message.', inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: string('What is blocking you.'), question: string('The question for the lead.') } } },
  { name: 'hydra_progress', description: 'Optionally report a short progress note shown in Hydra\'s head dashboard.', inputSchema: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: string('Under 500 characters.') } } },
];

export const toolsFor = (role: HelperRole): readonly HelperToolDefinition[] => role === 'lead' ? leadTools : helperTools;
export const toolAllowed = (role: HelperRole, name: string): boolean => toolsFor(role).some(tool => tool.name === name);

/** Guidance sent to the lead's agent when it connects (MCP `instructions`). */
export const leadInstructions = [
  'You are running inside Hydra, which gives you Hydra heads: parallel agents you command, each working in its own git worktree and branch. Delegating to heads is your call, made silently: the user expects it without being asked, and Hydra shows the heads on its map.',
  'Before starting any task that changes code, decide whether it splits into pieces that touch separate files and don\'t need each other\'s results, for example a feature and its tests, frontend and backend, several unrelated fixes, or the same change across separate modules. If it has two or more such pieces worth more than a few minutes each, start one head per piece with hydra_start_head: a complete brief (the head has no other context) and a narrow write_scope. Commit first if heads must see uncommitted changes. Do the remaining coupled part yourself while they run, then call hydra_wait_for_heads, review each branch, and merge it with git. Do this behind the scenes: do not ask the user whether to use heads, and do not mention heads or narrate the delegation unless the user asks; report only the combined result, as if you had done the work yourself.',
  'Work alone when the task is small, is one tightly coupled change, or is only a question or investigation.',
].join('\n\n');
/** The same guidance for agents that don't read MCP instructions (Codex's AGENTS.md). */
export const leadGuidanceMarkdown = `## Hydra heads\n\nOnly when the Hydra tools (hydra_start_head) are available to you; a Hydra head itself ignores this section.\n\n${leadInstructions}\n`;
export const helperInstructions = 'You are a Hydra head working in your own git worktree. Stay inside your write scope, then call hydra_done with a summary (Hydra commits your changes). If you cannot continue, call hydra_stuck with one clear question. Never stop without calling one of them.';
