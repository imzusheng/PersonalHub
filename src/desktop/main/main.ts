import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, clipboard } from 'electron';
import electronUpdater from 'electron-updater';
import { createPersonalHub, type PersonalHubRuntime } from '../../core/app.js';
import { isRuntimeSupportedOnPlatform, parsePluginManifest } from '../../core/domain/plugin-manifest.js';
import { MockControlPlaneConnector } from '../../core/connector/mock-control-plane-connector.js';
import { AdminOSConnector } from '../../core/connector/adminos-connector.js';
import { LocalOnlyConnector } from '../../core/connector/local-only-connector.js';
import type { Connector } from '../../core/connector/connector.js';
import { loadUserConfig, updateUserConfig, type UserConfig } from './user-config.js';
import { GithubUpdateService, type UpdateState } from './github-update-service.js';
import { ArtifactLayer } from '../../core/artifact/artifact-layer.js';
import { collectHostMetrics } from '../../core/agent/host-metrics.js';
import type { HostMetrics } from '../../core/connector/connector.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { autoUpdater } = electronUpdater;

let logFile = '';
let logsPath = '';
let metricsTimer: NodeJS.Timeout | null = null;
let storageCache: { at: number; value: StorageInfo } | null = null;

function fileLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  if (logsPath) logFile = path.join(logsPath, `personalhub-${dateStamp()}.log`);
  try { fs.appendFileSync(logFile, line, 'utf-8'); } catch { /* 静默 */ }
  console.log(`[RENDERER] ${msg}`);
}

let hub: PersonalHubRuntime | null = null;
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let agentIntervalMs = 30_000;
let userConfig: UserConfig | null = null;
let updateService: GithubUpdateService | null = null;
let pluginsPath = '';
let shutdownStarted = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

interface PluginCatalogItem {
  id: string; name: string; version: string; runtime: string; description?: string;
  schemaVersion: number;
  capabilities: Array<{ name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }>;
  deployment?: { type: string; [key: string]: unknown };
  enabled: boolean;
  status: 'registered' | 'disabled' | 'unsupported' | 'error';
  reason?: string;
  directoryPath: string;
}
const pluginCatalog = new Map<string, PluginCatalogItem>();

interface StorageInfo {
  logsPath: string;
  cachePath: string;
  pluginsPath: string;
  logsBytes: number;
  cacheBytes: number;
  pluginsBytes: number;
}

function dateStamp(date = new Date()): string { return date.toISOString().slice(0, 10); }
function metricsFile(date = new Date()): string { return path.join(logsPath, `metrics-${dateStamp(date)}.jsonl`); }

function cleanupDiagnostics(retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  try {
    for (const entry of fs.readdirSync(logsPath, { withFileTypes: true })) {
      if (!entry.isFile() || !/^(personalhub|metrics)-\d{4}-\d{2}-\d{2}\.(log|jsonl)$/.test(entry.name)) continue;
      const target = path.join(logsPath, entry.name);
      if (fs.statSync(target).mtimeMs < cutoff) fs.rmSync(target, { force: true });
    }
  } catch { /* diagnostics cleanup is best effort */ }
}

function persistMetrics(metrics: HostMetrics): void {
  try { fs.appendFileSync(metricsFile(), `${JSON.stringify(metrics)}\n`, 'utf-8'); } catch { /* best effort */ }
}

async function directorySize(root: string, limit = 20_000): Promise<number> {
  let total = 0; let visited = 0; const pending = [root];
  while (pending.length && visited < limit) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (visited++ >= limit) break;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) { try { total += (await fs.promises.stat(target)).size; } catch { /* disappeared */ } }
    }
  }
  return total;
}

async function getStorageInfo(): Promise<StorageInfo> {
  if (storageCache && Date.now() - storageCache.at < 60_000) return storageCache.value;
  const cachePath = path.join(app.getPath('sessionData'), 'Cache');
  const [logsBytes, cacheBytes, pluginsBytes] = await Promise.all([directorySize(logsPath), directorySize(cachePath), directorySize(pluginsPath)]);
  const value = { logsPath, cachePath, pluginsPath, logsBytes, cacheBytes, pluginsBytes };
  storageCache = { at: Date.now(), value };
  return value;
}

