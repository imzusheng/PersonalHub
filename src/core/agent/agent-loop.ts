import type { Connector, PluginServiceSnapshot, RemoteCommand, RemoteTask, TaskResult } from '../connector/connector.js';
import type { PluginRegistry } from '../domain/plugin-registry.js';
import type { CapabilityRegistry } from '../domain/capability-registry.js';
import type { TaskRouter } from '../domain/task-router.js';
import { createHostSnapshot, toCapabilitySummaries } from './host-snapshot.js';
import { collectHostMetrics } from './host-metrics.js';

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
  private registered = false;
  private publishedCapabilitiesSignature: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlightTick: Promise<TickResult> | null = null;

  constructor(deps: AgentLoopDeps) {
    this.deps = deps;
  }

  async tick(): Promise<TickResult> {
    if (this.inFlightTick) return this.inFlightTick;
    this.inFlightTick = this.runTick().finally(() => {
      this.inFlightTick = null;
    });
    return this.inFlightTick;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
      throw new Error('AgentLoop 间隔必须是不小于 1000ms 的整数');
    }
    void this.tick();
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlightTick;
    if (this.deps.connector.reportStopped) {
      await this.deps.connector.reportStopped(await this.buildPluginServices('offline'));
    }
    this.registered = false;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  private async runTick(): Promise<TickResult> {
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

      if (!this.registered) {
        await this.deps.connector.registerHost(snapshot);
        this.registered = true;
      }

      await this.deps.connector.sendHeartbeat(snapshot);
      result.heartbeatSent = true;

      if (this.deps.connector.publishMetrics) {
        await this.deps.connector.publishMetrics(await collectHostMetrics());
      }

      if (this.deps.connector.syncPluginServices) {
        await this.deps.connector.syncPluginServices(await this.buildPluginServices());
      }

      const caps = toCapabilitySummaries(this.deps.capabilityRegistry);
      const capabilitiesSignature = JSON.stringify(caps);
      if (capabilitiesSignature !== this.publishedCapabilitiesSignature) {
        await this.deps.connector.publishCapabilities(caps);
        this.publishedCapabilitiesSignature = capabilitiesSignature;
        result.capabilitiesPublished = true;
      }

      if (this.deps.connector.pullCommands && this.deps.connector.completeCommand) {
        const commands = await this.deps.connector.pullCommands();
        for (const command of commands) await this.processCommand(command);
      }

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

  private async buildPluginServices(forceStatus?: 'offline'): Promise<PluginServiceSnapshot[]> {
    return Promise.all(this.deps.pluginRegistry.list().map(async (plugin) => {
      const health = forceStatus ? { ok: false, message: '远程调度已停止' } : await this.deps.taskRouter.checkPluginHealth(plugin.id);
      return {
        serviceId: `${plugin.id}:${this.deps.hostId ?? 'local'}`,
        kind: plugin.id,
        name: plugin.name,
        version: plugin.version,
        status: forceStatus ?? (health.ok ? 'running' : 'error'),
        controlMode: 'observable',
        capabilities: plugin.capabilities.map((capability) => capability.name),
        ...(!health.ok && health.message ? { healthError: health.message } : {}),
      };
    }));
  }

  private async processCommand(command: RemoteCommand): Promise<void> {
    await this.deps.connector.completeCommand?.(command.commandId, false, `PersonalHub 不支持命令: ${command.type}`);
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
      await this.deps.connector.markTaskRunning?.(remoteTask.remoteTaskId);
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

      const renewLease = this.deps.connector.renewTaskLease?.bind(this.deps.connector);
      const renewTimer = renewLease
        ? setInterval(() => {
          void renewLease(remoteTask.remoteTaskId).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            return this.deps.connector.reportError({ message: `任务续租失败: ${message}` });
          });
        }, 30_000)
        : null;
      const execResult = await this.deps.taskRouter.executeTask(createResult.task.taskId).finally(() => {
        if (renewTimer) clearInterval(renewTimer);
      });
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
