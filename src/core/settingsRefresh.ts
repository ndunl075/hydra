/**
 * Hydra settings that only change a delegation preference. Those preferences are
 * read fresh wherever they are used and touch no provider, model catalog or
 * repository state, so changing one only needs the panel republished.
 */
export const preferenceOnlySettings: ReadonlySet<string> = new Set(['hydra.delegationMode', 'hydra.maxDelegatedChildren']);

/**
 * The contributed settings whose change must reset provider state and refresh.
 * Built from the manifest rather than a fixed list, so a setting added later
 * takes the full path by default; with no readable manifest, everything does.
 */
export function settingsRequiringRefresh(contributed: readonly string[]): string[] {
  return contributed.length ? contributed.filter(key => !preferenceOnlySettings.has(key)) : ['hydra'];
}
