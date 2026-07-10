interface PersonalHubApi {
  getStatus(): Promise<StatusResponse | null>;
  runAgentTick(): Promise<TickResult>;
  log(msg: string): Promise<void>;
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
    personalhub?: PersonalHubApi;
  }
}

function debugLog(msg: string): void {
  if (window.personalhub?.log) {
    window.personalhub.log(msg).catch(() => {});
  }
  const el = document.getElementById('debug-log');
  if (el) {
    const line = `${new Date().toISOString().slice(11, 19)} ${msg}`;
    el.textContent = (el.textContent ?? '') + line + '\n';
  }
}

const app = document.getElementById('app')!;

function showError(title: string, detail: string): void {
  debugLog(`ERROR: ${title} - ${detail}`);
  app.innerHTML = `
    <h1>PersonalHub</h1>
    <div style="padding:16px;background:#4a2020;border:1px solid #ff4444;border-radius:6px;margin:16px 0;">
      <strong style="color:#ff6666;">${title}</strong>
      <pre style="color:#ffaaaa;font-size:12px;margin:8px 0 0;white-space:pre-wrap;">${detail}</pre>
    </div>
    <div style="font-size:11px;color:#888;">Debug: see personalhub-debug.log</div>
  `;
}

async function renderStatus(): Promise<void> {
  debugLog('renderStatus start');

  if (!window.personalhub) {
    showError('Preload 失败', 'window.personalhub 未定义');
    return;
  }

  debugLog('window.personalhub 存在, keys: ' + Object.keys(window.personalhub).join(', '));

  try {
    const status = await window.personalhub.getStatus();
    debugLog('getStatus OK: ' + JSON.stringify(status));

    if (!status) {
      app.innerHTML = '<h1>PersonalHub</h1><p style="color:#ff6666;">Hub not initialized</p>';
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
        const result = await window.personalhub!.runAgentTick();
        tickResultEl.textContent = JSON.stringify(result, null, 2);
      } catch (e) {
        tickResultEl.textContent = `Error: ${e}`;
      } finally {
        tickBtn.disabled = false;
        renderStatus();
      }
    });

    debugLog('renderStatus done');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    debugLog('getStatus error: ' + msg);
    showError('getStatus 失败', msg + '\n\nStack:\n' + (e instanceof Error ? e.stack : ''));
  }
}

debugLog('main.ts loaded, personalhub=' + typeof window.personalhub);

try {
  renderStatus();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  debugLog('renderStatus crash: ' + msg);
  showError('JS 异常', msg + '\n\n' + (e instanceof Error ? e.stack ?? '' : ''));
}
