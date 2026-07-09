import type { PluginManifest, PluginCapability } from './plugin-manifest.js';

export interface RegisteredPlugin {
  id: string;
  name: string;
  version: string;
  runtime: string;
  capabilities: PluginCapability[];
  description?: string;
}

export type RegisterResult =
  | { success: true; plugin: RegisteredPlugin }
  | { success: false; error: PluginRegistryError };

export interface PluginRegistryError {
  code: 'PLUGIN_ALREADY_EXISTS' | 'CAPABILITY_ALREADY_EXISTS';
  message: string;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, RegisteredPlugin>();
  private readonly capabilityToPlugin = new Map<string, string>();

  register(manifest: PluginManifest): RegisterResult {
    if (this.plugins.has(manifest.id)) {
      return {
        success: false,
        error: {
          code: 'PLUGIN_ALREADY_EXISTS',
          message: `Plugin with id "${manifest.id}" is already registered`,
        },
      };
    }

    for (const cap of manifest.capabilities) {
      if (this.capabilityToPlugin.has(cap.name)) {
        return {
          success: false,
          error: {
            code: 'CAPABILITY_ALREADY_EXISTS',
            message: `Capability "${cap.name}" is already registered by another plugin`,
          },
        };
      }
    }

    const plugin: RegisteredPlugin = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      runtime: manifest.runtime,
      capabilities: manifest.capabilities,
      description: manifest.description,
    };

    this.plugins.set(manifest.id, plugin);
    for (const cap of manifest.capabilities) {
      this.capabilityToPlugin.set(cap.name, manifest.id);
    }

    return { success: true, plugin };
  }

  list(): RegisteredPlugin[] {
    return Array.from(this.plugins.values());
  }

  findById(id: string): RegisteredPlugin | undefined {
    return this.plugins.get(id);
  }

  hasCapability(name: string): boolean {
    return this.capabilityToPlugin.has(name);
  }

  getPluginIdForCapability(name: string): string | undefined {
    return this.capabilityToPlugin.get(name);
  }
}
