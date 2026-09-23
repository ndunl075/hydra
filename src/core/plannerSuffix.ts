// Pure string helpers shared by the extension host and the webview, which
// cannot bundle the node-only planner ingestion module.
export const plannerSuffixStart = '\n\nHydra planning receipt: ';
/**
 * What the user typed, without the planning suffix Hydra appended for the
 * provider. The recorded turn keeps the full prompt as evidence of exactly what
 * the provider was told; only the conversation view shows it without the suffix.
 */
export function withoutPlannerSuffix(prompt: string): string {
  const index = prompt.indexOf(plannerSuffixStart);
  return index < 0 ? prompt : prompt.slice(0, index);
}