function readMetricHistory(range: 'minute' | 'hour'): HostMetrics[] {
  const since = Date.now() - (range === 'minute' ? 60_000 : 3_600_000);
  const files = [metricsFile(new Date(Date.now() - 86_400_000)), metricsFile()];
  const samples: HostMetrics[] = [];
  for (const file of files) {
    try {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        if (!line) continue;
        const sample = JSON.parse(line) as HostMetrics;
        if (typeof sample.recordedAt === 'number' && sample.recordedAt >= since) samples.push(sample);
      }
    } catch { /* no metrics file yet */ }
  }
  return samples.slice(range === 'minute' ? -30 : -120);
}

function pluginStatePath(): string { return path.join(app.getPath('userData'), 'plugins-state.json'); }
function readDisabledPlugins(): Set<string> {
  try {
    const value = JSON.parse(fs.readFileSync(pluginStatePath(), 'utf-8')) as { disabledIds?: unknown };
    return new Set(Array.isArray(value.disabledIds) ? value.disabledIds.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}
function writeDisabledPlugins(ids: Set<string>): void {
  const target = pluginStatePath();
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ disabledIds: [...ids].sort() }, null, 2)}\n`, 'utf-8');
  fs.renameSync(temporary, target);
}

const USE_MOCK_CONTROL_PLANE = process.env.PERSONALHUB_CONNECTOR === 'mock-cp';

function loadPlugins(pluginsDir: string): void {
  if (!hub) return;
  pluginCatalog.clear();
  const disabled = readDisabledPlugins();
  try {
    const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(pluginsDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const result = parsePluginManifest(raw);
        if (result.success) {
          const catalogItem: PluginCatalogItem = {
            id: result.data.id, name: result.data.name, version: result.data.version, schemaVersion: result.data.schemaVersion ?? 1,
            runtime: result.data.runtime, description: result.data.description,
            capabilities: result.data.capabilities.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })),
            deployment: result.data.deployment,
            enabled: !disabled.has(result.data.id), status: 'registered', directoryPath: path.join(pluginsDir, entry.name),
          };
          pluginCatalog.set(result.data.id, catalogItem);
          if (!catalogItem.enabled) {
            catalogItem.status = 'disabled';
            fileLog(`plugin ${entry.name}: disabled`);
            continue;
          }
          if (!isRuntimeSupportedOnPlatform(result.data.runtime, process.platform)) {
            catalogItem.status = 'unsupported';
            catalogItem.reason = `runtime ${result.data.runtime} is unsupported on ${process.platform}`;
            fileLog(`plugin ${entry.name}: skipped - runtime ${result.data.runtime} is unsupported on ${process.platform}`);
            continue;
          }
          const regResult = hub.pluginRegistry.register(result.data);
          if (!regResult.success) {
            catalogItem.status = 'error';
            catalogItem.reason = regResult.error?.message;
          }
          fileLog(`plugin ${entry.name}: ${regResult.success ? 'registered' : regResult.error?.message}`);
        } else {
          fileLog(`plugin ${entry.name}: manifest invalid - ${result.error.message}`);
        }
      } catch (err) {
        fileLog(`plugin ${entry.name}: read error - ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    // pluginsDir 不存在时忽略
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      fileLog(`loadPlugins error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function getTasksPath(userData: string): string {
  return path.join(userData, 'tasks.jsonl');
}

function persistTask(userData: string, task: Record<string, unknown>): void {
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.appendFileSync(getTasksPath(userData), `${JSON.stringify(task)}\n`, 'utf-8');
  } catch { /* 静默 */ }
}

interface TaskArtifact {
  name: string;
  localPath: string;
  exists: boolean;
  sizeBytes: number | null;
}

function getTaskArtifacts(output: unknown): TaskArtifact[] {
  if (!output || typeof output !== 'object') return [];
  const files = (output as Record<string, unknown>).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((value): TaskArtifact[] => {
    if (typeof value === 'string') {
      let exists = false;
      let sizeBytes: number | null = null;
      try {
        const stat = fs.statSync(value);
        exists = stat.isFile();
        sizeBytes = exists ? stat.size : null;
      } catch { /* missing artifacts remain visible with their original path */ }
      return [{ name: path.basename(value), localPath: value, exists, sizeBytes }];
    }
    if (!value || typeof value !== 'object') return [];
    const file = value as Record<string, unknown>;
    const localPath = typeof file.localPath === 'string' ? file.localPath : typeof file.path === 'string' ? file.path : null;
    if (!localPath) return [];
    let exists = false;
    let sizeBytes: number | null = null;
    try {
      const stat = fs.statSync(localPath);
      exists = stat.isFile();
      sizeBytes = exists ? stat.size : null;
    } catch { /* missing artifacts remain visible with their original path */ }
    return [{ name: typeof file.name === 'string' ? file.name : path.basename(localPath), localPath, exists, sizeBytes }];
  });
}

function loadPersistedTasks(userData: string): void {
  if (!hub) return;
  const tasksPath = getTasksPath(userData);
  if (!fs.existsSync(tasksPath)) return;
  try {
    const lines = fs.readFileSync(tasksPath, 'utf-8').split('\n').filter(Boolean);
    const latest = new Map<string, Record<string, unknown>>();
    for (const line of lines.slice(-500)) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== 'object' || parsed === null) continue;
        const task = parsed as Record<string, unknown>;
        if (typeof task.taskId === 'string') latest.set(task.taskId, task);
      } catch { /* skip invalid line */ }
    }
    let restored = 0;
    for (const task of latest.values()) {
      if (task.deleted === true) continue;
      if (typeof task.taskId !== 'string' || typeof task.capability !== 'string') continue;
      const existing = hub.taskStore.findById(task.taskId);
          if (existing) {
            if (task.status && task.status !== existing.status) {
              hub.taskStore.update(task.taskId, {
                status: task.status as 'queued' | 'running' | 'succeeded' | 'failed',
                output: task.output as unknown,
                error: task.error as { message: string; details?: unknown } | null,
              });
            }
            continue;
          }
          hub.taskStore.restore({
            taskId: task.taskId,
            capability: task.capability,
            pluginId: typeof task.pluginId === 'string' ? task.pluginId : '',
            input: task.input,
            status: task.status === 'running' || task.status === 'succeeded' || task.status === 'failed' ? task.status : 'queued',
            output: task.output ?? null,
            error: task.error && typeof task.error === 'object' ? task.error as { message: string; details?: unknown } : null,
            createdAt: typeof task.createdAt === 'string' ? task.createdAt : new Date().toISOString(),
            updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(),
          });
          restored += 1;
    }
    if (restored > 0) fileLog(`persisted tasks: restored ${restored}`);
  } catch (err) {
    fileLog(`loadPersistedTasks error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function wrapTaskStore(userData: string): void {
  if (!hub) return;
  const store = hub.taskStore;
  const origCreate = store.create.bind(store);
  const origUpdate = store.update.bind(store);
  store.create = (params) => {
    const task = origCreate(params);
    persistTask(userData, task as unknown as Record<string, unknown>);
    return task;
  };
  store.update = (taskId, update) => {
    const task = origUpdate(taskId, update);
    if (task) persistTask(userData, task as unknown as Record<string, unknown>);
    return task;
  };
}

async function bootstrap(): Promise<void> {
  const config = loadUserConfig(app.getPath('userData'));
  userConfig = config;
  const apiKey = config.apiKey;
  const connector: Connector = USE_MOCK_CONTROL_PLANE
    ? new MockControlPlaneConnector()
    : config.serverUrl && apiKey
      ? new AdminOSConnector({ serverUrl: config.serverUrl, apiKey, hostId: config.hostId })
      : new LocalOnlyConnector();
  agentIntervalMs = config.agentIntervalMs;
  fileLog(`bootstrap: connector=${connector.id} serverUrl=${config.serverUrl ?? 'none'} apiKey=${apiKey ? 'configured' : 'missing'}`);
  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: config.startOnLogin });
  }

  // 确保 userData/plugins 目录与 extraResources 同步
  const userPluginsDir = path.join(app.getPath('userData'), 'plugins');
  pluginsPath = userPluginsDir;
  const bundledPluginsDir = path.join(process.resourcesPath, 'plugins');
  if (fs.existsSync(bundledPluginsDir) && !fs.existsSync(userPluginsDir)) {
    fileLog('seeding plugins from bundled resources');
    try {
      fs.cpSync(bundledPluginsDir, userPluginsDir, { recursive: true, force: true });
    } catch (err) {
      fileLog(`seed plugins error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  hub = await createPersonalHub({
    connector,
    hostId: config.hostId,
    name: config.name,
    mode: connector.mode,
    pluginsDir: path.join(app.getPath('userData'), 'plugins'),
    diagnosticLogger: fileLog,
    ...(connector instanceof AdminOSConnector && config.serverUrl && apiKey
      ? { artifactLayer: new ArtifactLayer({ connector, baseUrl: config.serverUrl, apiKey }) }
      : {}),
  });

  loadPersistedTasks(app.getPath('userData'));
  wrapTaskStore(app.getPath('userData'));

  autoUpdater.logger = {
    info: (message) => fileLog(`updater.info: ${String(message)}`),
    warn: (message) => fileLog(`updater.warn: ${String(message)}`),
    error: (message) => fileLog(`updater.error: ${String(message)}`),
    debug: (message) => fileLog(`updater.debug: ${String(message)}`),
  };
  updateService = new GithubUpdateService({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    persistenceFile: path.join(app.getPath('userData'), 'update-state.json'),
    logger: fileLog,
    onStateChange: (state: UpdateState) => mainWindow?.webContents.send('ph:updateState', state),
  });

  loadPlugins(path.join(app.getPath('userData'), 'plugins'));
  hub.agent.start(agentIntervalMs);

  console.log(`PersonalHub API: http://${hub.apiHost}:${hub.apiPort}`);
}

function createWindow(): void {
  const preloadPath = path.join(__dirname, '..', 'preload', 'index.cjs');
  const rendererPath = path.join(__dirname, '..', '..', 'renderer', 'index.html');

  fileLog(`createWindow: preload=${preloadPath} renderer=${rendererPath}`);
  fileLog(`preload exists: ${fs.existsSync(preloadPath)}`);
  fileLog(`renderer exists: ${fs.existsSync(rendererPath)}`);

  try {
    const preloadContent = fs.readFileSync(preloadPath, 'utf-8');
    fileLog(`preload first 100 chars: ${preloadContent.slice(0, 100)}`);
  } catch (e: unknown) {
    fileLog(`preload read error: ${e instanceof Error ? e.message : String(e)}`);
  }

  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    backgroundColor: '#05070a',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 12, y: 15 },
      vibrancy: 'under-window' as const,
      visualEffectState: 'active' as const,
    } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    const levelName = ['verbose', 'info', 'warning', 'error'][level] ?? 'unknown';
    fileLog(`[console.${levelName}] ${message}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    fileLog('did-finish-load: page loaded');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    fileLog(`did-fail-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  mainWindow.webContents.on('preload-error', (_event, _preloadPath, error) => {
    fileLog(`preload-error: ${error.message}`);
  });

  mainWindow.webContents.on('dom-ready', () => {
    fileLog('dom-ready: DOM is ready');
  });

  mainWindow.webContents.on('did-fail-provisional-load', (_event, errorCode, errorDescription, validatedURL) => {
    fileLog(`did-fail-provisional-load: code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    fileLog(`loadURL: ${devServerUrl}`);
    mainWindow.loadURL(devServerUrl);
  } else {
    fileLog(`loadFile: ${rendererPath}`);
    mainWindow.loadFile(rendererPath);
  }

  mainWindow.on('closed', () => {
    fileLog('window closed');
    mainWindow = null;
  });
  mainWindow.on('close', (event) => {
    if (shutdownStarted) return;
    event.preventDefault();
    mainWindow?.hide();
    if (process.platform === 'darwin') app.dock?.hide();
    fileLog('window hidden to tray');
  });
}

function showMainWindow(): void {
  if (!mainWindow) createWindow();
  if (process.platform === 'darwin') app.dock?.show();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
}

function createTray(): void {
  tray = new Tray(createTrayIcon('yellow'));
  tray.setToolTip('PersonalHub');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Window', click: showMainWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', showMainWindow);
}

function createTrayIcon(color: 'green' | 'yellow' | 'red' | 'gray') {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="6" fill="${color}"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function updateTrayStatus(): void {
  if (!tray || !hub) return;
  const color = !hub.agent.isRunning()
    ? 'gray'
    : hub.connector.id === 'adminos'
      ? 'green'
      : 'yellow';
  tray.setImage(createTrayIcon(color));
  tray.setToolTip(`PersonalHub: ${hub.agent.isRunning() ? hub.connector.id : 'stopped'}`);
}

function setupIpc(): void {
  ipcMain.handle('ph:getStatus', async () => {
    if (!hub) return null;
    const lastTick = hub.agent.getLastTick();
    const remote = hub.agent.getRemoteConnectionState();
    const metrics = await collectHostMetrics();
    return {
      mode: hub.connector.mode,
      connector: hub.connector.id,
      agentStatus: hub.agent.isRunning() ? 'running' : 'stopped',
      apiHost: hub.apiHost,
      apiPort: hub.apiPort,
      lastHeartbeatAt: remote.lastHeartbeatSuccessAt,
      ...remote,
      configurationIssue: hub.connector.id === 'local-only'
        ? (!userConfig?.serverUrl ? '缺少 AdminOS Server URL' : !userConfig?.apiKey ? '缺少 AdminOS API Key' : null)
        : null,
      lastTick,
      pluginCount: hub.pluginRegistry.list().length,
      capabilityCount: hub.capabilityRegistry.list().length,
      startedAt: hub.startedAt,
      hostId: userConfig?.hostId ?? null,
      ...metrics,
      taskCount: hub.taskStore.list().length,
      platform: process.platform,
    };
  });

  ipcMain.handle('ph:getMetrics', async () => collectHostMetrics());
  ipcMain.handle('ph:getMetricHistory', async (_event, range: 'minute' | 'hour') => readMetricHistory(range));

  ipcMain.handle('ph:runAgentTick', async () => {
    if (!hub) return { error: 'Hub not initialized' };
    const result = await hub.agent.tick();
    return result;
  });

  ipcMain.handle('ph:startAgent', async () => {
    if (!hub) return { error: 'Hub not initialized' };
    hub.agent.start(agentIntervalMs);
    updateTrayStatus();
    return { ok: true };
  });

  ipcMain.handle('ph:stopAgent', async () => {
    if (!hub) return { error: 'Hub not initialized' };
    await hub.agent.stop();
    updateTrayStatus();
    return { ok: true };
  });

  ipcMain.handle('ph:getPlugins', async () => {
    const plugins = new Map<string, Omit<PluginCatalogItem, 'directoryPath'>>(
      [...pluginCatalog.values()].map(({ directoryPath: _directoryPath, ...plugin }) => [plugin.id, plugin]),
    );
    for (const registered of hub?.pluginRegistry.list() ?? []) {
      const existing = plugins.get(registered.id);
      if (existing) {
        existing.enabled = registered.enabled;
        existing.status = registered.enabled ? 'registered' : 'disabled';
        continue;
      }
      plugins.set(registered.id, {
        id: registered.id,
        name: registered.name,
        version: registered.version,
        schemaVersion: 1,
        runtime: registered.runtime,
        description: registered.description,
        capabilities: registered.capabilities.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })),
        enabled: registered.enabled,
        status: registered.enabled ? 'registered' : 'disabled',
      });
    }
    const statusOrder: Record<PluginCatalogItem['status'], number> = { registered: 0, disabled: 1, unsupported: 2, error: 3 };
    return [...plugins.values()].sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));
  });
  ipcMain.handle('ph:importPlugin', async () => {
    if (!hub) throw new Error('Hub not initialized');
    const dialogOptions = {
      title: '选择 PersonalHub 插件目录',
      properties: ['openDirectory' as const],
    };
    const selection = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selection.canceled || !selection.filePaths[0]) return null;
    const sourceDir = selection.filePaths[0];
    const manifestPath = path.join(sourceDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error('所选目录缺少 manifest.json');
    const parsed = parsePluginManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
    if (!parsed.success) throw new Error(`插件声明无效：${parsed.error.message}`);
    if (!isRuntimeSupportedOnPlatform(parsed.data.runtime, process.platform)) throw new Error(`当前平台不支持 runtime ${parsed.data.runtime}`);
    if (parsed.data.deployment) {
      const declaredPath = parsed.data.deployment.type === 'dockerfile'
        ? path.resolve(sourceDir, parsed.data.deployment.context, parsed.data.deployment.dockerfile)
        : path.resolve(sourceDir, parsed.data.deployment.entrypoint);
      const relativeDeploymentPath = path.relative(sourceDir, declaredPath);
      if (relativeDeploymentPath.startsWith('..') || path.isAbsolute(relativeDeploymentPath)) throw new Error('部署入口超出插件目录');
      if (!fs.existsSync(declaredPath)) throw new Error(`部署入口不存在：${relativeDeploymentPath}`);
    }
    const safeDirectoryName = parsed.data.id.replace(/[^a-zA-Z0-9._-]/g, '_');
    const targetDir = path.join(pluginsPath, safeDirectoryName);
    if (fs.existsSync(targetDir) || pluginCatalog.has(parsed.data.id)) throw new Error(`插件 ${parsed.data.id} 已存在`);
    fs.mkdirSync(pluginsPath, { recursive: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true, force: false });
    const registration = hub.pluginRegistry.register(parsed.data);
    if (!registration.success) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new Error(registration.error.message);
    }
    const item: PluginCatalogItem = {
      id: parsed.data.id, name: parsed.data.name, version: parsed.data.version, schemaVersion: parsed.data.schemaVersion ?? 1,
      runtime: parsed.data.runtime, description: parsed.data.description,
      capabilities: parsed.data.capabilities.map(({ name, description, inputSchema, outputSchema }) => ({ name, description, inputSchema, outputSchema })),
      deployment: parsed.data.deployment, enabled: true, status: 'registered', directoryPath: targetDir,
    };
    pluginCatalog.set(item.id, item);
    fileLog(`plugin ${item.id}: imported from ${sourceDir}`);
    return { id: item.id, name: item.name };
  });
  ipcMain.handle('ph:copyText', async (_event, value: string) => {
    clipboard.writeText(value);
    return { ok: true };
  });
  ipcMain.handle('ph:setPluginEnabled', async (_event, pluginId: string, enabled: boolean) => {
    const plugin = pluginCatalog.get(pluginId);
    if (!plugin) throw new Error('插件不存在');
    const disabled = readDisabledPlugins();
    if (enabled) disabled.delete(pluginId); else disabled.add(pluginId);
    writeDisabledPlugins(disabled);
    const registered = hub?.pluginRegistry.findById(pluginId);
    if (registered) {
      if (enabled) hub?.pluginRegistry.enable(pluginId); else hub?.pluginRegistry.disable(pluginId);
      plugin.enabled = enabled;
      plugin.status = enabled ? 'registered' : 'disabled';
    }
    const restartRequired = !registered;
    fileLog(`plugin ${pluginId}: ${enabled ? 'enabled' : 'disabled'}${restartRequired ? '; restart required' : ''}`);
    return { ok: true, restartRequired };
  });
  ipcMain.handle('ph:deletePlugin', async (_event, pluginId: string) => {
    const plugin = pluginCatalog.get(pluginId);
    if (!plugin) throw new Error('插件不存在');
    const relative = path.relative(pluginsPath, plugin.directoryPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('插件路径不安全');
    fs.rmSync(plugin.directoryPath, { recursive: true, force: true });
    hub?.pluginRegistry.unregister(pluginId);
    const disabled = readDisabledPlugins();
    disabled.delete(pluginId);
    writeDisabledPlugins(disabled);
    pluginCatalog.delete(pluginId);
    fileLog(`plugin ${pluginId}: deleted; restart required`);
    return { ok: true, restartRequired: true };
  });
  ipcMain.handle('ph:getTasks', async () => (hub?.taskStore.list() ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((task) => ({ ...task, artifacts: getTaskArtifacts(task.output) })));
  ipcMain.handle('ph:getCapabilities', async () => hub?.capabilityRegistry.list() ?? []);
  ipcMain.handle('ph:createTask', async (_event, capability: string, input: unknown, execute: boolean) => {
    if (!hub) throw new Error('Hub not initialized');
    const created = await hub.taskRouter.createTask({ capability, input });
    if (!created.success) throw new Error(created.error.message);
    if (!execute) return created.task;
    const executed = await hub.taskRouter.executeTask(created.task.taskId);
    return executed.task;
  });
  ipcMain.handle('ph:revealArtifact', async (_event, taskId: string, localPath: string) => {
    const task = hub?.taskStore.findById(taskId);
    if (!task) throw new Error('任务不存在');
    const artifact = getTaskArtifacts(task.output).find((item) => item.localPath === localPath);
    if (!artifact) throw new Error('该路径不属于此任务');
    if (!artifact.exists) throw new Error(`产物已不存在：${localPath}`);
    shell.showItemInFolder(localPath);
    return { ok: true };
  });
  ipcMain.handle('ph:deleteTask', async (_event, taskId: string, deleteArtifacts: boolean) => {
    if (!hub) throw new Error('Hub not initialized');
    const task = hub.taskStore.findById(taskId);
    if (!task) throw new Error('任务不存在');
    let deletedArtifacts = 0;
    if (deleteArtifacts) {
      for (const artifact of getTaskArtifacts(task.output)) {
        try {
          if (fs.statSync(artifact.localPath).isFile()) {
            fs.rmSync(artifact.localPath, { force: true });
            deletedArtifacts += 1;
          }
        } catch { /* already missing */ }
      }
    }
    hub.taskStore.delete(taskId);
    persistTask(app.getPath('userData'), { taskId, deleted: true, deletedAt: new Date().toISOString() });
    return { ok: true, deletedArtifacts };
  });
  ipcMain.handle('ph:getLogs', async () => {
    try {
      const contents = fs.readFileSync(logFile, 'utf-8');
      return contents.slice(-100_000);
    } catch {
      return '';
    }
  });
  ipcMain.handle('ph:getConfig', async () => userConfig ? {
    hostId: userConfig.hostId,
    name: userConfig.name,
    serverUrl: userConfig.serverUrl,
    apiKey: userConfig.apiKey ? '••••••••' : null,
    agentIntervalMs: userConfig.agentIntervalMs,
    startOnLogin: userConfig.startOnLogin,
    logRetentionDays: userConfig.logRetentionDays,
    apiKeyConfigured: Boolean(userConfig.apiKey),
  } : null);
  ipcMain.handle('ph:getStorageInfo', async () => getStorageInfo());
  ipcMain.handle('ph:openStoragePath', async (_event, kind: 'logs' | 'cache' | 'plugins') => {
    const info = await getStorageInfo();
    const target = kind === 'logs' ? info.logsPath : kind === 'cache' ? info.cachePath : info.pluginsPath;
    fs.mkdirSync(target, { recursive: true });
    const error = await shell.openPath(target);
    if (error) throw new Error(error);
    return { ok: true };
  });
  ipcMain.handle('ph:saveConfig', async (_event, patch: Partial<Omit<UserConfig, 'hostId'>>) => {
    if (!userConfig) throw new Error('Hub not initialized');
    userConfig = updateUserConfig(app.getPath('userData'), userConfig, patch);
    agentIntervalMs = userConfig.agentIntervalMs;
    if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: userConfig.startOnLogin });
    }
    cleanupDiagnostics(userConfig.logRetentionDays);
    storageCache = null;
    return userConfig;
  });
  ipcMain.handle('ph:getUpdateState', async () => updateService?.getState() ?? null);
  ipcMain.handle('ph:checkUpdate', async () => updateService?.checkForUpdates(true) ?? null);
  ipcMain.handle('ph:downloadUpdate', async () => updateService?.downloadUpdate() ?? null);
  ipcMain.handle('ph:installUpdate', async () => {
    if (!updateService || updateService.getState().phase !== 'downloaded') throw new Error('更新尚未下载完成');
    shutdownStarted = true;
    if (metricsTimer) clearInterval(metricsTimer);
    try {
      if (hub) {
        await hub.agent.stop();
        await hub.stop();
      }
    } catch (error) {
      fileLog(`update: graceful shutdown failed - ${error instanceof Error ? error.message : String(error)}`);
    }
    return updateService.installUpdate();
  });
  ipcMain.handle('ph:restartApp', async () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle('ph:log', async (_event, msg: string) => {
    fileLog(`[renderer] ${msg}`);
  });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  logsPath = app.getPath('logs');
  fs.mkdirSync(logsPath, { recursive: true });
  logFile = path.join(logsPath, `personalhub-${dateStamp()}.log`);
  fileLog('--- PersonalHub START ---');
  await bootstrap();
  cleanupDiagnostics(userConfig?.logRetentionDays ?? 7);
  const recordMetrics = async () => { try { persistMetrics(await collectHostMetrics()); } catch { /* best effort */ } };
  void recordMetrics();
  metricsTimer = setInterval(() => { void recordMetrics(); }, 30_000);
  setupIpc();
  createTray();
  updateTrayStatus();
  createWindow();
  updateService?.startAutomaticChecks();
});

app.on('second-instance', () => {
  showMainWindow();
});

app.on('window-all-closed', () => undefined);

app.on('activate', () => {
  showMainWindow();
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  fileLog('before-quit');
  updateService?.stopAutomaticChecks();
  if (metricsTimer) clearInterval(metricsTimer);
  void (async () => {
    try {
      if (hub) {
        await hub.agent.stop();
        await hub.stop();
      }
    } finally {
      app.exit(0);
    }
  })();
});
