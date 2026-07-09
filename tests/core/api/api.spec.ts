import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createApiServer, type ApiServerDeps } from '../../../src/core/api/server.js';
import { PluginRegistry } from '../../../src/core/domain/plugin-registry.js';
import { CapabilityRegistry } from '../../../src/core/domain/capability-registry.js';
import { TaskStore } from '../../../src/core/domain/task-store.js';
import { TaskRouter } from '../../../src/core/domain/task-router.js';
import { MockRuntime } from '../../../src/core/runtime/mock-runtime.js';

function makeDeps(): ApiServerDeps {
  const pluginRegistry = new PluginRegistry();
  const capRegistry = new CapabilityRegistry(pluginRegistry);
  const taskStore = new TaskStore();
  const mockRuntime = new MockRuntime();
  const runtimes = new Map();
  runtimes.set('mock', mockRuntime);
  const taskRouter = new TaskRouter({ pluginRegistry, capabilityRegistry: capRegistry, taskStore, runtimes });
  return { pluginRegistry, capabilityRegistry: capRegistry, taskRouter, startedAt: new Date().toISOString() };
}

const mockManifest = {
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
};

describe('API Health', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApiServer(makeDeps());
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/health returns 200 with ok=true', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.name).toBe('PersonalHub');
    expect(body.mode).toBe('local-only');
  });
});

describe('API Plugins', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApiServer(makeDeps());
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('initial GET /v1/plugins returns empty array', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/plugins' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('POST /v1/plugins/register registers a mock plugin', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plugins/register',
      payload: { manifest: mockManifest },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBe('vision.mock');
    expect(body.name).toBe('Mock Vision');
  });

  it('GET /v1/plugins shows registered plugin after register', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/plugins' });
    expect(res.statusCode).toBe(200);
    const plugins = res.json();
    expect(plugins.some((p: { id: string }) => p.id === 'vision.mock')).toBe(true);
  });

  it('duplicate plugin id returns 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plugins/register',
      payload: { manifest: mockManifest },
    });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('PLUGIN_ALREADY_EXISTS');
  });

  it('invalid manifest returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/plugins/register',
      payload: { manifest: { name: 'No ID' } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('INVALID_MANIFEST');
  });
});

describe('API Capabilities', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApiServer(makeDeps());
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns empty array when no plugins registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('returns image.describe after registering mock vision plugin', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/plugins/register',
      payload: { manifest: mockManifest },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });
    expect(res.statusCode).toBe(200);
    const caps = res.json();
    expect(caps.some((c: { name: string }) => c.name === 'image.describe')).toBe(true);
    expect(caps[0].pluginId).toBe('vision.mock');
  });
});

describe('API Tasks', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const deps = makeDeps();
    app = await createApiServer(deps);
    await app.listen({ port: 0, host: '127.0.0.1' });
    await app.inject({
      method: 'POST',
      url: '/v1/plugins/register',
      payload: { manifest: mockManifest },
    });
  });

  it('creates a task for image.describe', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: {
        capability: 'image.describe',
        input: { imageUrl: 'file://test.png' },
      },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.taskId).toBeDefined();
    expect(body.status).toBe('queued');
    expect(body.capability).toBe('image.describe');
  });

  it('can GET task by taskId after creation', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { capability: 'image.describe', input: { imageUrl: 'file://test.png' } },
    });
    const { taskId } = createRes.json();
    const res = await app.inject({ method: 'GET', url: `/v1/tasks/${taskId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.taskId).toBe(taskId);
  });

  it('succeeded task contains output.description', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { capability: 'image.describe', input: { imageUrl: 'file://test.png' } },
    });
    const { taskId } = createRes.json();
    const res = await app.inject({ method: 'POST', url: `/v1/tasks/${taskId}/execute` });
    expect(res.statusCode).toBe(200);
    const executed = res.json();
    expect(executed.status).toBe('succeeded');
    expect(executed.output.description).toBe('Mock description for file://test.png');
  });

  it('capability not found returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { capability: 'nonexistent', input: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CAPABILITY_NOT_FOUND');
  });

  it('input missing imageUrl returns 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tasks',
      payload: { capability: 'image.describe', input: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_TASK_INPUT');
  });

  it('taskId not found returns 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/tasks/nonexistent' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('TASK_NOT_FOUND');
  });
});
