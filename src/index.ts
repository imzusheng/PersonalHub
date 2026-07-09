import { createPersonalHub } from './core/app.js';
import { parsePluginManifest } from './core/domain/plugin-manifest.js';

const MOCK_VISION_MANIFEST = {
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
};

async function main(): Promise<void> {
  const hub = await createPersonalHub({
    hostId: 'local-dev',
    name: 'PersonalHub',
  });

  const result = parsePluginManifest(MOCK_VISION_MANIFEST);
  if (result.success) {
    hub.pluginRegistry.register(result.data);
    console.log('Registered mock vision plugin');
  }

  console.log(`PersonalHub running at http://${hub.apiHost}:${hub.apiPort}`);
  console.log(`  GET  /v1/health`);
  console.log(`  GET  /v1/plugins`);
  console.log(`  POST /v1/plugins/register`);
  console.log(`  GET  /v1/capabilities`);
  console.log(`  POST /v1/tasks`);
  console.log(`  GET  /v1/tasks/:taskId`);
  console.log('Press Ctrl+C to stop');

  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await hub.stop();
    process.exit(0);
  });
}

main().catch(console.error);
