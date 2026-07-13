import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { RuntimeAdapter, ExecuteTaskParams, ExecuteTaskResult, HealthCheckResult } from './runtime-adapter.js';
import type { RegisteredPlugin } from '../domain/plugin-registry.js';

interface WslDockerConfig {
  /** Docker 容器名称，用于 health check */
  containerName: string;
  /** 容器内 HTTP 服务端口 */
  port: number;
  /** 推理超时 ms，默认 600_000 (10 min) */
  timeoutMs?: number;
  /** WSL 发行版名称，默认 Ubuntu-22.04 */
  wslDistro?: string;
}

const DEFAULT_WSL_DISTRO = 'Ubuntu-22.04';
const DEFAULT_TIMEOUT_MS = 600_000;
const WSL_TEMP_BASE = '/tmp/personalhub-jobs';

/**
 * WslDockerRuntime：通过 WSL2 调用 Docker 容器内的 HTTP 推理服务。
 *
 * 工作流程：
 * 1. 将 Windows 上的输入文件复制到 WSL2 /tmp/
 * 2. 通过 curl POST 调用容器 /infer 接口
 * 3. 解析 JSON 响应
 *
 * 容器要求：
 * - 在 WSL2 Docker 中运行，暴露 HTTP 端口
 * - 提供 POST /infer 接口，接收 { input: ..., _inputDir, _outputDir }
 * - 返回 { output: { files?, text?, json?, ... } }
 */
export class WslDockerRuntime implements RuntimeAdapter {
  readonly runtime = 'wsl-docker';

  private getConfig(plugin: RegisteredPlugin): Required<WslDockerConfig> {
    const cfg = (plugin.runtimeConfig ?? {}) as Partial<WslDockerConfig>;
    return {
      containerName: cfg.containerName ?? plugin.id,
      port: cfg.port ?? 5001,
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      wslDistro: cfg.wslDistro ?? DEFAULT_WSL_DISTRO,
    };
  }

