import { execFile } from 'node:child_process';
import path from 'node:path';
import type { Socket } from 'node:net';
import type { LeadVerifier } from './helperEndpoint';

/**
 * Who may act as a window's lead (docs/Helpers.md, Security). There is no lead
 * token on disk: a lead's bridge asks for one once, and Hydra first asks the OS
 * which process opened that connection and walks its parents.
 *
 * - Refused if the chain passes through any process Hydra started for a helper
 *   or a helper's checks: a helper, or anything it started, can't act as the lead.
 * - Accepted only if the chain reaches this Hydra window (its extension host or
 *   main process). A process that detached itself to escape its helper has a
 *   broken chain and is refused.
 *
 * The OS reports the connection's owner, so a caller can't claim another identity.
 * PIDs can be reused, so an ancestor created after its child ends the chain.
 */
export interface ProcessLink { pid: number; ppid: number; created: number; name?: string }
export interface LeadRules { allowedAncestors: ReadonlySet<number>; deniedAncestors: ReadonlySet<number> }

export function evaluateLeadChain(chain: readonly ProcessLink[], rules: LeadRules): { ok: true } | { ok: false; reason: string } {
  if (!chain.length) return { ok: false, reason: 'the connecting process could not be identified.' };
  const trusted: ProcessLink[] = [chain[0]!];
  for (let index = 1; index < chain.length; index++) {
    const child = trusted[trusted.length - 1]!, parent = chain[index]!;
    if (parent.pid !== child.ppid || parent.created > child.created) break;
    trusted.push(parent);
  }
  if (trusted.some(link => rules.deniedAncestors.has(link.pid))) return { ok: false, reason: 'it runs inside a Hydra helper, and helpers cannot act as the lead.' };
  if (trusted.some(link => rules.allowedAncestors.has(link.pid))) return { ok: true };
  return { ok: false, reason: 'it was not started from this Hydra window (use the Claude Code or Codex extension, or a terminal inside Hydra).' };
}

/** The connecting process and its ancestors, from the OS (Windows). */
export function windowsConnectionChain(socket: Socket): Promise<ProcessLink[]> {
  const clientPort = Number(socket.remotePort), serverPort = Number(socket.localPort);
  if (!Number.isInteger(clientPort) || !Number.isInteger(serverPort)) return Promise.resolve([]);
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${clientPort} -RemotePort ${serverPort} -State Established -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "if (-not $c) { '[]'; exit }",
    '$procs = @{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }',
    '$chain = @(); $id = [int]$c.OwningProcess',
    'for ($i = 0; $i -lt 64 -and $procs.ContainsKey($id); $i++) { $p = $procs[$id]; $chain += [pscustomobject]@{ pid = $id; ppid = [int]$p.ParentProcessId; created = [int64]$p.CreationDate.ToFileTimeUtc(); name = $p.Name }; $id = [int]$p.ParentProcessId }',
    'ConvertTo-Json -Compress @($chain)',
  ].join('; ');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise(resolve => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        const parsed = JSON.parse(stdout.trim() || '[]') as ProcessLink[] | ProcessLink;
        resolve((Array.isArray(parsed) ? parsed : [parsed]).filter(link => Number.isInteger(link.pid) && Number.isInteger(link.ppid) && Number.isFinite(link.created)));
      } catch { resolve([]); }
    });
  });
}

/**
 * The lead check for this window. On Windows it uses the OS connection owner; on
 * other platforms Hydra has no such check yet and accepts, as before.
 */
export function createLeadVerifier(rules: () => LeadRules, chainFor: (socket: Socket) => Promise<ProcessLink[]> = windowsConnectionChain, platform = process.platform): LeadVerifier {
  return async socket => {
    if (platform !== 'win32') return { ok: true };
    return evaluateLeadChain(await chainFor(socket), rules());
  };
}
