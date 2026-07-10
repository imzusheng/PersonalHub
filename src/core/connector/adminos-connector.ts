import type {
  CapabilitySummary,
  Connector,
  HostSnapshot,
  HostMetrics,
  RemoteTask,
  TaskResult,
  WorkerError,
} from './connector.js';

const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_BATCH_SIZE = 5;
const HOST_AGENT_PROTOCOL_VERSION = '1.0';
const PERSONALHUB_SERVICE_ID = 'personalhub-agent';

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchImplementation = (input: string, init?: RequestInit) => Promise<FetchResponse>;

export interface AdminOSConnectorConfig {
  serverUrl: string;
  apiKey: string;
  hostId: string;
  fetchImpl?: FetchImplementation;
  leaseBatchSize?: number;
}

export interface AdminOSUpdatePlan {
  deploymentId: string;
  artifactUrl: string;
  artifactName: string;
  artifactSha256: string;
  artifactSizeBytes: number;
}

interface LeasedJobResponse {
  jobId: string;
  capability: string;
  input: unknown;
  leaseExpiresAt: number;
  attemptCount: number;
}

export class AdminOSConnector implements Connector {
  readonly id = 'adminos';
  readonly mode = 'adminos';

  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImplementation;
  private readonly serviceId: string;
  private readonly leaseBatchSize: number;

  constructor(private readonly config: AdminOSConnectorConfig) {
    const url = new URL(config.serverUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('AdminOS serverUrl 必须使用 HTTP 或 HTTPS');
    }
    if (!config.apiKey.trim()) throw new Error('AdminOS API Key 不能为空');
    if (!config.hostId.trim()) throw new Error('AdminOS hostId 不能为空');

    this.baseUrl = url.toString().replace(/\/$/, '');
    this.fetchImpl = config.fetchImpl ?? (globalThis.fetch as unknown as FetchImplementation);
    this.serviceId = `${PERSONALHUB_SERVICE_ID}:${config.hostId}`;
    this.leaseBatchSize = Math.min(Math.max(config.leaseBatchSize ?? DEFAULT_LEASE_BATCH_SIZE, 1), 20);
  }

  async registerPluginService(pluginId: string, pluginName: string, version: string): Promise<void> {
    const serviceId = `${pluginId}:${this.config.hostId}`;
    await this.request(`/api/hosts/${this.hostIdPath}/services/register`, {
      method: 'POST',
      body: {
        serviceId,
        kind: pluginId,
        name: pluginName,
        version,
      },
    });
  }

