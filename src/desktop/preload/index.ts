import { contextBridge, ipcRenderer } from 'electron';

const api = {
  getStatus: (): Promise<{
    mode: string;
    connector: string;
    agentStatus: string;
    apiHost: string;
    apiPort: number;
    lastHeartbeatAt: string | null;
    lastTick: {
      heartbeatSent: boolean;
      capabilitiesPublished: boolean;
      tasksProcessed: number;
      succeeded: number;
      failed: number;
      errors: number;
    } | null;
    pluginCount: number;
    capabilityCount: number;
    startedAt: string;
  } | null> => ipcRenderer.invoke('ph:getStatus'),

  runAgentTick: (): Promise<{
    heartbeatSent: boolean;
    capabilitiesPublished: boolean;
    tasksProcessed: number;
    succeeded: number;
    failed: number;
    errors: number;
  }> => ipcRenderer.invoke('ph:runAgentTick'),
};

contextBridge.exposeInMainWorld('personalhub', api);

export type PersonalHubApi = typeof api;
