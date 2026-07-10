const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getStatus: () => ipcRenderer.invoke('ph:getStatus'),
  runAgentTick: () => ipcRenderer.invoke('ph:runAgentTick'),
  log: (msg) => ipcRenderer.invoke('ph:log', msg),
};

contextBridge.exposeInMainWorld('personalhub', api);
