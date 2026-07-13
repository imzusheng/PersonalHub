import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } from 'electron';
import { createPersonalHub, type PersonalHubRuntime } from '../../core/app.js';
import { isRuntimeSupportedOnPlatform, parsePluginManifest } from '../../core/domain/plugin-manifest.js';
import { MockControlPlaneConnector } from '../../core/connector/mock-control-plane-connector.js';
import { AdminOSConnector } from '../../core/connector/adminos-connector.js';
import { LocalOnlyConnector } from '../../core/connector/local-only-connector.js';
import type { Connector } from '../../core/connector/connector.js';
import { loadUserConfig, updateUserConfig, type UserConfig } from './user-config.js';
import { UpdateService } from './update-service.js';
import { ArtifactLayer } from '../../core/artifact/artifact-layer.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let logFile = '';

function fileLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(logFile, line, 'utf-8'); } catch { /* 静默 */ }
  console.log(`[RENDERER] ${msg}`);
}

let hub: PersonalHubRuntime | null = null;
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let agentIntervalMs = 30_000;
let userConfig: UserConfig | null = null;
let updateService: UpdateService | null = null;
let pluginsPath = '';
let shutdownStarted = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

interface PluginCatalogItem {
  id: string; name: string; version: string; runtime: string; description?: string;
  capabilities: Array<{ name: string; description?: string }>;
  enabled: boolean;
  status: 'registered' | 'disabled' | 'unsupported' | 'error';
  reason?: string;
  directoryPath: string;
}
const pluginCatalog = new Map<string, PluginCatalogItem>();

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
            id: result.data.id, name: result.data.name, version: result.data.version,
            runtime: result.data.runtime, description: result.data.description,
            capabilities: result.data.capabilities.map(({ name, description }) => ({ name, description })),
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

  if (connector instanceof AdminOSConnector) {
    updateService = new UpdateService(connector, path.join(app.getPath('temp'), 'PersonalHub-updates'));
  }

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
}

function createTray(): void {
  tray = new Tray(createTrayIcon('yellow'));
  tray.setToolTip('PersonalHub');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Window', click: () => mainWindow?.show() ?? createWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
    } else {
      createWindow();
    }
  });
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
    const totalMem = os.totalmem();
    const memoryPercent = totalMem > 0 ? Math.round(((totalMem - os.freemem()) / totalMem) * 100) : 0;
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
      memoryPercent,
      taskCount: hub.taskStore.list().length,
      platform: process.platform,
    };
  });

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
        runtime: registered.runtime,
        description: registered.description,
        capabilities: registered.capabilities.map(({ name, description }) => ({ name, description })),
        enabled: registered.enabled,
        status: registered.enabled ? 'registered' : 'disabled',
      });
    }
    const statusOrder: Record<PluginCatalogItem['status'], number> = { registered: 0, disabled: 1, unsupported: 2, error: 3 };
    return [...plugins.values()].sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || a.name.localeCompare(b.name));
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
    apiKeyConfigured: Boolean(userConfig.apiKey),
  } : null);
  ipcMain.handle('ph:saveConfig', async (_event, patch: Partial<Omit<UserConfig, 'hostId'>>) => {
    if (!userConfig) throw new Error('Hub not initialized');
    userConfig = updateUserConfig(app.getPath('userData'), userConfig, patch);
    agentIntervalMs = userConfig.agentIntervalMs;
    if (process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: userConfig.startOnLogin });
    }
    return userConfig;
  });
  ipcMain.handle('ph:checkUpdate', async () => updateService?.check() ?? null);
  ipcMain.handle('ph:downloadUpdate', async (_event, plan) => {
    if (!updateService) throw new Error('当前未连接 AdminOS，无法下载更新');
    return updateService.download(plan);
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
  const logsPath = app.getPath('logs');
  fs.mkdirSync(logsPath, { recursive: true });
  logFile = path.join(logsPath, 'personalhub-debug.log');
  try { fs.writeFileSync(logFile, '', 'utf-8'); } catch { /* 静默 */ }
  fileLog('--- PersonalHub START ---');
  await bootstrap();
  setupIpc();
  createTray();
  updateTrayStatus();
  createWindow();
});

app.on('second-instance', () => {
  if (!mainWindow) createWindow();
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.show();
  mainWindow?.focus();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', (event) => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  event.preventDefault();
  fileLog('before-quit');
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
