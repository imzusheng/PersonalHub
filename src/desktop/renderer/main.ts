interface TickResult {
  heartbeatSent: boolean;
  capabilitiesPublished: boolean;
  tasksProcessed: number;
  succeeded: number;
  failed: number;
  errors: number;
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
  hostId: string | null;
}

interface PluginSummary {
  id: string;
  name: string;
  version: string;
  runtime: string;
  capabilities: Array<{ name: string; description?: string }>;
}

interface TaskSummary {
  taskId: string;
  capability: string;
  status: string;
  output: unknown;
  error: { message: string } | null;
  updatedAt: string;
}

interface ConfigResponse {
  hostId: string;
  name: string;
  serverUrl: string | null;
  agentIntervalMs: number;
  startOnLogin: boolean;
  apiKeyConfigured: boolean;
}

interface UpdatePlan {
  deploymentId: string;
  artifactUrl: string;
  artifactName: string;
  artifactSha256: string;
  artifactSizeBytes: number;
}

interface PersonalHubApi {
  getStatus(): Promise<StatusResponse | null>;
  runAgentTick(): Promise<TickResult>;
  startAgent(): Promise<{ ok?: boolean; error?: string }>;
  stopAgent(): Promise<{ ok?: boolean; error?: string }>;
  getPlugins(): Promise<PluginSummary[]>;
  getTasks(): Promise<TaskSummary[]>;
  getLogs(): Promise<string>;
  getConfig(): Promise<ConfigResponse | null>;
  saveConfig(patch: Partial<Omit<ConfigResponse, 'hostId' | 'apiKeyConfigured'>>): Promise<ConfigResponse>;
  checkUpdate(): Promise<UpdatePlan | null>;
  downloadUpdate(plan: UpdatePlan): Promise<string>;
  log(msg: string): Promise<void>;
}

declare global {
  interface Window { personalhub?: PersonalHubApi }
}

const app = document.getElementById('app')!;
type Tab = 'overview' | 'plugins' | 'tasks' | 'logs' | 'settings';
let activeTab: Tab = 'overview';

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  }[character] ?? character));
}

function debugLog(message: string): void {
  window.personalhub?.log(message).catch(() => undefined);
}

function nav(): string {
  const tabs: Array<[Tab, string]> = [
    ['overview', '概览'], ['plugins', '插件'], ['tasks', '任务'], ['logs', '日志'], ['settings', '设置'],
  ];
  return `<nav>${tabs.map(([tab, label]) => `<button class="nav-button ${activeTab === tab ? 'active' : ''}" data-tab="${tab}">${label}</button>`).join('')}</nav>`;
}

function statusCard(label: string, value: unknown): string {
  return `<div class="status-item"><span class="status-label">${escapeHtml(label)}</span><span class="status-value">${escapeHtml(value)}</span></div>`;
}

async function render(): Promise<void> {
  if (!window.personalhub) {
    app.innerHTML = '<main><h1>PersonalHub</h1><p class="error">Preload 未加载，无法连接主进程。</p></main>';
    return;
  }
  try {
    const status = await window.personalhub.getStatus();
    if (!status) throw new Error('Hub not initialized 未初始化');
    const content = await renderTab(status);
    app.innerHTML = `<main><header><div><h1>PersonalHub</h1><p>${escapeHtml(status.hostId ?? '未分配主机 ID')}</p></div><span class="connection ${status.agentStatus === 'running' ? 'online' : 'offline'}">${escapeHtml(status.agentStatus)}</span></header>${nav()}${content}</main>`;
    bindEvents();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`render failed: ${message}`);
    app.innerHTML = `<main><h1>PersonalHub</h1><p class="error">${escapeHtml(message)}</p></main>`;
  }
}

