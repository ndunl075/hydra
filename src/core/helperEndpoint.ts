import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { toolAllowed, type HelperRole } from './helperTools';

/**
 * Hydra's local endpoint for helper actions (docs/Official_Extensions_Plan.md,
 * Phase 3). It listens on 127.0.0.1 only, on a random port. Each call carries a
 * token, and the token alone decides who is calling (a window's lead, or one
 * helper job) and which actions it may use.
 */
export interface HelperCaller { role: HelperRole; leadKey: string; jobId?: string }
export type HelperHandler = (caller: HelperCaller, tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
/**
 * Decides whether the process on the other end of a connection may act as this
 * window's lead. There is no lead token on disk to steal: a lead's bridge asks for
 * one once, and Hydra answers only after checking which process connected
 * (see src/core/leadVerification.ts). Returns a reason when refused.
 */
export type LeadVerifier = (socket: import('node:net').Socket) => Promise<{ ok: true } | { ok: false; reason: string }>;
export interface HelperCallResponse { ok: boolean; result?: unknown; error?: string }

const digest = (token: string) => createHash('sha256').update(token).digest('hex');

export class HelperEndpoint {
  private server?: http.Server;
  private readonly callers = new Map<string, HelperCaller>();
  private readonly calls = new Map<string, number[]>();
  private listening = 0;
  private sessionAttempts: number[] = [];
  constructor(private readonly handler: HelperHandler, private readonly options: { maxBodyBytes?: number; callsPerMinute?: number; leadKey?: string; verifyLead?: LeadVerifier } = {}) {}

  get port(): number { return this.listening; }

  async start(): Promise<number> {
    if (this.server) return this.listening;
    const server = http.createServer((request, response) => { void this.serve(request, response); });
    // Waits may legitimately last up to an hour; the caller's disconnect cancels them.
    server.requestTimeout = 0; server.timeout = 0; server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    this.server = server; this.listening = (server.address() as AddressInfo).port;
    return this.listening;
  }

  async close(): Promise<void> {
    const server = this.server; this.server = undefined; this.listening = 0; this.callers.clear();
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** A new random token for this caller. Only its hash is kept. */
  issue(caller: HelperCaller): string {
    const token = randomBytes(32).toString('base64url');
    this.callers.set(digest(token), { ...caller });
    return token;
  }
  revoke(token: string): void { this.callers.delete(digest(token)); this.calls.delete(digest(token)); }
  revokeJob(jobId: string): void { for (const [key, caller] of this.callers) if (caller.jobId === jobId) { this.callers.delete(key); this.calls.delete(key); } }

  private async serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: HelperCallResponse) => {
      if (response.writableEnded || response.destroyed) return;
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method !== 'POST' || (request.url !== '/hydra/v1/call' && request.url !== '/hydra/v1/lead-session')) return reply(404, { ok: false, error: 'Not found.' });
      // Only local, non-browser clients: the Host must be this exact loopback address,
      // and any Origin (a web page) is refused, which blocks DNS rebinding.
      if (request.headers.host !== `127.0.0.1:${this.listening}` || request.headers.origin !== undefined) return reply(403, { ok: false, error: 'Forbidden.' });
      if (request.url === '/hydra/v1/lead-session') {
        // A lead bridge asks for its token once. It gets one only if the connecting
        // process passes the window's lead check; the token then lives only in that
        // bridge's memory.
        const now = Date.now();
        this.sessionAttempts = this.sessionAttempts.filter(at => now - at < 60_000);
        if (this.sessionAttempts.length >= 20) return reply(429, { ok: false, error: 'Too many Hydra lead requests; slow down.' });
        this.sessionAttempts.push(now);
        if (!this.options.verifyLead || !this.options.leadKey) return reply(403, { ok: false, error: 'This Hydra window does not accept lead connections.' });
        const verdict = await this.options.verifyLead(request.socket);
        if (!verdict.ok) return reply(403, { ok: false, error: `Hydra refused this lead: ${verdict.reason}` });
        return reply(200, { ok: true, result: { token: this.issue({ role: 'lead', leadKey: this.options.leadKey }) } });
      }
      const auth = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.authorization || '');
      const key = auth ? digest(auth[1]!) : undefined;
      const caller = key ? this.callers.get(key) : undefined;
      if (!key || !caller) return reply(401, { ok: false, error: 'Unknown Hydra token.' });
      const window = 60_000, limit = this.options.callsPerMinute ?? 120, now = Date.now();
      const recent = (this.calls.get(key) || []).filter(at => now - at < window);
      if (recent.length >= limit) return reply(429, { ok: false, error: 'Too many Hydra calls; slow down.' });
      recent.push(now); this.calls.set(key, recent);
      const body = await readBody(request, this.options.maxBodyBytes ?? 256 * 1024);
      if (body === undefined) return reply(413, { ok: false, error: 'Request too large.' });
      let parsed: { tool?: unknown; arguments?: unknown };
      try { parsed = JSON.parse(body); } catch { return reply(400, { ok: false, error: 'Invalid JSON.' }); }
      if (typeof parsed.tool !== 'string') return reply(400, { ok: false, error: 'Missing tool.' });
      if (!toolAllowed(caller.role, parsed.tool)) return reply(403, { ok: false, error: `${parsed.tool} is not available to a Hydra ${caller.role}.` });
      const args = parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments) ? parsed.arguments as Record<string, unknown> : {};
      const controller = new AbortController();
      response.on('close', () => { if (!response.writableEnded) controller.abort(); });
      try { reply(200, { ok: true, result: await this.handler({ ...caller }, parsed.tool, args, controller.signal) }); }
      catch (error) { reply(200, { ok: false, error: error instanceof Error ? error.message : String(error) }); }
    } catch (error) {
      reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

function readBody(request: http.IncomingMessage, max: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0, done = false;
    request.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > max) { done = true; resolve(undefined); request.resume(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    request.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}

/** Client side, used by a lead bridge: ask the window for this bridge's lead token. */
export function requestLeadSession(port: number): Promise<HelperCallResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hydra/v1/lead-session', headers: { 'content-type': 'application/json', 'content-length': 2 } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HelperCallResponse); } catch { resolve({ ok: false, error: `Hydra answered ${response.statusCode}.` }); } });
    });
    request.on('error', reject);
    request.end('{}');
  });
}

/** Client side, used by the bridge: one call, no timeout of its own; aborting cancels it. */
export function callHelperEndpoint(port: number, token: string, tool: string, args: unknown, signal?: AbortSignal): Promise<HelperCallResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ tool, arguments: args ?? {} });
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/hydra/v1/call', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, signal }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(text) as HelperCallResponse); } catch { resolve({ ok: false, error: `Hydra answered ${response.statusCode}.` }); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
