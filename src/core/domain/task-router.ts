import type { PluginRegistry } from './plugin-registry.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { TaskStore } from './task-store.js';
import type { Task } from './task.js';
import { validateInput, type SimpleJsonSchema } from './task.js';
import type { RuntimeAdapter } from '../runtime/runtime-adapter.js';

export type CreateTaskResult =
  | { success: true; task: Task }
  | { success: false; error: TaskRouterError };

export type ExecuteTaskOutcome =
  | { success: true; task: Task }
  | { success: false; task: Task; error: TaskRouterError };

export interface TaskRouterError {
  code: 'CAPABILITY_NOT_FOUND' | 'INVALID_TASK_INPUT' | 'RUNTIME_NOT_FOUND' | 'TASK_NOT_FOUND' | 'TASK_FAILED';
  message: string;
}

export interface CreateTaskParams {
  capability: string;
  input: unknown;
}

export interface TaskRouterDeps {
  pluginRegistry: PluginRegistry;
  capabilityRegistry: CapabilityRegistry;
  taskStore: TaskStore;
  runtimes: Map<string, RuntimeAdapter>;
}

export class TaskRouter {
  private readonly deps: TaskRouterDeps;

  constructor(deps: TaskRouterDeps) {
    this.deps = deps;
  }

  async createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
    const cap = this.deps.capabilityRegistry.findByName(params.capability);
    if (!cap) {
      return {
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: `Capability "${params.capability}" is not registered`,
        },
      };
    }

    const plugin = this.deps.pluginRegistry.findById(cap.pluginId);
    if (!plugin) {
      return {
        success: false,
        error: {
          code: 'CAPABILITY_NOT_FOUND',
          message: `Capability "${params.capability}" has no registered plugin`,
        },
      };
    }

    const capDef = plugin.capabilities.find((c) => c.name === params.capability);
    const validation = validateInput(capDef?.inputSchema as SimpleJsonSchema | undefined, params.input);
    if (!validation.valid) {
      return {
        success: false,
        error: {
          code: 'INVALID_TASK_INPUT',
          message: validation.errors.join('; '),
        },
      };
    }

    const task = this.deps.taskStore.create({
      capability: params.capability,
      pluginId: plugin.id,
      input: params.input,
    });

    return { success: true, task };
  }

  async executeTask(taskId: string): Promise<ExecuteTaskOutcome> {
    const task = this.deps.taskStore.findById(taskId);
    if (!task) {
      return {
        success: false,
        task: {
          taskId,
          capability: '',
          pluginId: '',
          input: null,
          status: 'failed',
          output: null,
          error: { message: 'Task not found' },
          createdAt: '',
          updatedAt: '',
        },
        error: {
          code: 'TASK_NOT_FOUND',
          message: `Task "${taskId}" not found`,
        },
      };
    }

    this.deps.taskStore.update(taskId, { status: 'running' });

    const plugin = this.deps.pluginRegistry.findById(task.pluginId);
    if (!plugin) {
      const updated = this.deps.taskStore.update(taskId, {
        status: 'failed',
        error: { message: `Plugin "${task.pluginId}" not found` },
      })!;
      return {
        success: false,
        task: updated,
        error: { code: 'TASK_FAILED', message: `Plugin "${task.pluginId}" not found` },
      };
    }

    const runtime = this.deps.runtimes.get(plugin.runtime);
    if (!runtime) {
      const updated = this.deps.taskStore.update(taskId, {
        status: 'failed',
        error: { message: `Runtime "${plugin.runtime}" not found` },
      })!;
      return {
        success: false,
        task: updated,
        error: { code: 'RUNTIME_NOT_FOUND', message: `Runtime "${plugin.runtime}" not found` },
      };
    }

    try {
      const result = await runtime.executeTask({
        capability: task.capability,
        input: task.input,
        plugin,
      });
      const updated = this.deps.taskStore.update(taskId, {
        status: 'succeeded',
        output: result.output,
      })!;
      return { success: true, task: updated };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const updated = this.deps.taskStore.update(taskId, {
        status: 'failed',
        error: { message, details: err },
      })!;
      return {
        success: false,
        task: updated,
        error: { code: 'TASK_FAILED', message },
      };
    }
  }

  getTask(taskId: string): Task | undefined {
    return this.deps.taskStore.findById(taskId);
  }

  listTasks(): Task[] {
    return this.deps.taskStore.list();
  }

  async checkPluginHealth(pluginId: string): Promise<{ ok: boolean; message?: string }> {
    const plugin = this.deps.pluginRegistry.findById(pluginId);
    if (!plugin) return { ok: false, message: `Plugin "${pluginId}" not found` };
    const runtime = this.deps.runtimes.get(plugin.runtime);
    if (!runtime) return { ok: false, message: `Runtime "${plugin.runtime}" not found` };
    return runtime.healthCheck(plugin);
  }
}
