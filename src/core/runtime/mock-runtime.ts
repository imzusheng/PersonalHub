import type { RuntimeAdapter, ExecuteTaskParams, ExecuteTaskResult, HealthCheckResult } from './runtime-adapter.js';
import type { RegisteredPlugin } from '../domain/plugin-registry.js';

export class MockRuntime implements RuntimeAdapter {
  readonly runtime = 'mock';

  async executeTask(params: ExecuteTaskParams): Promise<ExecuteTaskResult> {
    const input = params.input as Record<string, unknown> | null;
    if (input && typeof input === 'object' && input.forceError === true) {
      throw new Error('Mock runtime forced error');
    }

    switch (params.capability) {
      case 'image.describe': {
        const imageUrl = (input as Record<string, unknown>)?.imageUrl;
        return {
          output: {
            description: `Mock description for ${imageUrl}`,
          },
        };
      }
      case 'audio.transcribe': {
        const audioUrl = (input as Record<string, unknown>)?.audioUrl;
        return {
          output: {
            transcript: `Mock transcript for ${audioUrl}`,
          },
        };
      }
      case 'text.embed': {
        const text = (input as Record<string, unknown>)?.text;
        return {
          output: {
            embedding: [0.1, 0.2, 0.3],
            text,
          },
        };
      }
      default: {
        return {
          output: {
            message: `Mock output for ${params.capability}`,
          },
        };
      }
    }
  }

  async healthCheck(_plugin: RegisteredPlugin): Promise<HealthCheckResult> {
    return { ok: true, message: 'Mock runtime is always healthy' };
  }
}
