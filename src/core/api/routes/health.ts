import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync<{ startedAt: string }> = async (app, opts) => {
  app.get('/health', async () => {
    return {
      ok: true,
      name: 'PersonalHub',
      mode: 'local-only' as const,
      startedAt: opts.startedAt,
    };
  });
};
