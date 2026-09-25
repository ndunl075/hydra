import type { ProviderInfo, ProviderDiagnostic } from './model';
import { runProbe } from './process';

export async function checkProvider(info: ProviderInfo, cwd: string, signal?: AbortSignal): Promise<ProviderDiagnostic> {
  const result: ProviderDiagnostic = { provider: info.provider, executable: info.executable, status: 'unavailable', checkedAt: new Date().toISOString(), advertised: [], probes: [] };
  if (!info.executable) { result.error = 'CLI not found. Install the official provider or set its executable path.'; return result; }
  for (const args of [['--version'], ['--help'], ...(info.provider === 'codex' ? [['app-server', '--help']] : [])]) {
    if (signal?.aborted) { result.status = 'error'; result.error = 'Provider check cancelled.'; return result; }
    const output = await runProbe(info.executable, args, cwd, { signal });
    result.probes.push(output);
    if (output.error || output.exitCode !== 0) {
      result.status = 'error'; result.error = output.error || `Provider ${args.join(' ')} failed (exit ${output.exitCode}). See diagnostics.`;
      return result;
    }
  }
  const versionText = result.probes[0]!.stdout.trim();
  const version = info.provider === 'claude' ? /^(\d+\.\d+\.\d+) \(Claude Code\)$/.exec(versionText) : /^codex-cli (\d+\.\d+\.\d+)(?:[-+][\w.-]+)?$/.exec(versionText);
  if (!version) { result.status = 'error'; result.error = 'Unrecognized provider version output.'; return result; }
  result.version = version[1]; result.status = 'checked';
  const help = result.probes[1]!.stdout;
  if (info.provider === 'claude') {
    if (help.includes('--output-format') && help.includes('stream-json')) result.advertised.push('Structured output');
    if (help.includes('--input-format') && help.includes('stream-json')) result.advertised.push('Structured input');
    if (help.includes('--resume')) result.advertised.push('Resume option');
    if (help.includes('--permission-prompt-tool')) result.advertised.push('Permission tool option');
  } else if (/\bapp-server\b/.test(help) && /\bapp-server\b/.test(result.probes[2]!.stdout)) {
    result.advertised.push('App Server command');
    if (result.probes[2]!.stdout.includes('generate-json-schema')) result.advertised.push('Version-specific schema generation');
  }
  return result;
}
