const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getStatus: () => ipcRenderer.invoke('ph:getStatus'),
  runAgentTick: () => ipcRenderer.invoke('ph:runAgentTick'),
  startAgent: () => ipcRenderer.invoke('ph:startAgent'),
  stopAgent: () => ipcRenderer.invoke('ph:stopAgent'),
  getPlugins: () => ipcRenderer.invoke('ph:getPlugins'),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke('ph:setPluginEnabled', pluginId, enabled),
  deletePlugin: (pluginId) => ipcRenderer.invoke('ph:deletePlugin', pluginId),
  getTasks: () => ipcRenderer.invoke('ph:getTasks'),
  getLogs: () => ipcRenderer.invoke('ph:getLogs'),
  getConfig: () => ipcRenderer.invoke('ph:getConfig'),
  saveConfig: (patch) => ipcRenderer.invoke('ph:saveConfig', patch),
  checkUpdate: () => ipcRenderer.invoke('ph:checkUpdate'),
  downloadUpdate: (plan) => ipcRenderer.invoke('ph:downloadUpdate', plan),
  restartApp: () => ipcRenderer.invoke('ph:restartApp'),
  log: (msg) => ipcRenderer.invoke('ph:log', msg),
};

contextBridge.exposeInMainWorld('personalhub', api);
