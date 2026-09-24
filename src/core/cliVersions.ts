/**
 * Which provider CLI versions Hydra runs (docs/Official_Extensions_Plan.md,
 * decision 5). Instead of one exact version, Hydra accepts the tested patch line
 * from the tested release up: Claude 2.1.x from 2.1.270, Codex 0.154.x from
 * 0.154.0. Each new binary also gets a one-time real self-check before use.
 */
export type CliProvider = 'claude' | 'codex';
interface Range { major: number; minor: number; minPatch: number }
export const supportedCliRanges: Readonly<Record<CliProvider, Range>> = {
  claude: { major: 2, minor: 1, minPatch: 270 },
  codex: { major: 0, minor: 154, minPatch: 0 },
};
export const supportedCliDescription = (provider: CliProvider): string => {
  const range = supportedCliRanges[provider];
  return `${provider === 'claude' ? 'Claude Code' : 'Codex'} ${range.major}.${range.minor}.x from ${range.major}.${range.minor}.${range.minPatch}`;
};

/** The first x.y.z in a version string such as "2.1.281 (Claude Code)" or "codex-cli 0.154.3". Pre-release tags make it unsupported. */
export function parseCliVersion(value: unknown): { major: number; minor: number; patch: number; prerelease: boolean } | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(value);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), prerelease: !!match[4] };
}

export function supportedCliVersion(provider: CliProvider, value: unknown): boolean {
  const version = parseCliVersion(value), range = supportedCliRanges[provider];
  return !!version && !version.prerelease && version.major === range.major && version.minor === range.minor && version.patch >= range.minPatch;
}

/** The supported x.y.z inside a string (a user agent, a version line), or undefined. */
export function supportedCliVersionIn(provider: CliProvider, value: unknown): string | undefined {
  const version = parseCliVersion(value);
  return version && supportedCliVersion(provider, value) ? `${version.major}.${version.minor}.${version.patch}` : undefined;
}
