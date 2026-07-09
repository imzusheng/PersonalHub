import type { Connector, RemoteTask, TaskResult } from '../connector/connector.js';
import type { PluginRegistry } from '../domain/plugin-registry.js';
import type { CapabilityRegistry } from '../domain/capability-registry.js';
import type { TaskRouter } from '../domain/task-router.js';
import { createHostSnapshot, toCapabilitySummaries } from './host-snapshot.js';

export interface AgentLoopDeps {
  connector: Connector;
  pluginRegistry: PluginRegistry;
  capabilityRegistry: CapabilityRegistry;
  taskRouter: TaskRouter;
  startedAt: string;
  hostId?: string;
  name?: string;
  version?: string;
  mode?: string;
}

export interface TickResult {
  heartbeatSent: boolean;
  capabilitiesPublished: boolean;
  tasksProcessed: number;
  succeeded: number;
  failed: number;
  errors: number;
}

export class AgentLoop {
  private readonly deps: AgentLoopDeps;
  private lastTick: TickResult | null = null;
  private lastTickAt: string | null = null;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
  }

  async tick(): Promise<TickResult> {
    const result: TickResult = {
      heartbeatSent: false,
      capabilitiesPublished: false,
      tasksProcessed: 0,
      succeeded: 0,
      failed: 0,
      errors: 0,
    };

    try {
      const snapshot = createHostSnapshot(
        this.deps.pluginRegistry,
        this.deps.capabilityRegistry,
        {
          startedAt: this.deps.startedAt,
          hostId: this.deps.hostId,
          name: this.deps.name,
          version: this.deps.version,
          mode: this.deps.mode,
        },
      );

      await this.deps.connector.sendHeartbeat(snapshot);
      result.heartbeatSent = true;

      const caps = toCapabilitySummaries(this.deps.capabilityRegistry);
      await this.deps.connector.publishCapabilities(caps);
      result.capabilitiesPublished = true;

      const remoteTasks = await this.deps.connector.pullTasks();
      result.tasksProcessed = remoteTasks.length;

      for (const remoteTask of remoteTasks) {
        await this.processRemoteTask(remoteTask, result);
      }
    } catch (err) {
      result.errors += 1;
      const message = err instanceof Error ? err.message : String(err);
      try {
        await this.deps.connector.reportError({ message, details: err });
      } catch {
        // 防递归：reportError 失败不再上报，只丢弃
      }
    }

    this.lastTick = result;
    this.lastTickAt = new Date().toISOString();
    return result;
  }

  private async processRemoteTask(remoteTask: RemoteTask, result: TickResult): Promise<void> {
    const taskResult: TaskResult = {
      remoteTaskId: remoteTask.remoteTaskId,
      localTaskId: null,
      status: 'failed',
      output: null,
      error: { message: '' },
    };

    try {
      const createResult = await this.deps.taskRouter.createTask({
        capability: remoteTask.capability,
        input: remoteTask.input,
      });

      if (!createResult.success) {
        taskResult.error = { message: createResult.error.message };
        await this.deps.connector.pushTaskResult(taskResult);
        result.failed += 1;
        return;
      }

      taskResult.localTaskId = createResult.task.taskId;

      const execResult = await this.deps.taskRouter.executeTask(createResult.task.taskId);
      if (execResult.success) {
        taskResult.status = 'succeeded';
        taskResult.output = execResult.task.output;
        taskResult.error = null;
        result.succeeded += 1;
      } else {
        taskResult.status = 'failed';
        taskResult.error = { message: execResult.error.message };
        result.failed += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      taskResult.status = 'failed';
      taskResult.error = { message, details: err };
      result.failed += 1;
    }

    await this.deps.connector.pushTaskResult(taskResult);
  }

  getLastTick(): TickResult | null {
    return this.lastTick;
  }

  getLastTickAt(): string | null {
    return this.lastTickAt;
  }
}
