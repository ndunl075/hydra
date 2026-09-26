/**
 * The actions Hydra adds to Claude Code and Codex (docs/Official_Extensions_Plan.md).
 * Shared by the stdio bridge (what the model sees) and the extension host (what it
 * accepts). A caller's role comes from its token, never from the call.
 */
export type HelperRole = 'lead' | 'helper';
/** The one lead action only a plan lane's agent sees (docs/Plan_Lanes_Plan.md, decision 6). */
export const jobReadyTool = 'hydra_job_ready';
export interface HelperToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }

const string = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const jobId = string('A head job id returned by hydra_start_head.', { pattern: '^[a-f0-9]{12}$' });

export const leadTools: readonly HelperToolDefinition[] = [
  {
    name: 'hydra_start_head',
    description: 'Start a Hydra head: a separate agent that works on one independent piece of this task in its own git worktree and branch, branched from this folder\'s current HEAD (commit first if the head must see your changes); a head with depends_on starts from their results instead. Use it on your own initiative whenever a task splits into independent pieces with separate files; start several at once for parallel work. Returns a job id immediately; call hydra_wait_for_heads to get results. Merge a finished head\'s branch yourself with git.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['title', 'brief', 'write_scope', 'idempotency_key'],
      properties: {
        title: string('A short name for the work, under 200 characters.'),
        brief: string('Everything the head needs: goal, constraints, files, and how to know it is done. The head has no other context.'),
        write_scope: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 32, description: 'Repository-relative paths the head may change, e.g. ["src/parser/", "tests/parser.test.ts"]. Changes outside are refused.' },
        provider: string('Which agent runs the head. Defaults to claude.', { enum: ['claude', 'codex'] }),
        model: string('Optional model for the head.'),
        depends_on: { type: 'array', items: jobId, description: 'Job ids that must finish first. The head then starts from their result commits (merged, if several) and is told what they did.' },
        idempotency_key: string('A unique key for this request. Repeating a call with the same key returns the same job instead of starting another.'),
        lead_label: string('Optional short name for this chat, under 60 characters, shown to the user on Hydra\'s Agents canvas (e.g. "Checkout refactor").'),
        limits: { type: 'object', additionalProperties: false, properties: { wall_clock_minutes: { type: 'number' }, max_turns: { type: 'number' }, max_budget_usd: { type: 'number' } }, description: 'Optional caps. Defaults come from Hydra Settings → Heads.' },
      },
    },
  },
  {
    name: 'hydra_wait_for_heads',
    description: 'Wait until the given heads finish (done, failed, cancelled) or ask a question (blocked), then return their results. Returns early with current states after max_wait_s. Safe to call again.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['job_ids'], properties: { job_ids: { type: 'array', items: jobId, minItems: 1, maxItems: 16 }, max_wait_s: { type: 'number', description: 'Longest wait in seconds, 1–3000. Default 1800.' } } },
  },
  { name: 'hydra_get_head', description: 'Get one head\'s state, summary, branch, base commit, commit, changed files and gate results (commands, review findings, screenshots).', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: jobId } } },
  { name: 'hydra_list_heads', description: 'List this window\'s heads and their states.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'hydra_reply_to_head', description: 'Answer a head that is blocked on a question. Hydra delivers the message and the head continues.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id', 'message'], properties: { job_id: jobId, message: string('The answer, under 8000 characters.') } } },
  { name: 'hydra_cancel_head', description: 'Stop a head and mark it cancelled. Its branch is kept.', inputSchema: { type: 'object', additionalProperties: false, required: ['job_id'], properties: { job_id: jobId, reason: string('Why, for the record.') } } },
  {
    name: 'hydra_lanes',
    description: 'List the Hydra lanes open in this window. A lane is a Claude Code or Codex terminal the user drives, in its own git worktree and branch. For each lane: its goal, branch and state, the files it is changing, the lanes it would conflict with (and in which files), files that would conflict with its target branch, how many commits it is behind, its running heads, and the plan job it runs, if any. `you` is your own lane, if you are in one. Checks fresh before answering. Call it before you start and before large changes, and avoid editing files other lanes are changing.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  // ---- Packs (docs/Packs_Plan.md, decision 6). Never listed to the model: a lead's bridge asks for the roles itself, when it starts. ----
  {
    name: 'hydra_active_roles',
    description: 'The roles of the packs active in this project, for hydra_start_head\'s role.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  // ---- Plan lanes (docs/Plan_Lanes_Plan.md, decision 6). Listed only in a lane that runs a plan job (see the bridge). ----
  {
    name: jobReadyTool,
    description: 'Only in a Hydra lane that runs a job of a Hydra plan: tell the user the job is ready to be marked done. Commit your work first. Hydra shows the user a "Mark job done" prompt; it never marks the job itself, and the user may merge the lane instead. The jobs that depend on this one start from your last commit once the user marks it done.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { note: string('Optional: what the jobs that depend on this one should know, under 2000 characters. It is offered to the user as the note.') } },
  },
];

export const helperTools: readonly HelperToolDefinition[] = [
  { name: 'hydra_done', description: 'Report that your work is finished. Hydra commits any uncommitted changes for you, then checks the changes are inside your write scope and runs the project\'s gates (its checks, and possibly a review by another agent and screenshots); if they fail you will be told what to fix.', inputSchema: { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: string('What you changed and why, and anything the lead must know. Under 8000 characters.') } } },
  { name: 'hydra_stuck', description: 'Report that you cannot continue without a decision or information from the lead. Ask one clear question. You will receive the answer as your next message.', inputSchema: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: string('What is blocking you.'), question: string('The question for the lead.') } } },
  { name: 'hydra_progress', description: 'Optionally report a short progress note shown in Hydra\'s head dashboard.', inputSchema: { type: 'object', additionalProperties: false, required: ['note'], properties: { note: string('Under 500 characters.') } } },
];

