import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { createPersonalHub, type PersonalHubRuntime } from '../../core/app.js';
import { parsePluginManifest } from '../../core/domain/plugin-manifest.js';
import { MockControlPlaneConnector } from '../../core/connector/mock-control-plane-connector.js';
import { AdminOSConnector } from '../../core/connector/adminos-connector.js';
import { LocalOnlyConnector } from '../../core/connector/local-only-connector.js';
import type { Connector } from '../../core/connector/connector.js';
import { loadUserConfig, updateUserConfig, type UserConfig } from './user-config.js';
import { UpdateService } from './update-service.js';
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

const USE_MOCK_CONTROL_PLANE = process.env.PERSONALHUB_CONNECTOR === 'mock-cp';

function loadPlugins(pluginsDir: string): void {
  if (!hub) return;
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
          const regResult = hub.pluginRegistry.register(result.data);
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
        if (typeof task.taskId === 'string') {
          if (!latest.has(task.taskId)) latest.set(task.taskId, task);
        }
      } catch { /* skip invalid line */ }
    }
    let restored = 0;
    for (const task of latest.values()) {
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
          hub.taskStore.create({
            capability: task.capability as string,
            pluginId: (task.pluginId as string) || '',
            input: task.input,
          });
          if (task.status && task.status !== 'queued') {
            hub.taskStore.update(task.taskId, {
              status: task.status as 'queued' | 'running' | 'succeeded' | 'failed',
              output: task.output as unknown,
              error: task.error as { message: string; details?: unknown } | null,
            });
          }
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
  const bundledPluginsDir = path.join(process.resourcesPath, 'plugins');
  if (fs.existsSync(bundledPluginsDir) && !fs.existsSync(path.join(userPluginsDir, 'asr', 'manifest.json'))) {
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
    const totalMem = os.totalmem();
    const memoryPercent = totalMem > 0 ? Math.round(((totalMem - os.freemem()) / totalMem) * 100) : 0;
    return {
      mode: hub.connector.mode,
      connector: hub.connector.id,
      agentStatus: hub.agent.isRunning() ? 'running' : 'stopped',
      apiHost: hub.apiHost,
      apiPort: hub.apiPort,
      lastHeartbeatAt: hub.agent.getLastTickAt(),
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

  ipcMain.handle('ph:getPlugins', async () => hub?.pluginRegistry.list() ?? []);
  ipcMain.handle('ph:disablePlugin', async (_event, pluginId: string) => {
    if (!hub) return { error: 'Hub not initialized' };
    const ok = hub.pluginRegistry.disable(pluginId);
    if (!ok) return { error: `Plugin "${pluginId}" not found` };
    fileLog(`plugin ${pluginId}: disabled`);
    return { ok: true };
  });
  ipcMain.handle('ph:enablePlugin', async (_event, pluginId: string) => {
    if (!hub) return { error: 'Hub not initialized' };
    const ok = hub.pluginRegistry.enable(pluginId);
    if (!ok) return { error: `Plugin "${pluginId}" not found` };
    fileLog(`plugin ${pluginId}: enabled`);
    return { ok: true };
  });
  ipcMain.handle('ph:unregisterPlugin', async (_event, pluginId: string) => {
    if (!hub) return { error: 'Hub not initialized' };
    const removed = hub.pluginRegistry.unregister(pluginId);
    if (!removed) return { error: `Plugin "${pluginId}" not found` };
    // 删除 manifest 文件
    const manifestPath = path.join(app.getPath('userData'), 'plugins', pluginId, 'manifest.json');
    try { fs.unlinkSync(manifestPath); } catch { /* 忽略 */ }
    try { fs.rmdirSync(path.dirname(manifestPath)); } catch { /* 忽略 */ }
    fileLog(`plugin ${pluginId}: unregistered`);
    return { ok: true, plugin: removed };
  });
  ipcMain.handle('ph:getTasks', async () => hub?.taskStore.list() ?? []);
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

app.whenReady().then(async () => {
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

app.on('before-quit', async () => {
  fileLog('before-quit');
  if (hub) {
    await hub.agent.stop();
    await hub.stop();
  }
});
