import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } from 'electron';
import { createPersonalHub, type PersonalHubRuntime } from '../../core/app.js';
import { parsePluginManifest } from '../../core/domain/plugin-manifest.js';
import { MockControlPlaneConnector } from '../../core/connector/mock-control-plane-connector.js';
import { LocalOnlyConnector } from '../../core/connector/local-only-connector.js';
import type { Connector } from '../../core/connector/connector.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
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
}

app.whenReady().then(async () => {
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
  if (hub) {
    await hub.stop();
  }
});
