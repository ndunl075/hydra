import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseResources, resourceEnvironment, resourceKeys, type ResourceConfig } from './resourceModel';
import type { IntegrationCommand } from './integrationModel';

const taskIdPattern = /^[a-f0-9]{12}$/;
const environmentNamePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const supportedFields = new Set(['version', 'taskId', 'workspacePath', 'port', 'database', 'service', 'environment', 'commands', 'timeoutMs']);
const assignedEnvironmentNames = new Set(['HYDRA_TASK_PORT', 'HYDRA_TASK_DATABASE', 'HYDRA_TASK_SERVICE']);

/**
 * A review-only description of setup. Environment entries are names, never
 * values, so a recipe can be safely displayed or retained with a task.
 */
export interface SetupRecipe {
  version: 1;
  taskId: string;
  workspacePath: string;
  port?: number;
  database?: string;
  service?: string;
  environment: string[];
  commands: IntegrationCommand[];
  timeoutMs: number;
}

export interface SetupRecipePreview {
  digest: string;
  taskId: string;
  workspacePath: string;
  reservations: Array<{ kind: 'port' | 'database' | 'service'; name: string; key: string; environment: string }>;
  environment: Array<{ name: string }>;
  commands: Array<{ order: number; executable: string; argumentCount: number; timeoutMs: number }>;
  timeoutMs: number;
}
export interface SetupPreviewResourceState {
  key: string;
  reservation: 'reserved' | 'conflict' | 'unavailable';
  backingService?: 'available' | 'missing' | 'unknown';
}

function fail(message: string): never { throw new Error(message); }

function workspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) fail('Setup recipe workspace path must be a bounded absolute path.');
  if (!path.isAbsolute(value)) fail('Setup recipe workspace path must be absolute.');
  const normalized = path.normalize(value);
  if (normalized !== value || normalized === path.parse(normalized).root) fail('Setup recipe workspace path is invalid.');
  return normalized;
}

function environment(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || !value.every(name => typeof name === 'string' && environmentNamePattern.test(name))) fail('Setup recipe environment entries must be up to 64 uppercase variable names.');
  const names = [...value] as string[];
  if (new Set(names).size !== names.length) fail('Setup recipe environment names must not be duplicated.');
  if (names.some(name => assignedEnvironmentNames.has(name))) fail('Setup recipe environment names conflict with Hydra resource assignments.');
  return names;
}

function config(value: Record<string, unknown>): ResourceConfig {
  try {
    return parseResources({ port: value.port, database: value.database, service: value.service, commands: value.commands, timeoutMs: value.timeoutMs });
  } catch (error) {
    throw new Error(`Invalid setup recipe: ${(error as Error).message}`);
  }
}

/** Validates data only. It never reserves a resource, reads a checkout, or starts a process. */
export function validateSetupRecipe(value: unknown): SetupRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Invalid setup recipe.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !supportedFields.has(key))) fail('Invalid setup recipe fields. Secret values and arbitrary environment data are not supported.');
  if (data.version !== 1) fail('Setup recipe version must be 1.');
  if (typeof data.taskId !== 'string' || !taskIdPattern.test(data.taskId)) fail('Setup recipe task ID is invalid.');
  const resources = config(data);
  if (resources.database && resources.service && resources.database === resources.service) fail('Setup recipe database and service names conflict.');
  return {
    version: 1,
    taskId: data.taskId,
    workspacePath: workspacePath(data.workspacePath),
    ...(resources.port === undefined ? {} : { port: resources.port }),
    ...(resources.database ? { database: resources.database } : {}),
    ...(resources.service ? { service: resources.service } : {}),
    environment: environment(data.environment),
    commands: resources.commands.map(command => ({ executable: command.executable, args: [...command.args] })),
    timeoutMs: resources.timeoutMs
  };
}

function canonical(recipe: SetupRecipe): string {
  return JSON.stringify({
    version: recipe.version, taskId: recipe.taskId, workspacePath: recipe.workspacePath,
    port: recipe.port ?? null, database: recipe.database ?? null, service: recipe.service ?? null,
    environment: recipe.environment, commands: recipe.commands, timeoutMs: recipe.timeoutMs
  });
}

/** Stable SHA-256 identity for the exact reviewed recipe. */
export function setupRecipeDigest(value: SetupRecipe | unknown): string {
  const recipe = validateSetupRecipe(value);
  return createHash('sha256').update(canonical(recipe)).digest('hex');
}

/** Produces display data only. Secret values are intentionally absent from this shape. */
export function previewSetupRecipe(value: unknown): SetupRecipePreview {
  const recipe = validateSetupRecipe(value);
  const config: ResourceConfig = { ...(recipe.port === undefined ? {} : { port: recipe.port }), ...(recipe.database ? { database: recipe.database } : {}), ...(recipe.service ? { service: recipe.service } : {}), commands: recipe.commands, timeoutMs: recipe.timeoutMs };
  const assigned = resourceEnvironment(config);
  const reservations: SetupRecipePreview['reservations'] = [];
  for (const key of resourceKeys(config)) {
    const [kind, name] = key.split(':') as ['port' | 'database' | 'service', string];
    const environment = kind === 'port' ? 'HYDRA_TASK_PORT' : kind === 'database' ? 'HYDRA_TASK_DATABASE' : 'HYDRA_TASK_SERVICE';
    // `assigned` makes the source of this display binding explicit; it is not returned as a secret-bearing value.
    if (!assigned[environment]) fail('Setup recipe resource binding is invalid.');
    reservations.push({ kind, name, key, environment });
  }
  return {
    digest: setupRecipeDigest(recipe), taskId: recipe.taskId, workspacePath: recipe.workspacePath, reservations,
    environment: recipe.environment.map(name => ({ name })),
    commands: recipe.commands.map((command, index) => ({ order: index + 1, executable: command.executable, argumentCount: command.args.length, timeoutMs: recipe.timeoutMs })),
    timeoutMs: recipe.timeoutMs
  };
}