  async syncPluginServices(serviceIds: string[]): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/services/sync`, {
      method: 'POST',
      body: { keep: serviceIds },
    });
  }

  async registerHost(snapshot: HostSnapshot): Promise<void> {
    await this.request('/api/hosts/register', {
      method: 'POST',
      body: {
        hostId: snapshot.hostId,
        name: snapshot.name,
        os: snapshot.platform,
        arch: process.arch,
      },
    });
    await this.request(`/api/hosts/${this.hostIdPath}/services/register`, {
      method: 'POST',
      body: {
        serviceId: this.serviceId,
        kind: PERSONALHUB_SERVICE_ID,
        name: 'PersonalHub Agent',
        version: snapshot.version,
      },
    });
  }

  async sendHeartbeat(_snapshot: HostSnapshot): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/heartbeat`, { method: 'POST', body: {} });
  }

  async publishCapabilities(capabilities: CapabilitySummary[]): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/capabilities`, {
      method: 'POST',
      body: { protocolVersion: HOST_AGENT_PROTOCOL_VERSION, capabilities },
    });
  }

  async pullTasks(): Promise<RemoteTask[]> {
    const payload = await this.request<unknown>(`/api/hosts/${this.hostIdPath}/jobs/lease`, {
      method: 'POST',
      body: { limit: this.leaseBatchSize },
    });
    if (!Array.isArray(payload)) throw new Error('AdminOS 返回了无效的任务列表');
    return payload.map((task) => this.toRemoteTask(task));
  }

  async markTaskRunning(remoteTaskId: string): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/jobs/${encodeURIComponent(remoteTaskId)}/running`, {
      method: 'POST',
      body: {},
    });
  }

  async renewTaskLease(remoteTaskId: string): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/jobs/${encodeURIComponent(remoteTaskId)}/lease/renew`, {
      method: 'POST',
      body: {},
    });
  }

  async publishMetrics(metrics: HostMetrics): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/metrics`, { method: 'POST', body: metrics });
  }

  async pushTaskResult(result: TaskResult): Promise<void> {
    const body = result.status === 'succeeded'
      ? { status: 'succeeded', output: result.output }
      : { status: 'failed', error: result.error ?? { message: '任务执行失败' } };
    await this.request(`/api/hosts/${this.hostIdPath}/jobs/${encodeURIComponent(result.remoteTaskId)}/result`, {
      method: 'POST',
      body,
    });
  }

  async reportError(error: WorkerError): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/errors`, {
      method: 'POST',
      body: { message: error.message, details: error.details },
    });
  }

  async reportStopped(): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/services/${encodeURIComponent(this.serviceId)}/state`, {
      method: 'POST',
      body: { status: 'stopped' },
    });
  }

  async getUpdatePlan(): Promise<AdminOSUpdatePlan | null> {
    const payload = await this.request<unknown>(`/api/hosts/${this.hostIdPath}/update-plan`, { method: 'GET' });
    if (!payload || typeof payload !== 'object') throw new Error('AdminOS 返回了无效更新计划');
    const plan = payload as { deployment?: { deploymentId?: unknown }; release?: Record<string, unknown> | null; artifactUrl?: unknown };
    if (!plan.deployment || !plan.release || !plan.artifactUrl) return null;
    if (
      typeof plan.deployment.deploymentId !== 'string' ||
      typeof plan.artifactUrl !== 'string' ||
      typeof plan.release.artifactName !== 'string' ||
      typeof plan.release.artifactSha256 !== 'string' ||
      typeof plan.release.artifactSizeBytes !== 'number'
    ) throw new Error('AdminOS 更新计划字段不完整');
    return {
      deploymentId: plan.deployment.deploymentId,
      artifactUrl: plan.artifactUrl,
      artifactName: plan.release.artifactName,
      artifactSha256: plan.release.artifactSha256,
      artifactSizeBytes: plan.release.artifactSizeBytes,
    };
  }

  async downloadUpdate(plan: AdminOSUpdatePlan): Promise<Uint8Array> {
    const targetUrl = new URL(plan.artifactUrl, `${this.baseUrl}/`);
    if (targetUrl.origin !== new URL(this.baseUrl).origin) throw new Error('更新下载地址不属于 AdminOS');
    const response = await this.fetchImpl(targetUrl.toString(), { headers: { 'x-api-key': this.config.apiKey } });
    if (!response.ok) throw new Error(`更新下载失败: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== plan.artifactSizeBytes) throw new Error('更新包大小校验失败');
    return bytes;
  }

  async claimUpdate(deploymentId: string): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/deployments/${encodeURIComponent(deploymentId)}/claim`, { method: 'POST', body: {} });
  }

  async recordUpdateEvent(deploymentId: string, phase: string, message: string): Promise<void> {
    await this.request(`/api/hosts/${this.hostIdPath}/deployments/${encodeURIComponent(deploymentId)}/events`, {
      method: 'POST', body: { phase, message },
    });
  }

  private get hostIdPath(): string {
    return encodeURIComponent(this.config.hostId);
  }

  private async request<T>(path: string, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          'x-api-key': this.config.apiKey,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`AdminOS 请求失败: HTTP ${response.status}`);
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error('AdminOS 返回了无效 JSON');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private toRemoteTask(value: unknown): RemoteTask {
    if (
      typeof value !== 'object' || value === null ||
      typeof (value as LeasedJobResponse).jobId !== 'string' ||
      typeof (value as LeasedJobResponse).capability !== 'string' ||
      typeof (value as LeasedJobResponse).leaseExpiresAt !== 'number'
    ) {
      throw new Error('AdminOS 返回了无效任务');
    }
    const task = value as LeasedJobResponse;
    return {
      remoteTaskId: task.jobId,
      capability: task.capability,
      input: task.input,
      leaseExpiresAt: task.leaseExpiresAt,
    };
  }
}
