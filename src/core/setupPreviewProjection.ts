import { resourceKeys, type ResourceView } from './resourceModel';
import { previewSetupRecipe, type SetupRecipePreview, type SetupPreviewResourceState } from './setupRecipe';
import type { Task } from './model';

export interface SelectedTaskSetupPreview {
  recipe?: SetupRecipePreview;
  resources: SetupPreviewResourceState[];
}

/** Projects saved configuration only. No claim file, process, or backing service is touched. */
export function projectSelectedTaskSetupPreview(task: Task, views: Record<string, ResourceView>): SelectedTaskSetupPreview {
  const current = views[task.id];
  if (!current) return { resources: [] };
  const recipe = previewSetupRecipe({ version: 1, taskId: task.id, workspacePath: task.worktree, ...current.config, environment: [] });
  const resources = recipe.reservations.map(reservation => {
    const otherOwner = Object.entries(views).some(([id, view]) => id !== task.id && view.reserved && resourceKeys(view.config).includes(reservation.key));
    const state: SetupPreviewResourceState = {
      key: reservation.key,
      reservation: otherOwner ? 'conflict' : current.reserved ? 'reserved' : 'unavailable',
      ...(reservation.kind === 'port' ? {} : { backingService: !current.reserved || current.status === 'failed' ? 'missing' as const : 'unknown' as const })
    };
    return state;
  });
  return { recipe, resources };
}
