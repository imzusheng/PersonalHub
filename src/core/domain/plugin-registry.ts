import type { PluginManifest, PluginCapability } from './plugin-manifest.js';

export interface RegisteredPlugin {
  id: string;
  name: string;
  version: string;
  runtime: string;
  enabled: boolean;
  capabilities: PluginCapability[];
  description?: string;
  runtimeConfig?: Record<string, unknown>;
  healthcheck?: { type: 'mock' | 'http' | 'process'; [key: string]: unknown };
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
      enabled: true,
      capabilities: manifest.capabilities,
      description: manifest.description,
      runtimeConfig: manifest.runtimeConfig,
      healthcheck: manifest.healthcheck,
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

  /** 只返回已启用的插件 */
  listEnabled(): RegisteredPlugin[] {
    return Array.from(this.plugins.values()).filter((p) => p.enabled);
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

  /** 注销插件，清理 capability 映射。返回被移除的插件，不存在时返回 null。 */
  unregister(id: string): RegisteredPlugin | null {
    const plugin = this.plugins.get(id);
    if (!plugin) return null;
    this.plugins.delete(id);
    for (const cap of plugin.capabilities) {
      this.capabilityToPlugin.delete(cap.name);
    }
    return plugin;
  }

  /** 关闭插件（保留注册，暂停任务路由）。返回 false 如果插件不存在。 */
  disable(id: string): boolean {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;
    plugin.enabled = false;
    return true;
  }

  /** 重新启用已关闭的插件。返回 false 如果插件不存在。 */
  enable(id: string): boolean {
    const plugin = this.plugins.get(id);
    if (!plugin) return false;
    plugin.enabled = true;
    return true;
  }
}
