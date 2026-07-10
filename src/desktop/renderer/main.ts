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
    personalhub?: PersonalHubApi;
  }
}

const DEBUG_KEY = 'personalhub_debug';

function debug(msg: string): void {
  const lines = (sessionStorage.getItem(DEBUG_KEY) ?? '').split('\n').filter(Boolean);
  lines.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  sessionStorage.setItem(DEBUG_KEY, lines.slice(-200).join('\n'));
  const el = document.getElementById('debug-log');
  if (el) el.textContent = lines.slice(-50).join('\n');
}

const app = document.getElementById('app')!;

function showError(title: string, detail: string): void {
  debug(`ERROR: ${title} - ${detail}`);
  app.innerHTML = `
    <h1>PersonalHub</h1>
    <div style="padding:16px;background:#4a2020;border:1px solid #ff4444;border-radius:6px;margin:16px 0;">
      <strong style="color:#ff6666;">${title}</strong>
      <pre style="color:#ffaaaa;font-size:12px;margin:8px 0 0;white-space:pre-wrap;">${detail}</pre>
    </div>
    <div id="debug-log" style="padding:12px;background:#111;border-radius:4px;font-family:monospace;font-size:11px;color:#aaa;white-space:pre-wrap;max-height:300px;overflow:auto;"></div>
  `;
}

async function renderStatus(): Promise<void> {
  debug('renderStatus start');

  if (!window.personalhub) {
    showError('Preload 失败', 'window.personalhub 未定义，preload 脚本可能未加载。\n请检查 dist/desktop/preload/index.cjs 是否存在且为 CommonJS 格式。');
    return;
  }

  const status = await window.personalhub.getStatus();
  debug('getStatus returned: ' + JSON.stringify(status));

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

  debug('renderStatus done');
}

debug('main.ts loaded, window.personalhub=' + typeof window.personalhub);

try {
  renderStatus();
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  showError('JS 异常', msg + '\n\nStack:\n' + (e instanceof Error ? e.stack : ''));
}
