import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegisteredPlugin } from '../domain/plugin-registry.js';
import type { ExecuteTaskParams, ExecuteTaskResult, HealthCheckResult, RuntimeAdapter } from './runtime-adapter.js';
import { runJsonProcess } from './process-json.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MEMORY_LIMIT_MB = 1_024;

interface DockerRuntimeConfig {
  image: string;
  command?: string[];
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

function getConfig(plugin: RegisteredPlugin): DockerRuntimeConfig {
  const config = plugin.runtimeConfig;
  if (!config || typeof config.image !== 'string' || !config.image.trim()) throw new Error(`Docker 插件缺少镜像配置: ${plugin.id}`);
  if (config.command !== undefined && (!Array.isArray(config.command) || config.command.some((arg) => typeof arg !== 'string'))) throw new Error(`Docker 插件 command 配置无效: ${plugin.id}`);
  const command = Array.isArray(config.command)
    ? config.command.filter((arg): arg is string => typeof arg === 'string')
    : undefined;
  return {
    image: config.image,
    ...(command ? { command } : {}),
    ...(typeof config.timeoutMs === 'number' ? { timeoutMs: config.timeoutMs } : {}),
    ...(typeof config.memoryLimitMb === 'number' ? { memoryLimitMb: config.memoryLimitMb } : {}),
    ...(typeof config.cpuLimit === 'number' ? { cpuLimit: config.cpuLimit } : {}),
  };
}

export class DockerRuntime implements RuntimeAdapter {
  readonly runtime = 'docker';

  async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
    const config = getConfig(params.plugin);
    const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs! > 0 ? config.timeoutMs! : DEFAULT_TIMEOUT_MS;
    const memoryLimitMb = Number.isInteger(config.memoryLimitMb) && config.memoryLimitMb! > 0 ? config.memoryLimitMb! : DEFAULT_MEMORY_LIMIT_MB;
    const args = ['run', '--rm', '-i', '--network=none', '--memory', `${memoryLimitMb}m`];
    if (typeof config.cpuLimit === 'number' && config.cpuLimit > 0) args.push('--cpus', String(config.cpuLimit));
    args.push(config.image, ...(config.command ?? []));
    const output = await runJsonProcess('docker', args, { capability: params.capability, input: params.input }, timeoutMs);
    return { output };
  }

  async healthCheck(plugin: RegisteredPlugin): Promise<HealthCheckResult> {
    try {
      getConfig(plugin);
      await execFileAsync('docker', ['image', 'inspect', getConfig(plugin).image], { timeout: 5_000, windowsHide: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