export const toolsFor = (role: HelperRole): readonly HelperToolDefinition[] => role === 'lead' ? leadTools : helperTools;

// ---- Packs (docs/Packs_Plan.md, decision 6: leads learn the active roles from their instructions and hydra_start_head's `role`) ----

/** The lead action a bridge asks for the active roles with. The model never sees it. */
export const activeRolesTool = 'hydra_active_roles';
/** A role as a lead hears of it. `name` is what it passes: "builder", or "coding/builder" when two active packs have a builder. */
export interface LeadRole { name: string; title: string; packTitle: string; description: string; provider: 'claude' | 'codex' }
const roleLine = (role: LeadRole) => `${role.name}: ${role.title} (${role.packTitle} pack, ${role.provider === 'codex' ? 'Codex' : 'Claude'}). ${role.description.length > 200 ? `${role.description.slice(0, 199)}…` : role.description}`;
/** The paragraph a lead's instructions add when roles are active: one line per role. */
export function rolesGuidance(roles: readonly LeadRole[]): string | undefined {
  if (!roles.length) return undefined;
  return ['Roles from this project\'s packs: pass one as `role` to hydra_start_head when a piece of work fits it. The head then works as that role says and, unless you give `provider`, on its agent.', ...roles.map(role => `- ${roleLine(role)}`)].join('\n');
}
/**
 * The lead's tools as a bridge lists them: hydra_start_head gains `role`, an enum of the
 * active roles' names with one line on each, only when there are any; the roles lookup is
 * never listed.
 */
export function leadToolsWithRoles(roles: readonly LeadRole[]): HelperToolDefinition[] {
  return leadTools.filter(tool => tool.name !== activeRolesTool).map(tool => {
    if (tool.name !== 'hydra_start_head' || !roles.length) return tool;
    const schema = tool.inputSchema as { properties: Record<string, unknown> };
    return {
      ...tool,
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...schema.properties,
          provider: string('Which agent runs the head. Defaults to its role\'s agent, else claude.', { enum: ['claude', 'codex'] }),
          role: string(`Optional: a role from this project's packs. The head works as it says. ${roles.map(roleLine).join(' ')}`, { enum: roles.map(role => role.name) }),
        },
      },
    };
  });
}
export const toolAllowed = (role: HelperRole, name: string): boolean => toolsFor(role).some(tool => tool.name === name);

/** Guidance sent to the lead's agent when it connects (MCP `instructions`). */
export const leadInstructions = [
  'You are running inside Hydra, which gives you Hydra heads: parallel agents you command, each working in its own git worktree and branch. Delegating to heads is your call, made silently: the user expects it without being asked, and Hydra shows the heads on its map.',
  'Before starting any task that changes code, decide whether it splits into pieces that touch separate files and don\'t need each other\'s results, for example a feature and its tests, frontend and backend, several unrelated fixes, or the same change across separate modules. If it has two or more such pieces worth more than a few minutes each, start one head per piece with hydra_start_head: a complete brief (the head has no other context) and a narrow write_scope. Commit first if heads must see uncommitted changes. Do the remaining coupled part yourself while they run, then call hydra_wait_for_heads, review each branch, and merge it with git. Do this behind the scenes: do not ask the user whether to use heads, and do not mention heads or narrate the delegation unless the user asks; report only the combined result, as if you had done the work yourself.',
  'Work alone when the task is small, is one tightly coupled change, or is only a question or investigation.',
].join('\n\n');
const laneAdvice = 'Call hydra_lanes before you start and before large changes; avoid editing files other lanes are changing, and tell the user if you must.';
/**
 * Added to the lead instructions when the bridge runs in a Hydra lane
 * (HYDRA_LANE_ID set); the lane's name and branch come from its environment.
 * A lane that runs a plan job (HYDRA_LANE_PLAN_JOB) also hears how its job ends.
 */
export function laneGuidance(name?: string, branch?: string, planJob = false): string {
  return `${name && branch ? `You are in Hydra lane "${name}" on branch ${branch}.` : 'You are in a Hydra lane.'} ${laneAdvice}${planJob ? ` ${planJobAdvice}` : ''}`;
}
/** A plan lane's part of the lane guidance (docs/Plan_Lanes_Plan.md, decision 6). */
export const planJobAdvice = 'This lane runs a job of a Hydra plan; its full brief is in .hydra-job/brief.md (never committed). When the work is ready, commit it and call hydra_job_ready: the user then marks the job done, or merges the lane. Never mark the job done yourself.';
/**
 * The same guidance for agents that don't read MCP instructions (Codex's AGENTS.md).
 * A lane's name isn't known there, so its branch prefix identifies it.
 */
export const leadGuidanceMarkdown = `## Hydra heads\n\nOnly when the Hydra tools (hydra_start_head) are available to you; a Hydra head itself ignores this section.\n\n${leadInstructions}\n\nWhen you work in a Hydra lane (your git branch starts with \`lane/\`): ${laneAdvice}\n`;
export const helperInstructions = 'You are a Hydra head working in your own git worktree. Stay inside your write scope, then call hydra_done with a summary (Hydra commits your changes). If you cannot continue, call hydra_stuck with one clear question. Never stop without calling one of them.';
