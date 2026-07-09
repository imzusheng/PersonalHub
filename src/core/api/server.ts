import Fastify, { type FastifyInstance } from 'fastify';
import { healthRoutes } from './routes/health.js';
import { pluginsRoutes } from './routes/plugins.js';
import { capabilitiesRoutes } from './routes/capabilities.js';
import { tasksRoutes } from './routes/tasks.js';
import type { PluginRegistry } from '../domain/plugin-registry.js';
import type { CapabilityRegistry } from '../domain/capability-registry.js';
import type { TaskRouter } from '../domain/task-router.js';

export interface ApiServerDeps {
  pluginRegistry: PluginRegistry;
  capabilityRegistry: CapabilityRegistry;
  taskRouter: TaskRouter;
  startedAt: string;
}

export async function createApiServer(deps: ApiServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.register(async (app) => {
    await app.register(healthRoutes, { startedAt: deps.startedAt });
  }, { prefix: '/v1' });

  app.register(async (app) => {
    await app.register(pluginsRoutes, { pluginRegistry: deps.pluginRegistry });
  }, { prefix: '/v1/plugins' });

  app.register(async (app) => {
    await app.register(capabilitiesRoutes, { capabilityRegistry: deps.capabilityRegistry });
  }, { prefix: '/v1/capabilities' });

  app.register(async (app) => {
    await app.register(tasksRoutes, { taskRouter: deps.taskRouter });
  }, { prefix: '/v1/tasks' });

  return app;
}

export async function startApiServer(deps: ApiServerDeps, port: number = 0, host: string = '127.0.0.1'): Promise<{ app: FastifyInstance; port: number; host: string }> {
  const app = await createApiServer(deps);
  await app.listen({ port, host });
  const actualPort = app.server.address() && typeof app.server.address() === 'object' ? (app.server.address() as { port: number }).port : port;
  return { app, port: actualPort, host };
}
