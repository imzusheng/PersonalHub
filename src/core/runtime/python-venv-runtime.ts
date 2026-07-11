import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { RegisteredPlugin } from '../domain/plugin-registry.js';
import type { ExecuteTaskParams, ExecuteTaskResult, HealthCheckResult, RuntimeAdapter } from './runtime-adapter.js';
import { runJsonProcess } from './process-json.js';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;

interface PythonVenvRuntimeConfig {
  entrypoint: string;
  pythonPath?: string;
  workingDirectory?: string;
  timeoutMs?: number;
}

function getConfig(plugin: RegisteredPlugin): PythonVenvRuntimeConfig {
  const config = plugin.runtimeConfig;
  if (!config || typeof config.entrypoint !== 'string' || !config.entrypoint.trim()) throw new Error(`Python 插件缺少入口配置: ${plugin.id}`);
  if (path.isAbsolute(config.entrypoint) || config.entrypoint.split(path.sep).includes('..')) throw new Error(`Python 插件入口必须是相对路径: ${plugin.id}`);
  return {
    entrypoint: config.entrypoint,
    ...(typeof config.pythonPath === 'string' ? { pythonPath: config.pythonPath } : {}),
    ...(typeof config.workingDirectory === 'string' ? { workingDirectory: config.workingDirectory } : {}),
    ...(typeof config.timeoutMs === 'number' ? { timeoutMs: config.timeoutMs } : {}),
  };
}

export class PythonVenvRuntime implements RuntimeAdapter {
  readonly runtime = 'python-venv';

  private readonly pluginsRoot: string;

  constructor(pluginsDir: string) {
    this.pluginsRoot = pluginsDir;
  }

  async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
    const config = getConfig(params.plugin);
    const workingDirectory = path.resolve(this.pluginsRoot, params.plugin.id);
    const entrypoint = path.resolve(workingDirectory, config.entrypoint);
    if (!entrypoint.startsWith(`${workingDirectory}${path.sep}`)) throw new Error(`Python 插件入口超出工作目录: ${params.plugin.id}`);
    const timeoutMs = Number.isInteger(config.timeoutMs) && config.timeoutMs! > 0 ? config.timeoutMs! : DEFAULT_TIMEOUT_MS;
    const output = await runJsonProcess(config.pythonPath ?? 'python', [entrypoint], { capability: params.capability, input: params.input }, timeoutMs, workingDirectory);
    return { output };
  }

  async healthCheck(plugin: RegisteredPlugin): Promise<HealthCheckResult> {
    try {
      const config = getConfig(plugin);
      await execFileAsync(config.pythonPath ?? 'python', ['--version'], { timeout: 5_000, windowsHide: true });
      if (plugin.healthcheck?.type === 'http' && typeof plugin.healthcheck.url === 'string') {
        const response = await fetch(plugin.healthcheck.url, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`健康检查失败: HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
