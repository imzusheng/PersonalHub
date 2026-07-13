const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getStatus: () => ipcRenderer.invoke('ph:getStatus'),
  getMetrics: () => ipcRenderer.invoke('ph:getMetrics'),
  getMetricHistory: (range) => ipcRenderer.invoke('ph:getMetricHistory', range),
  runAgentTick: () => ipcRenderer.invoke('ph:runAgentTick'),
  startAgent: () => ipcRenderer.invoke('ph:startAgent'),
  stopAgent: () => ipcRenderer.invoke('ph:stopAgent'),
  getPlugins: () => ipcRenderer.invoke('ph:getPlugins'),
  importPlugin: () => ipcRenderer.invoke('ph:importPlugin'),
  copyText: (value) => ipcRenderer.invoke('ph:copyText', value),
  setPluginEnabled: (pluginId, enabled) => ipcRenderer.invoke('ph:setPluginEnabled', pluginId, enabled),
  deletePlugin: (pluginId) => ipcRenderer.invoke('ph:deletePlugin', pluginId),
  getTasks: () => ipcRenderer.invoke('ph:getTasks'),
  getCapabilities: () => ipcRenderer.invoke('ph:getCapabilities'),
  createTask: (capability, input, execute = true) => ipcRenderer.invoke('ph:createTask', capability, input, execute),
  revealArtifact: (taskId, localPath) => ipcRenderer.invoke('ph:revealArtifact', taskId, localPath),
  deleteTask: (taskId, deleteArtifacts = false) => ipcRenderer.invoke('ph:deleteTask', taskId, deleteArtifacts),
  getLogs: () => ipcRenderer.invoke('ph:getLogs'),
  getConfig: () => ipcRenderer.invoke('ph:getConfig'),
  getStorageInfo: () => ipcRenderer.invoke('ph:getStorageInfo'),
  openStoragePath: (kind) => ipcRenderer.invoke('ph:openStoragePath', kind),
  saveConfig: (patch) => ipcRenderer.invoke('ph:saveConfig', patch),
  checkUpdate: () => ipcRenderer.invoke('ph:checkUpdate'),
  downloadUpdate: (plan) => ipcRenderer.invoke('ph:downloadUpdate', plan),
  restartApp: () => ipcRenderer.invoke('ph:restartApp'),
  log: (msg) => ipcRenderer.invoke('ph:log', msg),
};

contextBridge.exposeInMainWorld('personalhub', api);
