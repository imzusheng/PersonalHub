import { describe, it, expect, beforeEach } from 'vitest';
import { PluginRegistry } from '../../../src/core/domain/plugin-registry.js';
import { CapabilityRegistry } from '../../../src/core/domain/capability-registry.js';
import { parsePluginManifest, type PluginManifest } from '../../../src/core/domain/plugin-manifest.js';

function makeMockManifest(id: string, capName: string = 'image.describe'): PluginManifest {
  const result = parsePluginManifest({
    id,
    name: `Mock ${id}`,
    version: '0.1.0',
    runtime: 'mock',
    capabilities: [
      {
        name: capName,
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
  });
  if (!result.success) throw new Error('manifest parse failed');
  return result.data;
}

describe('PluginRegistry', () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it('can register a valid plugin', () => {
    const manifest = makeMockManifest('vision.mock');
    const result = registry.register(manifest);
    expect(result.success).toBe(true);
  });

  it('can list registered plugins', () => {
    registry.register(makeMockManifest('vision.mock'));
    const plugins = registry.list();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe('vision.mock');
  });

  it('can find a plugin by id', () => {
    registry.register(makeMockManifest('vision.mock'));
    const plugin = registry.findById('vision.mock');
    expect(plugin).toBeDefined();
    expect(plugin?.id).toBe('vision.mock');
  });

  it('returns undefined for non-existent plugin id', () => {
    const plugin = registry.findById('nonexistent');
    expect(plugin).toBeUndefined();
  });

  it('fails when registering duplicate plugin id', () => {
    registry.register(makeMockManifest('vision.mock'));
    const result = registry.register(makeMockManifest('vision.mock'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PLUGIN_ALREADY_EXISTS');
    }
  });

  it('initial registry returns empty list', () => {
    expect(registry.list()).toHaveLength(0);
  });
});

describe('CapabilityRegistry', () => {
  let pluginRegistry: PluginRegistry;
  let capRegistry: CapabilityRegistry;

  beforeEach(() => {
    pluginRegistry = new PluginRegistry();
    capRegistry = new CapabilityRegistry(pluginRegistry);
  });

  it('can query capabilities after registering a plugin', () => {
    pluginRegistry.register(makeMockManifest('vision.mock', 'image.describe'));
    const caps = capRegistry.list();
    expect(caps).toHaveLength(1);
    expect(caps[0].name).toBe('image.describe');
  });

  it('can register multiple plugins with different capabilities', () => {
    pluginRegistry.register(makeMockManifest('vision.mock', 'image.describe'));
    pluginRegistry.register(makeMockManifest('asr.mock', 'audio.transcribe'));
    expect(capRegistry.list()).toHaveLength(2);
  });

  it('rejects duplicate capability names from different plugins', () => {
    pluginRegistry.register(makeMockManifest('vision.mock', 'image.describe'));
    const result = pluginRegistry.register(makeMockManifest('vision.other', 'image.describe'));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CAPABILITY_ALREADY_EXISTS');
    }
  });

  it('can find a capability by name', () => {
    pluginRegistry.register(makeMockManifest('vision.mock', 'image.describe'));
    const cap = capRegistry.findByName('image.describe');
    expect(cap).toBeDefined();
    expect(cap?.pluginId).toBe('vision.mock');
    expect(cap?.name).toBe('image.describe');
  });

  it('returns undefined for non-existent capability', () => {
    const cap = capRegistry.findByName('nonexistent.capability');
    expect(cap).toBeUndefined();
  });

  it('returns empty array when no plugins registered', () => {
    expect(capRegistry.list()).toHaveLength(0);
  });
});
