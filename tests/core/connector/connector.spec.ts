import { describe, it, expect } from 'vitest';
import { LocalOnlyConnector } from '../../../src/core/connector/local-only-connector.js';
import { MockControlPlaneConnector } from '../../../src/core/connector/mock-control-plane-connector.js';
import type { HostSnapshot, RemoteTask } from '../../../src/core/connector/connector.js';

const mockSnapshot: HostSnapshot = {
  hostId: 'local-dev',
  name: 'PersonalHub',
  version: '0.1.0',
  mode: 'local-only',
  platform: 'win32',
  startedAt: new Date().toISOString(),
  status: 'running',
  pluginCount: 0,
  capabilityCount: 0,
};

describe('LocalOnlyConnector', () => {
  it('registerHost does not throw', async () => {
    const conn = new LocalOnlyConnector();
    await expect(conn.registerHost(mockSnapshot)).resolves.toBeUndefined();
  });

  it('sendHeartbeat does not throw', async () => {
    const conn = new LocalOnlyConnector();
    await expect(conn.sendHeartbeat(mockSnapshot)).resolves.toBeUndefined();
  });

  it('publishCapabilities does not throw', async () => {
    const conn = new LocalOnlyConnector();
    await expect(conn.publishCapabilities([{ name: 'image.describe', pluginId: 'vision.mock' }])).resolves.toBeUndefined();
  });

  it('pullTasks returns empty array', async () => {
    const conn = new LocalOnlyConnector();
    const tasks = await conn.pullTasks();
    expect(tasks).toEqual([]);
  });

  it('pushTaskResult does not throw', async () => {
    const conn = new LocalOnlyConnector();
    await expect(conn.pushTaskResult({
      remoteTaskId: 'r1',
      localTaskId: 'l1',
      status: 'succeeded',
      output: { ok: true },
      error: null,
    })).resolves.toBeUndefined();
  });
});

describe('MockControlPlaneConnector', () => {
  it('records heartbeat count', async () => {
    const conn = new MockControlPlaneConnector();
    await conn.sendHeartbeat(mockSnapshot);
    await conn.sendHeartbeat(mockSnapshot);
    expect(conn.getState().heartbeatCount).toBe(2);
  });

  it('records capabilities published', async () => {
    const conn = new MockControlPlaneConnector();
    const caps = [
      { name: 'image.describe', pluginId: 'vision.mock' },
      { name: 'audio.transcribe', pluginId: 'asr.mock' },
    ];
    await conn.publishCapabilities(caps);
    expect(conn.getState().publishedCapabilities).toHaveLength(2);
    expect(conn.getState().publishedCapabilities[0].name).toBe('image.describe');
  });

  it('records registered host', async () => {
    const conn = new MockControlPlaneConnector();
    await conn.registerHost(mockSnapshot);
    expect(conn.getState().registeredHost).not.toBeNull();
    expect(conn.getState().registeredHost?.hostId).toBe('local-dev');
  });

  it('can preset remote tasks and pullTasks returns them', async () => {
    const tasks: RemoteTask[] = [
      { remoteTaskId: 'r1', capability: 'image.describe', input: { imageUrl: 'file://test.png' } },
    ];
    const conn = new MockControlPlaneConnector(tasks);
    const pulled = await conn.pullTasks();
    expect(pulled).toHaveLength(1);
    expect(pulled[0].remoteTaskId).toBe('r1');
  });

  it('pullTasks clears the queue after pulling', async () => {
    const conn = new MockControlPlaneConnector([
      { remoteTaskId: 'r1', capability: 'image.describe', input: {} },
    ]);
    await conn.pullTasks();
    const secondPull = await conn.pullTasks();
    expect(secondPull).toEqual([]);
  });

  it('records pushed results', async () => {
    const conn = new MockControlPlaneConnector();
    await conn.pushTaskResult({
      remoteTaskId: 'r1',
      localTaskId: 'l1',
      status: 'succeeded',
      output: { description: 'hello' },
      error: null,
    });
    expect(conn.getState().results).toHaveLength(1);
    expect(conn.getState().results[0].status).toBe('succeeded');
  });

  it('records errors', async () => {
    const conn = new MockControlPlaneConnector();
    await conn.reportError({ message: 'boom' });
    expect(conn.getState().errors).toHaveLength(1);
    expect(conn.getState().errors[0].message).toBe('boom');
  });

  it('can queue additional tasks', async () => {
    const conn = new MockControlPlaneConnector();
    conn.queueTasks([{ remoteTaskId: 'r2', capability: 'image.describe', input: {} }]);
    const tasks = await conn.pullTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].remoteTaskId).toBe('r2');
  });
});
