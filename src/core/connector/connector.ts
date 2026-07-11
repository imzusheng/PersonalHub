export interface HostSnapshot {
  hostId: string;
  name: string;
  version: string;
  mode: string;
  platform: NodeJS.Platform;
  startedAt: string;
  status: 'running';
  pluginCount: number;
  capabilityCount: number;
}

export interface CapabilitySummary {
  name: string;
  pluginId: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface PluginServiceSnapshot {
  serviceId: string;
  kind: string;
  name: string;
  version: string;
  status: 'running' | 'error' | 'offline';
  controlMode: 'managed' | 'observable';
  capabilities: string[];
  healthError?: string;
}

export interface RemoteCommand {
  commandId: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface RemoteTask {
  remoteTaskId: string;
  capability: string;
  input: unknown;
  leaseExpiresAt?: number;
}

export interface TaskResult {
  remoteTaskId: string;
  localTaskId: string | null;
  status: 'succeeded' | 'failed';
  output: unknown | null;
  error: { message: string; details?: unknown } | null;
}

export interface WorkerError {
  message: string;
  details?: unknown;
}

export interface HostMetrics {
  memoryPercent: number;
  cpuPercent?: number;
  netRxBytesPerSec?: number;
  netTxBytesPerSec?: number;
  diskUsedPercent?: number;
  gpuUtilPercent?: number;
  gpuTempC?: number;
  gpuName?: string;
  gpuVramMB?: number;
  recordedAt: number;
}

export interface Connector {
  readonly id: string;
  readonly mode: string;

  registerHost(snapshot: HostSnapshot): Promise<void>;
  sendHeartbeat(snapshot: HostSnapshot): Promise<void>;
  publishCapabilities(capabilities: CapabilitySummary[]): Promise<void>;
  syncPluginServices?(services: PluginServiceSnapshot[]): Promise<void>;
  pullCommands?(): Promise<RemoteCommand[]>;
  completeCommand?(commandId: string, ok: boolean, error?: string): Promise<void>;
  pullTasks(): Promise<RemoteTask[]>;
  markTaskRunning?(remoteTaskId: string): Promise<void>;
  renewTaskLease?(remoteTaskId: string): Promise<void>;
  publishMetrics?(metrics: HostMetrics): Promise<void>;
  reportStopped?(services: PluginServiceSnapshot[]): Promise<void>;
  pushTaskResult(result: TaskResult): Promise<void>;
  reportError(error: WorkerError): Promise<void>;
  /** 下载输入文件到本地路径 */
  downloadInputFile?(url: string, destPath: string): Promise<void>;
  /** 上传输出文件（multipart），与旧 ASR succeeded 端点兼容 */
  uploadJobArtifacts?(jobId: string, files: { localPath: string; name: string; mimeType?: string }[]): Promise<void>;
}
