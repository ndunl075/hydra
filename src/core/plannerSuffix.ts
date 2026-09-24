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

export const plannerMarkerPrefix = 'HYDRA_DELEGATION_V1:';
/**
 * The reply as shown in the conversation: without the machine-readable planner
 * receipt line Claude appends, and without a partial one still streaming in.
 * The recorded output keeps the line; ingestion reads it from there.
 */
export function withoutPlannerMarker(text: string): string {
  const lines = text.split('\n');
  const kept = lines.filter(line => !line.startsWith(plannerMarkerPrefix));
  const last = kept.at(-1);
  if (last && kept.length === lines.length && plannerMarkerPrefix.startsWith(last)) kept.pop();
  return kept.join('\n').trimEnd();
}
