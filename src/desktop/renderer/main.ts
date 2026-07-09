interface PersonalHubApi {
  getStatus(): Promise<StatusResponse | null>;
  runAgentTick(): Promise<TickResult>;
}

interface StatusResponse {
  mode: string;
  connector: string;
  agentStatus: string;
  apiHost: string;
  apiPort: number;
  lastHeartbeatAt: string | null;
  lastTick: TickResult | null;
  pluginCount: number;
  capabilityCount: number;
  startedAt: string;
}

interface TickResult {
  heartbeatSent: boolean;
  capabilitiesPublished: boolean;
  tasksProcessed: number;
  succeeded: number;
  failed: number;
  errors: number;
}

declare global {
  interface Window {
    personalhub: PersonalHubApi;
  }
}

const app = document.getElementById('app')!;

async function renderStatus(): Promise<void> {
  const status = await window.personalhub.getStatus();
  if (!status) {
    app.innerHTML = '<p>PersonalHub not initialized</p>';
    return;
  }

  const tickResult = status.lastTick
    ? `<div class="status-item"><span class="status-label">Last Tick</span><span class="status-value">tasks: ${status.lastTick.tasksProcessed}, ok: ${status.lastTick.succeeded}, fail: ${status.lastTick.failed}</span></div>`
    : '<div class="status-item"><span class="status-label">Last Tick</span><span class="status-value">none</span></div>';

  app.innerHTML = `
    <h1>PersonalHub</h1>
    <div class="status-grid">
      <div class="status-item"><span class="status-label">Mode</span><span class="status-value">${status.mode}</span></div>
      <div class="status-item"><span class="status-label">Connector</span><span class="status-value">${status.connector}</span></div>
      <div class="status-item"><span class="status-label">Agent</span><span class="status-value">${status.agentStatus}</span></div>
      <div class="status-item"><span class="status-label">API</span><span class="status-value">${status.apiHost}:${status.apiPort}</span></div>
      <div class="status-item"><span class="status-label">Plugins</span><span class="status-value">${status.pluginCount}</span></div>
      <div class="status-item"><span class="status-label">Capabilities</span><span class="status-value">${status.capabilityCount}</span></div>
      <div class="status-item"><span class="status-label">Last Heartbeat</span><span class="status-value">${status.lastHeartbeatAt ?? 'none'}</span></div>
      ${tickResult}
    </div>
    <div class="tick-section">
      <button id="tickBtn">Run Agent Tick</button>
      <div id="tickResult" class="tick-result" style="display:none;"></div>
    </div>
  `;

  const tickBtn = document.getElementById('tickBtn')!;
  const tickResultEl = document.getElementById('tickResult')!;

  tickBtn.addEventListener('click', async () => {
    tickBtn.disabled = true;
    tickResultEl.style.display = 'block';
    tickResultEl.textContent = 'Running tick...';
    try {
      const result = await window.personalhub.runAgentTick();
      tickResultEl.textContent = JSON.stringify(result, null, 2);
    } catch (e) {
      tickResultEl.textContent = `Error: ${e}`;
    } finally {
      tickBtn.disabled = false;
      renderStatus();
    }
  });
}

renderStatus();
