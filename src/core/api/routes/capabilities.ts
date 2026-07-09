import type { FastifyPluginAsync } from 'fastify';
import type { CapabilityRegistry } from '../../domain/capability-registry.js';

export interface CapabilitiesRouteDeps {
  capabilityRegistry: CapabilityRegistry;
}

export const capabilitiesRoutes: FastifyPluginAsync<CapabilitiesRouteDeps> = async (app, opts) => {
  app.get('/', async () => {
    return opts.capabilityRegistry.list();
  });
};