  async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
    const cfg = this.getConfig(params.plugin);
    const input = params.input as Record<string, unknown> | undefined;
    const jobId = (input?.['_workDir'] as string) ?? `job-${Date.now()}`;
    const jobSlug = String(jobId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(-32);

    // WSL2 内临时目录
    const wslJobDir = `${WSL_TEMP_BASE}/${jobSlug}`;
    const wslInputDir = `${wslJobDir}/input`;
    const wslOutputDir = `${wslJobDir}/output`;

    try {
      // 1. 在 WSL2 内创建目录
      this.wslExec(`mkdir -p "${wslInputDir}" "${wslOutputDir}"`, cfg.wslDistro);

      // 2. 复制输入文件到 WSL2
      if (input) {
        for (const [key, value] of Object.entries(input)) {
          if (
            (key.endsWith('Local') || key === '_inputDir' || key === '_outputDir' || key === '_workDir') &&
            typeof value === 'string'
          ) {
            const wslPath = this.toWslPath(value, cfg.wslDistro);
            // _inputDir → 复制其内容
            if (key === '_inputDir') {
              this.wslExec(`cp -r "${wslPath}"/. "${wslInputDir}"/`, cfg.wslDistro);
            }
          }
        }
      }

      // 3. 构建传递给容器的 input（使用 WSL 路径）
      const containerInput: Record<string, unknown> = {};
      if (input) {
        for (const [key, value] of Object.entries(input)) {
          if (key.startsWith('_')) continue; // 跳过内部字段
          if (key.endsWith('Local')) {
            // ArtifactLayer 已把整个 inputDir 复制到 WSL 临时目录；容器应使用该副本，
            // 不能继续引用 Windows 的 /mnt/c 路径（容器通常未挂载 Windows 文件系统）。
            const plainKey = key.replace(/Local$/, '');
            containerInput[plainKey] = `${wslInputDir}/${path.win32.basename(value as string)}`;
          } else {
            containerInput[key] = value;
          }
        }
      }
      containerInput['_inputDir'] = wslInputDir;
      containerInput['_outputDir'] = wslOutputDir;

      // 推理服务运行在 Docker 容器内，WSL 主机的 /tmp 默认不会自动挂载进去。
      // 显式复制输入，确保传给 /infer 的路径在容器内真实存在。
      this.wslExec(`docker exec "${cfg.containerName}" mkdir -p "${wslInputDir}" "${wslOutputDir}"`, cfg.wslDistro);
      this.wslExec(`docker cp "${wslInputDir}/." "${cfg.containerName}:${wslInputDir}/"`, cfg.wslDistro);

      // 4. 调容器 HTTP API
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

      let responseText: string;
      try {
        const response = await fetch(`http://localhost:${cfg.port}/infer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(containerInput),
          signal: controller.signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`容器推理请求失败: HTTP ${response.status}${errText ? ` - ${errText.slice(0, 200)}` : ''}`);
        }
        responseText = await response.text();
      } finally {
        clearTimeout(timer);
      }

      // 5. 解析响应
      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error('容器返回了无效 JSON');
      }
      const output = parsed as Record<string, unknown>;

      // 将容器生成的文件复制回 WSL，后续 ArtifactLayer 才能收集并上传。
      this.wslExec(`docker cp "${cfg.containerName}:${wslOutputDir}/." "${wslOutputDir}/"`, cfg.wslDistro);

      // 6. 如果容器返回了 files 清单，补充完整路径
      if (Array.isArray(output['files'])) {
        const files = output['files'] as Array<Record<string, unknown>>;
        for (const file of files) {
          if (!file['localPath'] && file['path']) {
            // 容器内的 WSL 路径 → 转换为本地 Windows 路径
            file['localPath'] = this.toWinPath(file['path'] as string, cfg.wslDistro);
          }
        }
      }

      return { output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`WSL Docker 执行失败: ${message}`);
    }
  }

  async healthCheck(plugin: RegisteredPlugin): Promise<HealthCheckResult> {
    const cfg = this.getConfig(plugin);
    try {
      // 检查容器是否在运行
      const out = execFileSync('wsl', [
        '-d', cfg.wslDistro, '-u', 'root', '--',
        'docker', 'inspect', '-f', '{{.State.Status}}', cfg.containerName,
      ], { encoding: 'utf-8', timeout: 15_000 });
      if (out.trim() !== 'running') {
        return { ok: false, message: `容器 ${cfg.containerName} 状态: ${out.trim() || 'not found'}` };
      }
      // 检查 HTTP 服务是否可达
      try {
        this.wslExec(`curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:${cfg.port}/health || true`, cfg.wslDistro);
      } catch {
        return { ok: false, message: `容器 HTTP 健康检查失败` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 在 WSL2 内执行命令 */
  private wslExec(cmd: string, distro: string): void {
    execFileSync('wsl', ['-d', distro, '-u', 'root', '--', 'bash', '-c', cmd], {
      encoding: 'utf-8',
      timeout: 30_000,
      stdio: 'pipe',
    });
  }

  /** Windows 路径 → WSL 路径（/mnt/c/...） */
  private toWslPath(winPath: string, distro: string): string {
    try {
      const out = execFileSync('wsl', ['-d', distro, '--', 'wslpath', '-u', winPath], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: 'pipe',
      });
      return out.trim();
    } catch {
      // 回退：简单替换
      return winPath.replace(/\\/g, '/').replace(/^([A-Z]):/i, (_m, d) => `/mnt/${d.toLowerCase()}`);
    }
  }

  /** WSL 路径 → Windows 路径 */
  private toWinPath(wslPath: string, distro: string): string {
    try {
      const out = execFileSync('wsl', ['-d', distro, '--', 'wslpath', '-w', wslPath], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: 'pipe',
      });
      return out.trim();
    } catch {
      return wslPath;
    }
  }
}
