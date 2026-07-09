import type { FastifyPluginAsync } from 'fastify';
import type { TaskRouter } from '../../domain/task-router.js';

export interface TasksRouteDeps {
  taskRouter: TaskRouter;
}

export const tasksRoutes: FastifyPluginAsync<TasksRouteDeps> = async (app, opts) => {
  app.get('/', async () => {
    return opts.taskRouter.listTasks();
  });

  app.post('/', async (req, reply) => {
    const body = req.body as { capability?: string; input?: unknown } | null;
    if (!body?.capability) {
      reply.status(400);
      return { error: { code: 'INVALID_TASK_INPUT', message: 'capability is required' } };
    }

    const result = await opts.taskRouter.createTask({
      capability: body.capability,
      input: body.input ?? {},
    });

    if (!result.success) {
      const code = result.error.code;
      reply.status(code === 'CAPABILITY_NOT_FOUND' ? 400 : 400);
      return { error: result.error };
    }

    reply.status(202);
    return result.task;
  });

  app.get('/:taskId', async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const task = opts.taskRouter.getTask(taskId);
    if (!task) {
      reply.status(404);
      return { error: { code: 'TASK_NOT_FOUND', message: `Task "${taskId}" not found` } };
    }
    return task;
  });

  app.post('/:taskId/execute', async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    const result = await opts.taskRouter.executeTask(taskId);
    if (!result.success && result.error.code === 'TASK_NOT_FOUND') {
      reply.status(404);
      return { error: result.error };
    }
    return result.task;
  });
};
