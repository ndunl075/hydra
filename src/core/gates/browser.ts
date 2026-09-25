import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processLaunch, terminateProcessTree } from '../process';

/**
 * The headless browser behind the screenshots gate (docs/Gates_Plan.md): Edge on
 * Windows, otherwise Chrome or Chromium from the usual places, driven over the
 * DevTools protocol with Node's own WebSocket. Each session gets a temporary
 * profile folder, which is deleted when it closes, and closing always kills
 * the browser's whole process tree. The gate only sees ScreenshotBrowser, so
 * tests use a fake.
 */
export interface PageCapture {
  /** The main document's HTTP status, when it answered. */
  status?: number;
  /** Uncaught exceptions, and a page that failed to load. */
  errors: string[];
  /** What the page passed to console.error. */
  consoleErrors: string[];
  /** The body has no text and no images. */
  empty: boolean;
  png: Buffer;
  /** The captured height in CSS pixels: the full page, at most maxCaptureHeight. */
  height: number;
}
export interface BrowserSession {
  capture(url: string, width: number): Promise<PageCapture>;
  close(): Promise<void>;
}
export interface ScreenshotBrowser {
  /** The browser to use, or undefined when none is installed. */
  find(): Promise<string | undefined>;
  open(executable: string, options?: { spawned?: (pid: number) => void }): Promise<BrowserSession>;
}

export const maxCaptureHeight = 4000;
const commandTimeoutMs = 30_000;
const loadTimeoutMs = 30_000;
/** After the load event, a moment for scripts to render and for late errors to surface. */
const settleMs = 500;

/** Where each platform's browsers usually live, in the order Hydra tries them. */
export function browserCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    const roots = { programFiles: env.ProgramFiles || 'C:\\Program Files', programFilesX86: env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', local: env.LOCALAPPDATA };
    const under = (root: string | undefined, ...parts: string[]) => root ? [path.win32.join(root, ...parts)] : [];
    return [
      ...under(roots.programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...under(roots.programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...under(roots.local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ...under(roots.programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...under(roots.programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...under(roots.local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ...under(roots.local, 'Chromium', 'Application', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];
  const directories = [...(env.PATH || '').split(':').filter(Boolean), '/usr/bin', '/usr/local/bin', '/snap/bin'];
  return [...new Set(directories.flatMap(directory => names.map(name => path.posix.join(directory, name))))];
}

export async function findBrowser(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (file: string) => Promise<boolean> = fileExists): Promise<string | undefined> {
  for (const candidate of browserCandidates(platform, env)) if (await exists(candidate)) return candidate;
  return undefined;
}
const fileExists = (file: string) => access(file).then(() => true, () => false);

export const cdpBrowser: ScreenshotBrowser = { find: () => findBrowser(), open: (executable, options) => launchBrowser(executable, options?.spawned) };

type CdpListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void;

/** A minimal DevTools-protocol client over one WebSocket: commands with ids and time limits, and events. */
class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<CdpListener>();
  private closed = false;
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => this.receive(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8')));
    socket.addEventListener('close', () => this.fail(new Error('The browser closed its DevTools connection.')));
  }

  static connect(url: string): Promise<CdpConnection> {
    if (typeof WebSocket === 'undefined') return Promise.reject(new Error('this runtime has no WebSocket'));
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => { socket.close(); reject(new Error('The browser\'s DevTools connection did not open.')); }, commandTimeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(socket)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The browser\'s DevTools connection failed.')); }, { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = commandTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser\'s DevTools connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The browser didn't answer ${method} in ${Math.round(timeoutMs / 1000)} s.`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(listener: CdpListener): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }

  /** Resolves on the first matching event, or undefined after `timeoutMs`. */
  waitFor(method: string, sessionId: string, timeoutMs: number): { promise: Promise<Record<string, unknown> | undefined>; cancel: () => void } {
    let cancel = () => {};
    const promise = new Promise<Record<string, unknown> | undefined>(resolve => {
      const timer = setTimeout(() => { off(); resolve(undefined); }, timeoutMs);
      const off = this.on((event, params, session) => { if (event === method && session === sessionId) { clearTimeout(timer); off(); resolve(params); } });
      cancel = () => { clearTimeout(timer); off(); resolve(undefined); };
    });
    return { promise, cancel };
  }

  close(): void { if (!this.closed) { this.closed = true; try { this.socket.close(); } catch { /* already closing */ } this.fail(new Error('The browser\'s DevTools connection is closed.')); } }

  private receive(data: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try { message = JSON.parse(data); } catch { return; }
    if (typeof message.id === 'number') {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id); clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error.message || 'The browser refused a DevTools command.'));
      else waiting.resolve(message.result ?? {});
    } else if (typeof message.method === 'string') {
      for (const listener of [...this.listeners]) listener(message.method, message.params ?? {}, message.sessionId);
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const [id, waiting] of this.pending) { clearTimeout(waiting.timer); this.pending.delete(id); waiting.reject(error); }
  }
}

/** The browser writes its DevTools port and path to this file in its profile once it is listening. */
async function devToolsEndpoint(profile: string, exited: () => boolean, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('The browser exited as soon as it started.');
    const text = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const [port, socketPath] = text.split(/\r?\n/);
    if (port && /^\d+$/.test(port.trim()) && socketPath?.startsWith('/devtools/browser/')) return `ws://127.0.0.1:${port.trim()}${socketPath.trim()}`;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('The browser didn\'t open its DevTools port.');
}

/** Start a headless browser with a fresh temporary profile. On any failure it is already cleaned up. */
export async function launchBrowser(executable: string, spawned?: (pid: number) => void): Promise<BrowserSession> {
  const profile = await mkdtemp(path.join(tmpdir(), 'hydra-browser-'));
  const args = ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--mute-audio', '--hide-scrollbars', '--disable-gpu', 'about:blank'];
  const launch = processLaunch(executable, args);
  const child = spawn(launch.executable, launch.args, { windowsHide: true, stdio: 'ignore', detached: process.platform !== 'win32' });
  if (child.pid) spawned?.(child.pid);
  let exited = false;
  const gone = new Promise<void>(resolve => { child.once('exit', () => { exited = true; resolve(); }); child.once('error', () => { exited = true; resolve(); }); });
  let cdp: CdpConnection | undefined, closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    // Ask politely, then make sure: the tree kill is what guarantees no browser is left running.
    if (cdp && !exited) await cdp.send('Browser.close', {}, undefined, 2000).catch(() => undefined);
    cdp?.close();
    if (!exited && child.pid) await terminateProcessTree(child.pid).catch(() => { child.kill(); });
    await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 5000))]);
    // Windows can hold the profile's files for a moment after the browser exits.
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }).catch(() => undefined);
  })();
  try {
    cdp = await CdpConnection.connect(await devToolsEndpoint(profile, () => exited));
  } catch (error) { await close(); throw error; }
  const connection = cdp;
  return { capture: (url, width) => capturePage(connection, url, width), close };
}

