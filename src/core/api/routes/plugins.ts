import type { FastifyPluginAsync } from 'fastify';
import type { PluginRegistry } from '../../domain/plugin-registry.js';
import { parsePluginManifest } from '../../domain/plugin-manifest.js';

export interface PluginsRouteDeps {
  pluginRegistry: PluginRegistry;
}

export const pluginsRoutes: FastifyPluginAsync<PluginsRouteDeps> = async (app, opts) => {
  app.get('/', async () => {
    return opts.pluginRegistry.list();
  });

  app.post('/register', async (req, reply) => {
    const body = req.body as { manifest?: unknown } | null;
    if (!body?.manifest) {
      reply.status(400);
      return { error: { code: 'INVALID_MANIFEST', message: 'manifest is required' } };
    }

    const result = parsePluginManifest(body.manifest);
    if (!result.success) {
      reply.status(400);
      return { error: result.error };
    }

    const regResult = opts.pluginRegistry.register(result.data);
    if (!regResult.success) {
      const code = regResult.error.code;
      reply.status(code === 'PLUGIN_ALREADY_EXISTS' || code === 'CAPABILITY_ALREADY_EXISTS' ? 409 : 400);
      return { error: regResult.error };
    }

    reply.status(201);
    return regResult.plugin;
  });
};
