import type { Connector, HostSnapshot, CapabilitySummary, RemoteTask, TaskResult, WorkerError } from './connector.js';

export class LocalOnlyConnector implements Connector {
  readonly id = 'local-only';
  readonly mode = 'local-only';

  async registerHost(_snapshot: HostSnapshot): Promise<void> {}
  async sendHeartbeat(_snapshot: HostSnapshot): Promise<void> {}
  async publishCapabilities(_capabilities: CapabilitySummary[]): Promise<void> {}
  async pullTasks(): Promise<RemoteTask[]> { return []; }
  async pushTaskResult(_result: TaskResult): Promise<void> {}
  async reportError(_error: WorkerError): Promise<void> {}
}
