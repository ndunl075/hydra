/**
 * Hydra's one-time "don't ask again" style dismissals live in globalState.
 * Today that's only the first-launch sidebar collapse (extension.ts
 * collapseSidebarOnce); nothing else stores a dismissed-prompt flag yet.
 * Listed here, pure, so General's "Reset don't ask again dialogs" row and
 * this file's test stay in sync as more get added.
 */
export const dismissedPromptKeys = ['hydra.firstRunLayout.v1'] as const;

export interface GlobalStateLike { update(key: string, value: unknown): Thenable<void> }

export function clearDismissedPrompts(globalState: GlobalStateLike): Thenable<void[]> {
  return Promise.all(dismissedPromptKeys.map(key => globalState.update(key, undefined)));
}
