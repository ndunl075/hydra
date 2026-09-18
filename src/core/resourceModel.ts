import { parseIntegrationCommands, type IntegrationCommand } from './integrationModel';
export interface ResourceConfig { port?: number; database?: string; service?: string; commands: IntegrationCommand[]; timeoutMs: number }
export interface SetupCheck extends IntegrationCommand { status: 'running' | 'passed' | 'failed'; stdout: string; stderr: string; exitCode?: number | null; error?: string }
export interface ResourceRecord { config: ResourceConfig; token: string; revision: string; reserved: boolean; status: 'unchecked' | 'running' | 'passed' | 'failed' | 'interrupted' | 'released'; uncertain?: boolean; checks: SetupCheck[]; log?: string; updatedAt: string }
export type ResourceView = Omit<ResourceRecord, 'token' | 'revision'>;
export function parseResources(value: unknown): ResourceConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task resources.');
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['port', 'database', 'service', 'commands', 'timeoutMs'].includes(key))) throw new Error('Only task port, database/service identifiers and explicit setup commands are supported.');
  const named = (key: string): string | undefined => {
    const name = data[key]; if (name === undefined) return undefined;
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(name)) throw new Error('Resource identifiers require 1–63 lowercase letters, numbers, underscores or hyphens, starting with a letter.');
    return name;
  };
  if (data.port !== undefined && (!Number.isSafeInteger(data.port) || Number(data.port) < 1024 || Number(data.port) > 65535)) throw new Error('Task port must be an integer from 1024 to 65535.');
  if (!Array.isArray(data.commands)) throw new Error('Setup commands require an array of executable/argument objects.');
  const timeoutMs = data.timeoutMs ?? 120000;
  if (!Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 600000) throw new Error('Setup timeout must be 1–600 seconds per command.');
  return { ...(data.port === undefined ? {} : { port: Number(data.port) }), ...(named('database') ? { database: named('database') } : {}), ...(named('service') ? { service: named('service') } : {}), commands: data.commands.length ? parseIntegrationCommands(data.commands) : [], timeoutMs: Number(timeoutMs) };
}
export function resourceEnvironment(config: ResourceConfig): Record<string, string> {
  return { ...(config.port === undefined ? {} : { HYDRA_TASK_PORT: String(config.port) }), ...(config.database ? { HYDRA_TASK_DATABASE: config.database } : {}), ...(config.service ? { HYDRA_TASK_SERVICE: config.service } : {}) };
}
export function resourceKeys(config: ResourceConfig): string[] {
  return [config.port === undefined ? undefined : `port:${config.port}`, config.database ? `database:${config.database}` : undefined, config.service ? `service:${config.service}` : undefined].filter((key): key is string => !!key);
}
export function resolveSetupCommands(config: ResourceConfig): IntegrationCommand[] {
  const env = resourceEnvironment(config);
  return config.commands.map(command => ({ executable: command.executable, args: command.args.map(arg => arg.replace(/\{\{(HYDRA_TASK_[A-Z_]+)\}\}/g, (_match, key: string) => {
    if (!env[key]) throw new Error(`Assign ${key} before running setup.`); return env[key];
  })) }));
}
