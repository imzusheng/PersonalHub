import type { HostSnapshot, CapabilitySummary } from '../connector/connector.js';
import type { PluginRegistry } from '../domain/plugin-registry.js';
import type { CapabilityRegistry } from '../domain/capability-registry.js';
import { randomUUID } from 'node:crypto';

export interface HostSnapshotConfig {
  hostId?: string;
  name?: string;
  version?: string;
  mode?: string;
  startedAt?: string;
}

const DEFAULT_NAME = 'PersonalHub';
const DEFAULT_VERSION = '0.1.0';
const DEFAULT_MODE = 'local-only';

export function createHostSnapshot(
  pluginRegistry: PluginRegistry,
  capRegistry: CapabilityRegistry,
  config: HostSnapshotConfig = {},
): HostSnapshot {
  const plugins = pluginRegistry.list();
  const caps = capRegistry.list();
  return {
    hostId: config.hostId ?? randomUUID(),
    name: config.name ?? DEFAULT_NAME,
    version: config.version ?? DEFAULT_VERSION,
    mode: config.mode ?? DEFAULT_MODE,
    platform: process.platform,
    startedAt: config.startedAt ?? new Date().toISOString(),
    status: 'running',
    pluginCount: plugins.length,
    capabilityCount: caps.length,
  };
}

export function toCapabilitySummaries(
  capRegistry: CapabilityRegistry,
): CapabilitySummary[] {
  return capRegistry.list().map((c) => ({
    name: c.name,
    pluginId: c.pluginId,
    description: c.description,
  }));
}
