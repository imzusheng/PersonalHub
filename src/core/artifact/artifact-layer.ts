import type { RemoteTask } from '../connector/connector.js';
import type { Connector } from '../connector/connector.js';
import path from 'node:path';
import { createWorkDir, cleanup, type WorkDir } from './temp-manager.js';
import { downloadFile, type DownloadResult } from './file-downloader.js';
import { uploadFiles, type FileToUpload } from './file-uploader.js';

/** input 中可能包含的 URL 字段名 */
const URL_FIELD_NAMES = ['audioUrl', 'imageUrl', 'fileUrl', 'url', 'inputUrl'];

export interface DownloadInputsResult {
  /** 原始 input 参数 */
  params: Record<string, unknown>;
  /** 下载后的本地文件映射: 原始 URL 字段名 → 本地路径 */
  localPaths: Record<string, string>;
  /** 下载文件的详细信息 */
  files: DownloadResult[];
}

export interface ArtifactLayerConfig {
  connector: Connector;
  apiKey: string;
  baseUrl: string;
}

/**
 * ArtifactLayer 负责任务相关的文件传输：
 * - 从 RemoteTask.input 中识别 URL 字段并下载
 * - 收集插件输出的文件并上传到 AdminOS
 * - 管理临时目录生命周期
 *
 * 职责边界：
 * - 下载/上传/校验 URL → 本地路径映射 → 清理
 * - 不参与任务调度、租约、状态机
 */
export class ArtifactLayer {
  constructor(private readonly config: ArtifactLayerConfig) {}

  /**
   * 为任务创建工作目录并下载输入文件。
   * 从 task.input 中提取 URL 字段，下载到 workDir/input/。
   *
   * @returns 原始参数 + 本地路径映射
   */
  async downloadInputs(remoteTask: RemoteTask): Promise<DownloadInputsResult> {
    const input = remoteTask.input as Record<string, unknown> | undefined;
    const params: Record<string, unknown> = {};
    const localPaths: Record<string, string> = {};
    const files: DownloadResult[] = [];

    if (!input || typeof input !== 'object') {
      return { params, localPaths, files };
    }

    const workDir = createWorkDir(remoteTask.remoteTaskId);

    for (const [key, value] of Object.entries(input)) {
      if (URL_FIELD_NAMES.includes(key) && typeof value === 'string' && this.isValidUrl(value)) {
        const result = await downloadFile(value, workDir.inputDir);
        localPaths[key] = result.localPath;
        files.push(result);
        // 保留原始值，同时添加本地路径
        params[key] = value;
        params[`${key}Local`] = result.localPath;
      } else {
        params[key] = value;
      }
    }

    // 始终把 inputDir 和 outputDir 传入插件
    params['_inputDir'] = workDir.inputDir;
    params['_outputDir'] = workDir.outputDir;
    params['_workDir'] = workDir.jobDir;

    return { params, localPaths, files };
  }

  /**
   * 上传输出文件到 AdminOS。
   * 使用旧 succeeded 端点实现 multipart 上传（与旧 ASR agent 协议兼容）。
   */
  async uploadOutputs(
    workDir: WorkDir,
    pluginOutput: unknown,
    remoteTaskId: string,
  ): Promise<FileToUpload[]> {
    const filesToUpload = this.collectOutputFiles(workDir, pluginOutput);
    if (filesToUpload.length === 0) return [];

    const uploadUrl = `${this.config.baseUrl}/api/hosts/jobs/${encodeURIComponent(remoteTaskId)}/succeeded`;
    await uploadFiles(uploadUrl, this.config.apiKey, filesToUpload);
    return filesToUpload;
  }

  /**
   * 从插件输出中收集需要上传的文件。
   * 插件输出中如果有 files 数组，每个 file 包含 path/name/mimeType。
   */
  private collectOutputFiles(_workDir: WorkDir, pluginOutput: unknown): FileToUpload[] {
    if (!pluginOutput || typeof pluginOutput !== 'object') return [];

    const output = pluginOutput as Record<string, unknown>;
    const fileList = output['files'];
    if (!Array.isArray(fileList)) return [];

    const result: FileToUpload[] = [];
    for (const item of fileList) {
      if (!item || typeof item !== 'object') continue;
      const file = item as { localPath?: string; path?: string; name?: string; mimeType?: string };
      const localPath = file.localPath || file.path;
      if (!localPath) continue;
      result.push({
        localPath: String(localPath),
        name: file.name || path.basename(String(localPath)),
        mimeType: file.mimeType,
      });
    }
    return result;
  }

  /**
   * 清理工作目录。成功时立即删除，失败时延迟 1h 删除。
   */
  async cleanupWorkDir(workDir: WorkDir, taskFailed: boolean): Promise<void> {
    cleanup(workDir, taskFailed);
  }

  /**
   * 创建工作目录（不下载）。
   */
  createWorkDir(jobId: string): WorkDir {
    return createWorkDir(jobId);
  }

  private isValidUrl(str: string): boolean {
    try {
      const url = new URL(str);
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  }
}
