import type { PluginRegistry, RegisteredPlugin } from './plugin-registry.js';

export interface CapabilityEntry {
  name: string;
  pluginId: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  description?: string;
}

export class CapabilityRegistry {
  private readonly pluginRegistry: PluginRegistry;

  constructor(pluginRegistry: PluginRegistry) {
    this.pluginRegistry = pluginRegistry;
  }

  list(): CapabilityEntry[] {
    const caps: CapabilityEntry[] = [];
    for (const plugin of this.pluginRegistry.list()) {
      for (const cap of plugin.capabilities) {
        caps.push({
          name: cap.name,
          pluginId: plugin.id,
          inputSchema: cap.inputSchema,
          outputSchema: cap.outputSchema,
          description: cap.description,
        });
      }
    }
    return caps;
  }

  findByName(name: string): CapabilityEntry | undefined {
    return this.list().find((c) => c.name === name);
  }

  hasCapability(name: string): boolean {
    return this.pluginRegistry.hasCapability(name);
  }

  getPluginForCapability(name: string): RegisteredPlugin | undefined {
    const pluginId = this.pluginRegistry.getPluginIdForCapability(name);
    if (!pluginId) return undefined;
    return this.pluginRegistry.findById(pluginId);
  }
}
