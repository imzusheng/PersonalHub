import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { createPersonalHub, type PersonalHubRuntime } from '../../core/app.js';
import { parsePluginManifest } from '../../core/domain/plugin-manifest.js';
import { MockControlPlaneConnector } from '../../core/connector/mock-control-plane-connector.js';
import { LocalOnlyConnector } from '../../core/connector/local-only-connector.js';
import type { Connector } from '../../core/connector/connector.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_FILE = path.join(os.homedir(), 'Desktop', 'personalhub-debug.log');

function fileLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf-8'); } catch { /* 静默 */ }
  console.log(`[RENDERER] ${msg}`);
}

let hub: PersonalHubRuntime | null = null;
let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;

const MOCK_VISION_MANIFEST = {
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
};

const USE_MOCK_CONTROL_PLANE = process.env.PERSONALHUB_CONNECTOR === 'mock-cp';

async function bootstrap(): Promise<void> {
  const connector: Connector = USE_MOCK_CONTROL_PLANE
    ? new MockControlPlaneConnector()
    : new LocalOnlyConnector();

  hub = await createPersonalHub({
    connector,
    hostId: 'local-dev',
    name: 'PersonalHub',
  });

  const result = parsePluginManifest(MOCK_VISION_MANIFEST);
  if (result.success) {
    hub.pluginRegistry.register(result.data);
  }

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
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);
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

function setupIpc(): void {
  ipcMain.handle('ph:getStatus', async () => {
    if (!hub) return null;
    const lastTick = hub.agent.getLastTick();
    return {
      mode: 'local-only',
      connector: hub.connector.id,
      agentStatus: 'manual',
      apiHost: hub.apiHost,
      apiPort: hub.apiPort,
      lastHeartbeatAt: hub.agent.getLastTickAt(),
      lastTick,
      pluginCount: hub.pluginRegistry.list().length,
      capabilityCount: hub.capabilityRegistry.list().length,
      startedAt: hub.startedAt,
    };
  });

  ipcMain.handle('ph:runAgentTick', async () => {
    if (!hub) return { error: 'Hub not initialized' };
    const result = await hub.agent.tick();
    return result;
  });

  ipcMain.handle('ph:log', async (_event, msg: string) => {
    fileLog(`[renderer] ${msg}`);
  });
}

app.whenReady().then(async () => {
  try { fs.writeFileSync(LOG_FILE, '', 'utf-8'); } catch { /* 静默 */ }
  fileLog('--- PersonalHub START ---');
  await bootstrap();
  setupIpc();
  createTray();
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
    await hub.stop();
  }
});
