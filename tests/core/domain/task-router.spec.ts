import { describe, it, expect, beforeEach } from 'vitest';
import { PluginRegistry } from '../../../src/core/domain/plugin-registry.js';
import { CapabilityRegistry } from '../../../src/core/domain/capability-registry.js';
import { TaskStore } from '../../../src/core/domain/task-store.js';
import { TaskRouter } from '../../../src/core/domain/task-router.js';
import { MockRuntime } from '../../../src/core/runtime/mock-runtime.js';
import { parsePluginManifest } from '../../../src/core/domain/plugin-manifest.js';
import type { RuntimeAdapter } from '../../../src/core/runtime/runtime-adapter.js';
import { validateInput, type SimpleJsonSchema } from '../../../src/core/domain/task.js';

function setupVisionPlugin() {
  const pluginRegistry = new PluginRegistry();
  const capRegistry = new CapabilityRegistry(pluginRegistry);
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
  return { pluginRegistry, capRegistry };
}

describe('TaskStore', () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it('creates a task and returns it with a unique taskId', () => {
    const task = store.create({
      capability: 'image.describe',
      pluginId: 'vision.mock',
      input: { imageUrl: 'file://test.png' },
    });
    expect(task.taskId).toBeDefined();
    expect(task.status).toBe('queued');
    expect(task.capability).toBe('image.describe');
  });

  it('generates unique taskIds', () => {
    const t1 = store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    const t2 = store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    expect(t1.taskId).not.toBe(t2.taskId);
  });

  it('can find a task by taskId', () => {
    const task = store.create({
      capability: 'image.describe',
      pluginId: 'vision.mock',
      input: { imageUrl: 'file://test.png' },
    });
    const found = store.findById(task.taskId);
    expect(found).toBeDefined();
    expect(found?.taskId).toBe(task.taskId);
  });

  it('returns undefined for non-existent taskId', () => {
    expect(store.findById('nonexistent')).toBeUndefined();
  });

  it('can update task status and output', () => {
    const task = store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    store.update(task.taskId, { status: 'running' });
    store.update(task.taskId, { status: 'succeeded', output: { description: 'hello' } });
    const found = store.findById(task.taskId);
    expect(found?.status).toBe('succeeded');
    expect(found?.output).toEqual({ description: 'hello' });
  });

  it('can update task to failed with error', () => {
    const task = store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    store.update(task.taskId, { status: 'failed', error: { message: 'boom' } });
    const found = store.findById(task.taskId);
    expect(found?.status).toBe('failed');
    expect(found?.error?.message).toBe('boom');
  });

  it('updates updatedAt on changes', async () => {
    const task = store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    const oldUpdatedAt = task.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    store.update(task.taskId, { status: 'running' });
    const found = store.findById(task.taskId);
    expect(found?.updatedAt).not.toBe(oldUpdatedAt);
  });

  it('can list all tasks', () => {
    store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    store.create({ capability: 'image.describe', pluginId: 'vision.mock', input: {} });
    expect(store.list()).toHaveLength(2);
  });
});

describe('validateInput', () => {
  it('passes when required fields present', () => {
    const schema: SimpleJsonSchema = { type: 'object', required: ['imageUrl'], properties: { imageUrl: { type: 'string' } } };
    expect(validateInput(schema, { imageUrl: 'test' }).valid).toBe(true);
  });

  it('fails when required field missing', () => {
    const schema: SimpleJsonSchema = { type: 'object', required: ['imageUrl'], properties: { imageUrl: { type: 'string' } } };
    expect(validateInput(schema, {}).valid).toBe(false);
  });

  it('fails when field type mismatch', () => {
    const schema: SimpleJsonSchema = { type: 'object', required: ['imageUrl'], properties: { imageUrl: { type: 'string' } } };
    expect(validateInput(schema, { imageUrl: 123 }).valid).toBe(false);
  });

  it('passes with no required fields', () => {
    const schema: SimpleJsonSchema = { type: 'object', properties: { x: { type: 'number' } } };
    expect(validateInput(schema, {}).valid).toBe(true);
  });
});

describe('TaskRouter', () => {
  let pluginRegistry: PluginRegistry;
  let capRegistry: CapabilityRegistry;
  let taskStore: TaskStore;
  let mockRuntime: MockRuntime;
  let router: TaskRouter;

  beforeEach(() => {
    const setup = setupVisionPlugin();
    pluginRegistry = setup.pluginRegistry;
    capRegistry = setup.capRegistry;
    taskStore = new TaskStore();
    mockRuntime = new MockRuntime();
    const runtimes = new Map<string, RuntimeAdapter>();
    runtimes.set('mock', mockRuntime);
    router = new TaskRouter({
      pluginRegistry,
      capabilityRegistry: capRegistry,
      taskStore,
      runtimes,
    });
  });

  it('creates a task for image.describe and finds the plugin', async () => {
    const result = await router.createTask({
      capability: 'image.describe',
      input: { imageUrl: 'file://test.png' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.pluginId).toBe('vision.mock');
      expect(result.task.capability).toBe('image.describe');
      expect(result.task.status).toBe('queued');
    }
  });

  it('fails when capability does not exist', async () => {
    const result = await router.createTask({
      capability: 'nonexistent.capability',
      input: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CAPABILITY_NOT_FOUND');
    }
  });

  it('fails when input does not match schema', async () => {
    const result = await router.createTask({
      capability: 'image.describe',
      input: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_TASK_INPUT');
    }
  });

  it('executes mock task and marks it succeeded', async () => {
    const createResult = await router.createTask({
      capability: 'image.describe',
      input: { imageUrl: 'file://test.png' },
    });
    if (!createResult.success) throw new Error('create failed');
    const taskId = createResult.task.taskId;

    const execResult = await router.executeTask(taskId);
    expect(execResult.success).toBe(true);
    if (execResult.success) {
      expect(execResult.task.status).toBe('succeeded');
      expect(execResult.task.output).toEqual({ description: 'Mock description for file://test.png' });
    }
  });

  it('marks task as failed when plugin throws', async () => {
    const createResult = await router.createTask({
      capability: 'image.describe',
      input: { imageUrl: 'file://test.png', forceError: true } as Record<string, unknown>,
    });
    if (!createResult.success) throw new Error('create failed');
    const taskId = createResult.task.taskId;

    const execResult = await router.executeTask(taskId);
    expect(execResult.success).toBe(false);
    if (!execResult.success) {
      expect(execResult.task.status).toBe('failed');
      expect(execResult.task.error?.message).toBeDefined();
    }
  });

  it('can query task details by taskId', async () => {
    const createResult = await router.createTask({
      capability: 'image.describe',
      input: { imageUrl: 'file://test.png' },
    });
    if (!createResult.success) throw new Error('create failed');
    const taskId = createResult.task.taskId;
    const task = router.getTask(taskId);
    expect(task).toBeDefined();
    expect(task?.taskId).toBe(taskId);
  });

  it('returns undefined for non-existent taskId', () => {
    expect(router.getTask('nonexistent')).toBeUndefined();
  });
});
