import type { Task, TaskUpdate } from '../domain/task.js';
import { randomUUID } from 'node:crypto';

export class TaskStore {
  private readonly tasks = new Map<string, Task>();

  create(params: {
    capability: string;
    pluginId: string;
    input: unknown;
  }): Task {
    const now = new Date().toISOString();
    const task: Task = {
      taskId: randomUUID(),
      capability: params.capability,
      pluginId: params.pluginId,
      input: params.input,
      status: 'queued',
      output: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    return task;
  }

  findById(taskId: string): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    return { ...task };
  }

  update(taskId: string, update: TaskUpdate): Task | undefined {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;

    const updated: Task = {
      ...task,
      ...update,
      updatedAt: new Date().toISOString(),
    };
    this.tasks.set(taskId, updated);
    return { ...updated };
  }

  list(): Task[] {
    return Array.from(this.tasks.values()).map((t) => ({ ...t }));
  }
}
