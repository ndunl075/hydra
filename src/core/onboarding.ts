export const onboardingSteps = ['welcome', 'import', 'appearance', 'accounts', 'project'] as const;
export type OnboardingStep = typeof onboardingSteps[number];
export interface OnboardingState { version: 1; step: OnboardingStep; completed: boolean; skipped: OnboardingStep[] }
export function readOnboarding(value: unknown): OnboardingState {
  const state = value as Partial<OnboardingState> | undefined;
  if (state?.version !== 1 || !onboardingSteps.includes(state.step as OnboardingStep) || typeof state.completed !== 'boolean' || !Array.isArray(state.skipped) || state.skipped.some(step => !onboardingSteps.includes(step))) {
    return { version: 1, step: 'welcome', completed: false, skipped: [] };
  }
  return { version: 1, step: state.step!, completed: state.completed, skipped: [...new Set(state.skipped)] };
}
export function advanceOnboarding(state: OnboardingState, skip: boolean): OnboardingState {
  const index = onboardingSteps.indexOf(state.step);
  return { ...state, skipped: skip ? [...new Set([...state.skipped, state.step])] : state.skipped.filter(step => step !== state.step),
    step: onboardingSteps[Math.min(index + 1, onboardingSteps.length - 1)]!, completed: index === onboardingSteps.length - 1 };
}
export function shouldOpenOnboarding(input: { desktop: boolean; trusted: boolean; development: boolean; handoff: boolean; completed: boolean }): boolean {
  return input.desktop && input.trusted && !input.development && !input.handoff && !input.completed;
}
