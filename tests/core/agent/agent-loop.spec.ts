import { describe, it, expect, beforeEach } from 'vitest';
import { AgentLoop } from '../../../src/core/agent/agent-loop.js';
import { MockControlPlaneConnector } from '../../../src/core/connector/mock-control-plane-connector.js';
import { LocalOnlyConnector } from '../../../src/core/connector/local-only-connector.js';
import { PluginRegistry } from '../../../src/core/domain/plugin-registry.js';
import { CapabilityRegistry } from '../../../src/core/domain/capability-registry.js';
import { TaskStore } from '../../../src/core/domain/task-store.js';
import { TaskRouter } from '../../../src/core/domain/task-router.js';
import { MockRuntime } from '../../../src/core/runtime/mock-runtime.js';
import { parsePluginManifest } from '../../../src/core/domain/plugin-manifest.js';

function setupVisionRuntime() {
  const pluginRegistry = new PluginRegistry();
  const capRegistry = new CapabilityRegistry(pluginRegistry);
  const taskStore = new TaskStore();
  const mockRuntime = new MockRuntime();
  const runtimes = new Map();
  runtimes.set('mock', mockRuntime);
  const taskRouter = new TaskRouter({ pluginRegistry, capabilityRegistry: capRegistry, taskStore, runtimes });

  const manifest = parsePluginManifest({
    id: 'vision.mock',
    name: 'Mock Vision',
    version: '0.1.0',
    runtime: 'mock',
    capabilities: [
      {
        name: 'image.describe',
        inputSchema: {
          type: 'object',
          required: ['imageUrl'],
          properties: { imageUrl: { type: 'string' } },
        },
        outputSchema: {
          type: 'object',
          required: ['description'],
          properties: { description: { type: 'string' } },
        },
      },
    ],
    healthcheck: { type: 'mock' },
  });
  if (!manifest.success) throw new Error('manifest parse failed');
  pluginRegistry.register(manifest.data);

  return { pluginRegistry, capRegistry, taskStore, taskRouter };
}

describe('AgentLoop', () => {
  let pluginRegistry: PluginRegistry;
  let capRegistry: CapabilityRegistry;
  let taskRouter: TaskRouter;

  beforeEach(() => {
    const setup = setupVisionRuntime();
    pluginRegistry = setup.pluginRegistry;
    capRegistry = setup.capRegistry;
    taskRouter = setup.taskRouter;
  });

  it('sends heartbeat during tick', async () => {
    const connector = new MockControlPlaneConnector();
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    expect(connector.getState().heartbeatCount).toBe(1);
  });

  it('publishes capabilities during tick', async () => {
    const connector = new MockControlPlaneConnector();
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    const caps = connector.getState().publishedCapabilities;
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('image.describe');
    expect(caps[0].pluginId).toBe('vision.mock');
  });

  it('pulls remote tasks during tick', async () => {
    const connector = new MockControlPlaneConnector([
      { remoteTaskId: 'r1', capability: 'image.describe', input: { imageUrl: 'file://test.png' } },
    ]);
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    expect(connector.getState().results).toHaveLength(1);
  });

  it('executes image.describe task via TaskRouter and pushes succeeded result', async () => {
    const connector = new MockControlPlaneConnector([
      { remoteTaskId: 'r1', capability: 'image.describe', input: { imageUrl: 'file://test.png' } },
    ]);
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    const result = connector.getState().results[0];
    expect(result.remoteTaskId).toBe('r1');
    expect(result.status).toBe('succeeded');
    expect(result.localTaskId).not.toBeNull();
    expect(result.output).toEqual({ description: 'Mock description for file://test.png' });
    expect(result.error).toBeNull();
  });

  it('pushes failed result when capability does not exist', async () => {
    const connector = new MockControlPlaneConnector([
      { remoteTaskId: 'r1', capability: 'nonexistent.capability', input: {} },
    ]);
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    const result = connector.getState().results[0];
    expect(result.remoteTaskId).toBe('r1');
    expect(result.status).toBe('failed');
    expect(result.localTaskId).toBeNull();
    expect(result.error?.message).toContain('nonexistent.capability');
  });

  it('pushes failed result when plugin execution throws', async () => {
    const connector = new MockControlPlaneConnector([
      { remoteTaskId: 'r1', capability: 'image.describe', input: { imageUrl: 'file://test.png', forceError: true } },
    ]);
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    const result = connector.getState().results[0];
    expect(result.status).toBe('failed');
    expect(result.error?.message).toBeDefined();
  });

  it('does not crash when tick encounters an error', async () => {
    const connector = new MockControlPlaneConnector();
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    connector.sendHeartbeat = async () => {
      throw new Error('heartbeat boom');
    };
    const result = await agent.tick();
    expect(result.errors).toBe(1);
    expect(connector.getState().errors).toHaveLength(1);
    expect(connector.getState().errors[0].message).toBe('heartbeat boom');
  });

  it('works with LocalOnlyConnector without throwing', async () => {
    const connector = new LocalOnlyConnector();
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    const result = await agent.tick();
    expect(result.heartbeatSent).toBe(true);
  });

  it('processes multiple remote tasks in a single tick', async () => {
    const connector = new MockControlPlaneConnector([
      { remoteTaskId: 'r1', capability: 'image.describe', input: { imageUrl: 'file://a.png' } },
      { remoteTaskId: 'r2', capability: 'image.describe', input: { imageUrl: 'file://b.png' } },
    ]);
    const agent = new AgentLoop({
      connector,
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskRouter,
      startedAt: new Date().toISOString(),
    });
    await agent.tick();
    expect(connector.getState().results).toHaveLength(2);
    expect(connector.getState().results[0].remoteTaskId).toBe('r1');
    expect(connector.getState().results[1].remoteTaskId).toBe('r2');
  });
});
