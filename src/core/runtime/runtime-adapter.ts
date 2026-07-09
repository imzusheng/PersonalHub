import type { RegisteredPlugin } from '../domain/plugin-registry.js';

export interface ExecuteTaskParams {
  capability: string;
  input: unknown;
  plugin: RegisteredPlugin;
}

export interface ExecuteTaskResult {
  output: unknown;
}

export interface HealthCheckResult {
  ok: boolean;
  message?: string;
}

export interface RuntimeAdapter {
  readonly runtime: string;
  executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult>;
  healthCheck(plugin: RegisteredPlugin): Promise<HealthCheckResult>;
}
