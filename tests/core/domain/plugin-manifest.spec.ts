import { describe, it, expect } from 'vitest';
import { isRuntimeSupportedOnPlatform, parsePluginManifest, type PluginManifest } from '../../../src/core/domain/plugin-manifest.js';

describe('plugin-manifest', () => {
  it('only enables WSL runtimes on Windows', () => {
    expect(isRuntimeSupportedOnPlatform('wsl-docker', 'win32')).toBe(true);
    expect(isRuntimeSupportedOnPlatform('wsl-docker', 'darwin')).toBe(false);
    expect(isRuntimeSupportedOnPlatform('wsl', 'linux')).toBe(false);
    expect(isRuntimeSupportedOnPlatform('python-venv', 'darwin')).toBe(true);
  });

  const validManifest: PluginManifest = {
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
          properties: {
            imageUrl: { type: 'string' },
          },
        },
        outputSchema: {
          type: 'object',
          required: ['description'],
          properties: {
            description: { type: 'string' },
          },
        },
      },
    ],
    healthcheck: {
      type: 'mock',
    },
  };

  it('valid manifest passes validation', () => {
    const result = parsePluginManifest(validManifest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('vision.mock');
      expect(result.data.capabilities).toHaveLength(1);
    }
  });

  it('accepts schemaVersion 1 with deployment metadata', () => {
    const result = parsePluginManifest({
      ...validManifest,
      schemaVersion: 1,
      deployment: { type: 'dockerfile', dockerfile: 'Dockerfile', context: '.' },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.deployment?.type).toBe('dockerfile');
  });

  it('keeps legacy manifests compatible when schemaVersion is omitted', () => {
    expect(parsePluginManifest(validManifest).success).toBe(true);
  });

  it('fails when id is missing', () => {
    const { id: _, ...rest } = validManifest;
    const result = parsePluginManifest(rest);
    expect(result.success).toBe(false);
  });

  it('fails when name is missing', () => {
    const { name: _, ...rest } = validManifest;
    const result = parsePluginManifest(rest);
    expect(result.success).toBe(false);
  });

  it('fails when version is missing', () => {
    const { version: _, ...rest } = validManifest;
    const result = parsePluginManifest(rest);
    expect(result.success).toBe(false);
  });

  it('fails when runtime is not an allowed value', () => {
    const result = parsePluginManifest({
      ...validManifest,
      runtime: 'unknown-runtime',
    });
    expect(result.success).toBe(false);
  });

  it('fails when capabilities array is empty', () => {
    const result = parsePluginManifest({
      ...validManifest,
      capabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it('fails when capability is missing name', () => {
    const result = parsePluginManifest({
      ...validManifest,
      capabilities: [
        {
          ...validManifest.capabilities[0],
          name: '',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('fails when capability names are duplicated', () => {
    const result = parsePluginManifest({
      ...validManifest,
      capabilities: [
        validManifest.capabilities[0],
        { ...validManifest.capabilities[0] },
      ],
    });
    expect(result.success).toBe(false);
  });
});
