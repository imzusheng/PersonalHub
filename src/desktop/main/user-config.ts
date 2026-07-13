import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const CONFIG_FILE_NAME = 'config.json';
const DEFAULT_AGENT_INTERVAL_MS = 30_000;
const MIN_AGENT_INTERVAL_MS = 1_000;

interface PersistedUserConfig {
  hostId?: string;
  name?: string;
  serverUrl?: string;
  apiKey?: string;
  agentIntervalMs?: number;
  startOnLogin?: boolean;
  logRetentionDays?: number;
}

export interface UserConfig {
  hostId: string;
  name: string;
  serverUrl: string | null;
  apiKey: string | null;
  agentIntervalMs: number;
  startOnLogin: boolean;
  logRetentionDays: number;
}

function readConfig(configFile: string): PersistedUserConfig {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as PersistedUserConfig : {};
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new Error(`读取 PersonalHub 配置失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeInterval(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_AGENT_INTERVAL_MS
    ? value
    : DEFAULT_AGENT_INTERVAL_MS;
}

function normalizeRetentionDays(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 90 ? value : 7;
}

function normalizeServerUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PersonalHub Server URL 必须使用 HTTP 或 HTTPS');
  return url.toString().replace(/\/$/, '');
}

export function loadUserConfig(userDataPath: string): UserConfig {
  const configFile = path.join(userDataPath, CONFIG_FILE_NAME);
  const persisted = readConfig(configFile);
  const config: UserConfig = {
    hostId: persisted.hostId || randomUUID(),
    name: persisted.name?.trim() || 'PersonalHub',
    serverUrl: normalizeServerUrl(process.env.PERSONALHUB_SERVER_URL ?? persisted.serverUrl),
    apiKey: process.env.PERSONALHUB_API_KEY?.trim() || persisted.apiKey?.trim() || null,
    agentIntervalMs: normalizeInterval(Number(process.env.PERSONALHUB_AGENT_INTERVAL_MS) || persisted.agentIntervalMs),
    startOnLogin: persisted.startOnLogin ?? false,
    logRetentionDays: normalizeRetentionDays(persisted.logRetentionDays),
  };
  saveUserConfig(userDataPath, config);
  return config;
}

export function saveUserConfig(userDataPath: string, config: UserConfig): void {
  fs.mkdirSync(userDataPath, { recursive: true });
  const configFile = path.join(userDataPath, CONFIG_FILE_NAME);
  const temporaryFile = `${configFile}.tmp`;
  const payload: PersistedUserConfig = {
    hostId: config.hostId,
    name: config.name,
    serverUrl: config.serverUrl ?? undefined,
    apiKey: config.apiKey ?? undefined,
    agentIntervalMs: config.agentIntervalMs,
    startOnLogin: config.startOnLogin,
    logRetentionDays: config.logRetentionDays,
  };
  fs.writeFileSync(temporaryFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
  fs.renameSync(temporaryFile, configFile);
}

export function updateUserConfig(userDataPath: string, current: UserConfig, patch: Partial<Omit<UserConfig, 'hostId'>>): UserConfig {
  const next: UserConfig = {
    hostId: current.hostId,
    name: patch.name?.trim() || current.name,
    serverUrl: patch.serverUrl === undefined ? current.serverUrl : normalizeServerUrl(patch.serverUrl ?? undefined),
    apiKey: patch.apiKey === undefined ? current.apiKey : (patch.apiKey?.trim() || null),
    agentIntervalMs: patch.agentIntervalMs === undefined ? current.agentIntervalMs : normalizeInterval(patch.agentIntervalMs),
    startOnLogin: patch.startOnLogin ?? current.startOnLogin,
    logRetentionDays: patch.logRetentionDays === undefined ? current.logRetentionDays : normalizeRetentionDays(patch.logRetentionDays),
  };
  saveUserConfig(userDataPath, next);
  return next;
}
