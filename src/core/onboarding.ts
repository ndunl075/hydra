export const onboardingSteps = ['welcome', 'import', 'appearance', 'accounts'] as const;
export type OnboardingStep = typeof onboardingSteps[number];
export interface OnboardingState { version: 1; step: OnboardingStep; completed: boolean; skipped: OnboardingStep[] }
export function readOnboarding(value: unknown): OnboardingState {
  const state = value as { version?: unknown; step?: unknown; completed?: unknown; skipped?: unknown } | undefined;
  // 'project' was retired as its own step; earlier saves referencing it map onto
  // the new final step so already-completed onboarding is not lost.
  const migrateStep = (step: unknown): unknown => step === 'project' ? 'accounts' : step;
  const step = migrateStep(state?.step);
  const skipped = Array.isArray(state?.skipped) ? state.skipped.map(migrateStep).filter((s, i, all) => onboardingSteps.includes(s as OnboardingStep) && all.indexOf(s) === i) : undefined;
  if (state?.version !== 1 || !onboardingSteps.includes(step as OnboardingStep) || typeof state.completed !== 'boolean' || !skipped) {
    return { version: 1, step: 'welcome', completed: false, skipped: [] };
  }
  return { version: 1, step: step as OnboardingStep, completed: state.completed, skipped: skipped as OnboardingStep[] };
}
export function advanceOnboarding(state: OnboardingState, skip: boolean): OnboardingState {
  const index = onboardingSteps.indexOf(state.step);
  return { ...state, skipped: skip ? [...new Set([...state.skipped, state.step])] : state.skipped.filter(step => step !== state.step),
    step: onboardingSteps[Math.min(index + 1, onboardingSteps.length - 1)]!, completed: index === onboardingSteps.length - 1 };
}
export function shouldOpenOnboarding(input: { desktop: boolean; trusted: boolean; development: boolean; handoff: boolean; completed: boolean }): boolean {
  return input.desktop && input.trusted && !input.development && !input.handoff && !input.completed;
}
