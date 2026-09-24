import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { processLaunch } from './process';

/**
 * claude-mem (github.com/thedotmack/claude-mem, Apache-2.0) comes with Hydra's
 * Claude Code connection: connecting Claude also sets it up. Hydra redistributes
 * nothing. It installs Bun from Bun's official release into ~/.bun/bin (where
 * claude-mem's hooks look for it, like Bun's own installer), then installs the
 * plugin through Claude's own `claude plugin` commands.
 */
export const claudeMemPlugin = 'claude-mem@thedotmack';
export const claudeMemMarketplace = 'thedotmack/claude-mem';
export interface ClaudeMemStatus { plugin: boolean; bun?: string; /** Its runtime dependencies are installed (claude-mem's own Setup step, which needs Bun). */ dependencies: boolean }

const exists = async (file: string) => { try { await access(file); return true; } catch { return false; } };
const bunHome = () => path.join(homedir(), '.bun', 'bin');
const bunExe = () => path.join(bunHome(), process.platform === 'win32' ? 'bun.exe' : 'bun');

function run(executable: string, args: string[], timeout = 120_000): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const launch = processLaunch(executable, args);
    execFile(launch.executable, launch.args, { windowsHide: true, timeout, env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0;
      resolve({ code, output: `${stdout}${stderr}` });
    });
  });
}

/** Bun on PATH, or where the official installer puts it. */
export async function findBun(): Promise<string | undefined> {
  if (await exists(bunExe())) return bunExe();
  const found = await run(process.platform === 'win32' ? 'where' : 'which', ['bun'], 10_000).catch(() => ({ code: 1, output: '' }));
  const first = found.code === 0 ? found.output.split(/\r?\n/).map(line => line.trim()).find(line => /bun(\.exe)?$/i.test(line)) : undefined;
  return first || undefined;
}

/** Every claude-mem copy Claude may run: each cached version and the marketplace checkout. */
async function claudeMemRoots(configDir: string): Promise<string[]> {
  const cache = path.join(configDir, 'plugins', 'cache', 'thedotmack', 'claude-mem');
  const versions = await readdir(cache).catch(() => [] as string[]);
  const roots = versions.map(version => path.join(cache, version));
  roots.push(path.join(configDir, 'plugins', 'marketplaces', 'thedotmack', 'plugin'));
  const present: string[] = [];
  for (const root of roots) if (await exists(path.join(root, 'package.json'))) present.push(root);
  return present;
}

export async function claudeMemStatus(configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')): Promise<ClaudeMemStatus> {
  let plugin = false;
  try {
    const installed = JSON.parse(await readFile(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8')) as { plugins?: Record<string, unknown> } & Record<string, unknown>;
    plugin = Object.keys(installed.plugins ?? installed).includes(claudeMemPlugin);
  } catch { /* not installed */ }
  const roots = await claudeMemRoots(configDir);
  let dependencies = roots.length > 0;
  for (const root of roots) if (!await exists(path.join(root, 'node_modules'))) dependencies = false;
  return { plugin, bun: await findBun(), dependencies };
}

/** Install Bun for this user from Bun's official release (Windows x64). */
export async function installBun(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (process.platform !== 'win32') throw new Error('Install Bun from https://bun.sh, then connect again.');
  const work = path.join(tmpdir(), `hydra-bun-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    for (const asset of ['bun-windows-x64.zip', 'bun-windows-x64-baseline.zip']) {
      const response = await fetchImpl(`https://github.com/oven-sh/bun/releases/latest/download/${asset}`);
      if (!response.ok) throw new Error(`Downloading Bun failed (${response.status}).`);
      const zip = path.join(work, asset);
      await writeFile(zip, Buffer.from(await response.arrayBuffer()));
      const out = path.join(work, asset.replace('.zip', ''));
      const expanded = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${out.replace(/'/g, "''")}' -Force`]);
      if (expanded.code !== 0) throw new Error(`Unpacking Bun failed: ${expanded.output.trim().slice(0, 200)}`);
      const candidate = path.join(out, asset.replace('.zip', ''), 'bun.exe');
      // The standard build needs AVX2; older CPUs get the baseline build.
      if ((await run(candidate, ['--version'], 30_000)).code !== 0) continue;
      await mkdir(bunHome(), { recursive: true });
      await rm(bunExe(), { force: true });
      await rename(candidate, bunExe());
      return bunExe();
    }
    throw new Error('Neither Bun build runs on this computer.');
  } finally { await rm(work, { recursive: true, force: true }).catch(() => undefined); }
}

/**
 * Set up claude-mem: Bun if missing, the plugin if missing (else brought up to
 * date, since an installed copy older than the marketplace makes claude-mem stop
 * its own worker), then claude-mem's dependencies in every copy that lacks them.
 * That last step is what claude-mem's Setup hook does; without Bun it never ran.
 */
export async function setupClaudeMem(claude: string, fetchImpl: typeof fetch = fetch, configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')): Promise<{ status: ClaudeMemStatus; installed: string[] }> {
  const installed: string[] = [];
  let status = await claudeMemStatus(configDir);
  let bun = status.bun;
  if (!bun) { bun = await installBun(fetchImpl); installed.push('Bun'); }
  if (!status.plugin) {
    await run(claude, ['plugin', 'marketplace', 'add', claudeMemMarketplace]);
    const added = await run(claude, ['plugin', 'install', claudeMemPlugin], 300_000);
    if (added.code !== 0 && !/already installed/i.test(added.output)) throw new Error(`Claude Code could not install claude-mem: ${added.output.trim().slice(0, 300)}`);
    installed.push('claude-mem');
  } else {
    const updated = await run(claude, ['plugin', 'update', claudeMemPlugin], 300_000);
    if (/updated from/i.test(updated.output)) installed.push('a claude-mem update');
  }
  for (const root of await claudeMemRoots(configDir)) {
    if (await exists(path.join(root, 'node_modules'))) continue;
    const deps = await run(bun, ['install', '--production', '--cwd', root], 600_000);
    if (deps.code !== 0) throw new Error(`Installing claude-mem's dependencies failed: ${deps.output.trim().slice(-300)}`);
    if (!installed.includes('its dependencies')) installed.push('its dependencies');
  }
  status = await claudeMemStatus(configDir);
  return { status, installed };
}