async function renderTab(status: StatusResponse): Promise<string> {
  if (activeTab === 'plugins') {
    const plugins = await window.personalhub!.getPlugins();
    return `<section><h2>插件</h2>${plugins.length === 0 ? '<p class="empty">尚未注册插件</p>' : plugins.map((plugin) => `<article class="card"><strong>${escapeHtml(plugin.name)}</strong><p>${escapeHtml(plugin.id)} · ${escapeHtml(plugin.version)} · ${escapeHtml(plugin.runtime)}</p><div class="chips">${plugin.capabilities.map((capability) => `<span>${escapeHtml(capability.name)}</span>`).join('')}</div></article>`).join('')}</section>`;
  }
  if (activeTab === 'tasks') {
    const tasks = await window.personalhub!.getTasks();
    return `<section><h2>本地任务</h2>${tasks.length === 0 ? '<p class="empty">暂无任务</p>' : `<div class="task-list">${tasks.map((task) => `<article class="card"><div class="row"><strong>${escapeHtml(task.capability)}</strong><span class="badge ${escapeHtml(task.status)}">${escapeHtml(task.status)}</span></div><code>${escapeHtml(task.taskId)}</code>${task.error ? `<p class="error">${escapeHtml(task.error.message)}</p>` : task.output !== null ? `<pre>${escapeHtml(JSON.stringify(task.output, null, 2))}</pre>` : ''}</article>`).join('')}</div>`}</section>`;
  }
  if (activeTab === 'logs') {
    const logs = await window.personalhub!.getLogs();
    return `<section><div class="row"><h2>日志</h2><button id="refreshLogs" class="secondary">刷新</button></div><pre class="logs">${escapeHtml(logs || '暂无日志')}</pre></section>`;
  }
  if (activeTab === 'settings') {
    const config = await window.personalhub!.getConfig();
    if (!config) return '<section><p class="error">配置尚不可用</p></section>';
    return `<section><h2>连接设置</h2><form id="settingsForm" class="settings"><label>主机名称<input name="name" value="${escapeHtml(config.name)}" required></label><label>AdminOS 地址<input name="serverUrl" value="${escapeHtml(config.serverUrl ?? '')}" placeholder="https://admin.example.com"></label><label>Agent 间隔（毫秒）<input name="agentIntervalMs" type="number" min="1000" value="${config.agentIntervalMs}" required></label><label class="checkbox"><input name="startOnLogin" type="checkbox" ${config.startOnLogin ? 'checked' : ''}> Windows 登录后自动启动</label><p class="hint">Host ID：<code>${escapeHtml(config.hostId)}</code></p><p class="hint">API Key：${config.apiKeyConfigured ? '已从环境变量读取' : '未配置。请设置 PERSONALHUB_API_KEY。'}</p><button type="submit">保存设置</button></form></section>`;
  }
  const tick = status.lastTick;
  return `<section><h2>运行概览</h2><div class="status-grid">${statusCard('模式', status.mode)}${statusCard('连接器', status.connector)}${statusCard('本地 API', `${status.apiHost}:${status.apiPort}`)}${statusCard('插件', status.pluginCount)}${statusCard('能力', status.capabilityCount)}${statusCard('最近循环', status.lastHeartbeatAt ?? '暂无')}${statusCard('最近任务', tick ? `${tick.tasksProcessed} 个，成功 ${tick.succeeded}，失败 ${tick.failed}` : '暂无')}</div><div class="actions">${status.agentStatus === 'running' ? '<button id="stopAgent" class="danger">停止 Agent</button>' : '<button id="startAgent">启动 Agent</button>'}<button id="runTick" class="secondary">立即运行一次</button><button id="checkUpdate" class="secondary">检查更新</button></div><pre id="tickOutput" class="result"></pre></section>`;
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => { activeTab = button.dataset.tab as Tab; void render(); });
  });
  document.getElementById('refreshLogs')?.addEventListener('click', () => void render());
  document.getElementById('startAgent')?.addEventListener('click', async () => { await window.personalhub?.startAgent(); await render(); });
  document.getElementById('stopAgent')?.addEventListener('click', async () => { await window.personalhub?.stopAgent(); await render(); });
  document.getElementById('runTick')?.addEventListener('click', async () => {
    const output = document.getElementById('tickOutput');
    if (!output) return;
    output.textContent = '正在执行...';
    try { output.textContent = JSON.stringify(await window.personalhub?.runAgentTick(), null, 2); } catch (error) { output.textContent = String(error); }
    await render();
  });
  document.getElementById('checkUpdate')?.addEventListener('click', async () => {
    const output = document.getElementById('tickOutput');
    if (!output) return;
    output.textContent = '正在检查更新...';
    try {
      const plan = await window.personalhub?.checkUpdate();
      if (!plan) {
        output.textContent = '当前没有可用更新。';
        return;
      }
      output.textContent = `发现更新：${plan.artifactName}\n正在下载并校验...`;
      const downloadedPath = await window.personalhub?.downloadUpdate(plan);
      output.textContent = `更新包已下载并校验：${downloadedPath}\n请关闭 PersonalHub 后手动运行安装包完成更新。`;
    } catch (error) {
      output.textContent = `更新失败：${error instanceof Error ? error.message : String(error)}`;
    }
  });
  document.getElementById('settingsForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    await window.personalhub?.saveConfig({
      name: String(values.get('name') ?? ''),
      serverUrl: String(values.get('serverUrl') ?? '') || null,
      agentIntervalMs: Number(values.get('agentIntervalMs')),
      startOnLogin: values.get('startOnLogin') === 'on',
    });
    await render();
  });
}

void render();
