import { callHelperEndpoint, requestLeadSession } from './helperEndpoint';
import { findWindowFor } from './helperDiscovery';
import { helperInstructions, jobReadyTool, laneGuidance, leadInstructions, toolsFor, type HelperRole } from './helperTools';

/**
 * The `hydra-mcp` bridge core: a stdio MCP server (newline-delimited JSON-RPC)
 * that Claude Code and Codex start. It lists Hydra's actions and forwards each
 * call to the Hydra window over the local endpoint.
 *
 * - A helper gets HYDRA_HELPER_PORT and HYDRA_HELPER_TOKEN from Hydra directly.
 * - A lead finds its window on each call through the discovery files under
 *   HYDRA_HELPERS_DIR, matched by the folder the CLI runs in. So a window opened
 *   after the chat started still works, and no window gives a clear error.
 */
export interface BridgeOptions { env: Record<string, string | undefined>; cwd: string; version: string }
type Message = { jsonrpc?: string; id?: string | number; method?: string; params?: Record<string, unknown> };

/**
 * A lead running in a Hydra lane: Hydra sets HYDRA_LANE_ID (12 hex), and the
 * lane's name and branch, in the lane's terminal. Anything malformed is ignored.
 */
export function laneFromEnv(env: Record<string, string | undefined>): { id: string; name?: string; branch?: string; planJob?: boolean } | undefined {
  const id = env.HYDRA_LANE_ID;
  if (!id || !/^[a-f0-9]{12}$/.test(id)) return undefined;
  const name = (env.HYDRA_LANE_NAME || '').replace(/[\u0000-\u001f\u007f"]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  const branch = env.HYDRA_LANE_BRANCH || '';
  return { id, ...(name ? { name } : {}), ...(new RegExp(`^lane/[a-z0-9-]{1,32}-${id}$`).test(branch) ? { branch } : {}), ...(env.HYDRA_LANE_PLAN_JOB === '1' ? { planJob: true } : {}) };
}

export function createBridge(options: BridgeOptions) {
  const role: HelperRole = options.env.HYDRA_HELPER_TOKEN ? 'helper' : 'lead';
  const lane = role === 'lead' ? laneFromEnv(options.env) : undefined;
  // hydra_job_ready is listed only in a lane that runs a plan job (docs/Plan_Lanes_Plan.md, decision 6).
  const tools = toolsFor(role).filter(tool => tool.name !== jobReadyTool || !!lane?.planJob);
  const inflight = new Map<string | number, AbortController>();
  const leadTokens = new Map<number, string>();
  const connection = async (): Promise<{ port: number; token: string } | string> => {
    if (role === 'helper') {
      const port = Number(options.env.HYDRA_HELPER_PORT);
      return Number.isInteger(port) && port > 0 ? { port, token: options.env.HYDRA_HELPER_TOKEN! } : 'This head was started without a Hydra port.';
    }
    // A lane's bridge looks in its own window's directory first (see laneLaunch).
    const root = (lane && options.env.HYDRA_LANE_HELPERS_DIR) || options.env.HYDRA_HELPERS_DIR;
    if (!root) return 'Hydra heads are not set up for this CLI. Connect Claude Code or Codex to Hydra from Hydra\'s onboarding or Settings.';
    const record = await findWindowFor(root, options.cwd);
    if (!record) return `Hydra isn't open for this folder (${options.cwd}). Open the folder in Hydra to use heads.`;
    // The lead token is asked for once per window and kept only in memory.
    const cached = leadTokens.get(record.port);
    if (cached) return { port: record.port, token: cached };
    const declared = options.env.HYDRA_LEAD_PROVIDER === 'claude' || options.env.HYDRA_LEAD_PROVIDER === 'codex' ? options.env.HYDRA_LEAD_PROVIDER : undefined;
    const session = await requestLeadSession(record.port, declared, lane?.id).catch(error => ({ ok: false, error: String(error) }) as { ok: false; error: string });
    const token = session.ok ? (session.result as { token?: unknown } | undefined)?.token : undefined;
    if (typeof token !== 'string') return session.error || 'Hydra did not accept this lead.';
    leadTokens.set(record.port, token);
    return { port: record.port, token };
  };
  const result = (id: Message['id'], value: unknown) => ({ jsonrpc: '2.0', id, result: value });
  const text = (value: unknown, isError = false) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) });

  async function handle(message: Message): Promise<object | undefined> {
    const { id, method, params = {} } = message;
    if (method === 'notifications/cancelled') { const target = params.requestId as string | number; inflight.get(target)?.abort(); return undefined; }
    if (id === undefined || !method) return undefined; // other notifications and stray responses
    if (method === 'initialize') {
      return result(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hydra', title: 'Hydra heads', version: options.version },
        instructions: role === 'lead' ? (lane ? `${leadInstructions}\n\n${laneGuidance(lane.name, lane.branch, !!lane.planJob)}` : leadInstructions) : helperInstructions,
      });
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools });
    if (method === 'tools/call') {
      const name = String(params.name || '');
      if (!tools.some(tool => tool.name === name)) return result(id, text(`Unknown Hydra action ${name}.`, true));
      const target = await connection();
      if (typeof target === 'string') return result(id, text(target, true));
      const controller = new AbortController(); inflight.set(id, controller);
      try {
        const response = await callHelperEndpoint(target.port, target.token, name, params.arguments ?? {}, controller.signal);
        return result(id, response.ok ? text(response.result ?? 'ok') : text(response.error || 'Hydra refused the call.', true));
      } catch (error) {
        if (controller.signal.aborted) return result(id, text('Cancelled.', true));
        return result(id, text(`Hydra is not reachable: ${error instanceof Error ? error.message : String(error)}. Is the Hydra window still open?`, true));
      } finally { inflight.delete(id); }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return { role, handle, abortAll: () => { for (const controller of inflight.values()) controller.abort(); } };
}

/** Wire the bridge to stdio. Each request is handled concurrently, since a wait may take minutes. */
export function runBridgeOnStdio(options: BridgeOptions, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): void {
  const bridge = createBridge(options);
  let buffer = '';
  input.setEncoding?.('utf8');
  input.on('data', (chunk: string) => {
    buffer += chunk; let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: Message;
      try { message = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      void bridge.handle(message).then(reply => { if (reply) output.write(JSON.stringify(reply) + '\n'); });
    }
  });
  input.on('end', () => { bridge.abortAll(); process.exitCode = 0; setTimeout(() => process.exit(0), 50).unref?.(); });
}