/** Measured in the page: how tall it is, and whether the body has any text or images. */
const measure = `(() => {
  const body = document.body;
  if (!body) return { height: 0, text: 0, media: 0 };
  const media = [...document.querySelectorAll('img, svg, canvas, video, picture, iframe, object, embed')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; }).length;
  return { height: Math.max(document.documentElement.scrollHeight, body.scrollHeight), text: (body.innerText || '').trim().length, media };
})()`;

/** One width: a new tab, navigate, wait for load, measure, and capture the full page up to the height cap. */
async function capturePage(cdp: CdpConnection, url: string, width: number): Promise<PageCapture> {
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  try {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const call = <T = any>(method: string, params: Record<string, unknown> = {}) => cdp.send<T>(method, params, sessionId);
    const errors: string[] = [], consoleErrors: string[] = [], documents = new Map<string, number>();
    const off = cdp.on((method, params, session) => {
      if (session !== sessionId) return;
      if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        errors.push(String(details?.exception?.description ?? details?.text ?? 'Uncaught error').split('\n')[0]!);
      } else if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
        const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? [];
        consoleErrors.push(args.map(arg => arg.value !== undefined ? String(arg.value) : arg.description ?? '').join(' ').trim() || 'console.error()');
      } else if (method === 'Network.responseReceived' && params.type === 'Document') {
        documents.set(String(params.requestId), Number((params.response as { status?: number } | undefined)?.status));
      }
    });
    try {
      await call('Page.enable'); await call('Runtime.enable'); await call('Network.enable');
      await call('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
      const loaded = cdp.waitFor('Page.loadEventFired', sessionId, loadTimeoutMs);
      const navigation = await call<{ loaderId?: string; errorText?: string }>('Page.navigate', { url });
      if (navigation.errorText) { loaded.cancel(); errors.push(`The page didn't load (${navigation.errorText}).`); }
      else if (!await loaded.promise) errors.push(`The page didn't finish loading in ${loadTimeoutMs / 1000} s.`);
      await new Promise(resolve => setTimeout(resolve, settleMs));
      const status = navigation.loaderId ? documents.get(navigation.loaderId) : undefined;
      const metrics = (await call<{ result?: { value?: { height?: number; text?: number; media?: number } } }>('Runtime.evaluate', { expression: measure, returnByValue: true })).result?.value ?? {};
      const height = Math.max(1, Math.min(maxCaptureHeight, Math.ceil(metrics.height ?? 0) || 900));
      const shot = await call<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
      return {
        ...(Number.isFinite(status) ? { status } : {}), errors, consoleErrors,
        empty: !metrics.text && !metrics.media, png: Buffer.from(shot.data, 'base64'), height,
      };
    } finally { off(); }
  } finally {
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}
