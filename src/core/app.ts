import { PluginRegistry } from './domain/plugin-registry.js';
import { CapabilityRegistry } from './domain/capability-registry.js';
import { TaskStore } from './domain/task-store.js';
import { TaskRouter } from './domain/task-router.js';
import { MockRuntime } from './runtime/mock-runtime.js';
import { DockerRuntime } from './runtime/docker-runtime.js';
import { PythonVenvRuntime } from './runtime/python-venv-runtime.js';
import { WslDockerRuntime } from './runtime/wsl-docker-runtime.js';
import { LocalOnlyConnector } from './connector/local-only-connector.js';
import { AgentLoop } from './agent/agent-loop.js';
import { startApiServer } from './api/server.js';
import type { RuntimeAdapter } from './runtime/runtime-adapter.js';
import type { Connector } from './connector/connector.js';
import type { ArtifactLayer } from './artifact/artifact-layer.js';

export interface PersonalHubConfig {
  apiPort?: number;
  apiHost?: string;
  connector?: Connector;
  hostId?: string;
  name?: string;
  version?: string;
  mode?: string;
  pluginsDir?: string;
  diagnosticLogger?: (message: string) => void;
  artifactLayer?: ArtifactLayer;
}

export interface PersonalHubRuntime {
  pluginRegistry: PluginRegistry;
  capabilityRegistry: CapabilityRegistry;
  taskRouter: TaskRouter;
  taskStore: TaskStore;
  agent: AgentLoop;
  connector: Connector;
  apiPort: number;
  apiHost: string;
  startedAt: string;
  stop(): Promise<void>;
}

const DEFAULT_VERSION = '0.1.0';
const DEFAULT_MODE = 'local-only';
const DEFAULT_HOST = '127.0.0.1';

export async function createPersonalHub(config: PersonalHubConfig = {}): Promise<PersonalHubRuntime> {
  const startedAt = new Date().toISOString();

  const pluginRegistry = new PluginRegistry();
  const capRegistry = new CapabilityRegistry(pluginRegistry);
  const taskStore = new TaskStore();
  const mockRuntime = new MockRuntime();
  const runtimes = new Map<string, RuntimeAdapter>();
  runtimes.set('mock', mockRuntime);
  runtimes.set('docker', new DockerRuntime());
  runtimes.set('python-venv', new PythonVenvRuntime(config.pluginsDir ?? '.'));
  runtimes.set('wsl-docker', new WslDockerRuntime());
  const taskRouter = new TaskRouter({
    pluginRegistry,
    capabilityRegistry: capRegistry,
    taskStore,
    runtimes,
  });

  const connector = config.connector ?? new LocalOnlyConnector();
  const agent = new AgentLoop({
    connector,
    pluginRegistry,
    capabilityRegistry: capRegistry,
    taskRouter,
    startedAt,
    hostId: config.hostId,
    name: config.name,
    version: config.version ?? DEFAULT_VERSION,
    mode: config.mode ?? DEFAULT_MODE,
    diagnosticLogger: config.diagnosticLogger,
    artifactLayer: config.artifactLayer,
  });

  const { app, port, host } = await startApiServer(
    {
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt,
    },
    config.apiPort ?? 0,
    config.apiHost ?? DEFAULT_HOST,
  );

  return {
    pluginRegistry,
    capabilityRegistry: capRegistry,
    taskRouter,
    taskStore,
    agent,
    connector,
    apiPort: port,
    apiHost: host,
    startedAt,
    stop: async () => {
      await app.close();
    },
  };
}
