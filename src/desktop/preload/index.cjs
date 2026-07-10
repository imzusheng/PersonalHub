const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getStatus: () => ipcRenderer.invoke('ph:getStatus'),
  runAgentTick: () => ipcRenderer.invoke('ph:runAgentTick'),
  startAgent: () => ipcRenderer.invoke('ph:startAgent'),
  stopAgent: () => ipcRenderer.invoke('ph:stopAgent'),
  getPlugins: () => ipcRenderer.invoke('ph:getPlugins'),
  getTasks: () => ipcRenderer.invoke('ph:getTasks'),
  getLogs: () => ipcRenderer.invoke('ph:getLogs'),
  getConfig: () => ipcRenderer.invoke('ph:getConfig'),
  saveConfig: (patch) => ipcRenderer.invoke('ph:saveConfig', patch),
  checkUpdate: () => ipcRenderer.invoke('ph:checkUpdate'),
  downloadUpdate: (plan) => ipcRenderer.invoke('ph:downloadUpdate', plan),
  log: (msg) => ipcRenderer.invoke('ph:log', msg),
};

contextBridge.exposeInMainWorld('personalhub', api);
