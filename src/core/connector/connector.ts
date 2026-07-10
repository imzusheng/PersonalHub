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
  pullTasks(): Promise<RemoteTask[]>;
  markTaskRunning?(remoteTaskId: string): Promise<void>;
  renewTaskLease?(remoteTaskId: string): Promise<void>;
  publishMetrics?(metrics: HostMetrics): Promise<void>;
  pushTaskResult(result: TaskResult): Promise<void>;
  reportError(error: WorkerError): Promise<void>;
}
