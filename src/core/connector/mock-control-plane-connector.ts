import type { Connector, HostSnapshot, CapabilitySummary, RemoteTask, TaskResult, WorkerError } from './connector.js';

export interface MockControlPlaneState {
  heartbeats: HostSnapshot[];
  publishedCapabilities: CapabilitySummary[];
  registeredHost: HostSnapshot | null;
  remoteTasks: RemoteTask[];
  results: TaskResult[];
  errors: WorkerError[];
  heartbeatCount: number;
}

export class MockControlPlaneConnector implements Connector {
  readonly id = 'mock-control-plane';
  readonly mode = 'mock';

  private readonly state: MockControlPlaneState;

  constructor(initialTasks: RemoteTask[] = []) {
    this.state = {
      heartbeats: [],
      publishedCapabilities: [],
      registeredHost: null,
      remoteTasks: [...initialTasks],
      results: [],
      errors: [],
      heartbeatCount: 0,
    };
  }

  async registerHost(snapshot: HostSnapshot): Promise<void> {
    this.state.registeredHost = { ...snapshot };
  }

  async sendHeartbeat(snapshot: HostSnapshot): Promise<void> {
    this.state.heartbeats.push({ ...snapshot });
    this.state.heartbeatCount += 1;
  }

  async publishCapabilities(capabilities: CapabilitySummary[]): Promise<void> {
    this.state.publishedCapabilities = capabilities.map((c) => ({ ...c }));
  }

  async pullTasks(): Promise<RemoteTask[]> {
    const tasks = [...this.state.remoteTasks];
    this.state.remoteTasks = [];
    return tasks;
  }

  async pushTaskResult(result: TaskResult): Promise<void> {
    this.state.results.push({ ...result });
  }

  async reportError(error: WorkerError): Promise<void> {
    this.state.errors.push({ ...error });
  }

  getState(): Readonly<MockControlPlaneState> {
    return this.state;
  }

  queueTasks(tasks: RemoteTask[]): void {
    this.state.remoteTasks.push(...tasks);
  }
}
