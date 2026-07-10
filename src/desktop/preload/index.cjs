const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getStatus: () => ipcRenderer.invoke('ph:getStatus'),
  runAgentTick: () => ipcRenderer.invoke('ph:runAgentTick'),
};

contextBridge.exposeInMainWorld('personalhub', api);
