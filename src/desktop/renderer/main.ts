interface TickResult { heartbeatSent:boolean; capabilitiesPublished:boolean; tasksProcessed:number; succeeded:number; failed:number; errors:number }
type RemoteStatus='unconfigured'|'connecting'|'online'|'degraded'|'offline';
interface StatusResponse { mode:string; connector:string; agentStatus:string; apiHost:string; apiPort:number; lastHeartbeatAt:string|null; lastHeartbeatSuccessAt:string|null; lastHeartbeatErrorAt:string|null; consecutiveHeartbeatFailures:number; lastRemoteError:string|null; remoteStatus:RemoteStatus; configurationIssue:string|null; lastTick:TickResult|null; pluginCount:number; capabilityCount:number; startedAt:string; hostId:string|null; memoryPercent:number; taskCount:number; platform:string }
interface PluginSummary { id:string; name:string; version:string; runtime:string; description?:string; capabilities:Array<{name:string;description?:string}> }
interface TaskSummary { taskId:string; capability:string; status:string; output:unknown; error:{message:string}|null; updatedAt:string }
interface ConfigResponse { hostId:string; name:string; serverUrl:string|null; apiKey:string|null; agentIntervalMs:number; startOnLogin:boolean; apiKeyConfigured:boolean }
interface UpdatePlan { deploymentId:string; artifactUrl:string; artifactName:string; artifactSha256:string; artifactSizeBytes:number }
interface PersonalHubApi {
  getStatus():Promise<StatusResponse|null>; runAgentTick():Promise<TickResult>; startAgent():Promise<{ok?:boolean;error?:string}>; stopAgent():Promise<{ok?:boolean;error?:string}>;
  getPlugins():Promise<PluginSummary[]>; getTasks():Promise<TaskSummary[]>; getLogs():Promise<string>; getConfig():Promise<ConfigResponse|null>;
  saveConfig(patch:Partial<Omit<ConfigResponse,'hostId'|'apiKeyConfigured'>>):Promise<ConfigResponse>; checkUpdate():Promise<UpdatePlan|null>; downloadUpdate(plan:UpdatePlan):Promise<string>; restartApp():Promise<void>; log(msg:string):Promise<void>;
}
declare global { interface Window { personalhub?:PersonalHubApi } }

const app=document.getElementById('app')!;
type Tab='overview'|'plugins'|'tasks'|'logs'|'lab'|'settings';
let activeTab:Tab='overview';
interface Material { preset:string; alpha:number; blur:number; radius:number; panel:string; ambient:string; accent:string; wallTop:string; wallMid:string; wallBottom:string }
const MATERIAL_STORAGE_KEY='personalhub.appearance.v1';
const MATERIAL_PRESETS:Record<string,{name:string;description:string;material:Material}>={
  clear:{name:'Clear Lens',description:'近乎无雾的通透工具玻璃',material:{preset:'clear',alpha:22,blur:4,radius:14,panel:'18,23,31',ambient:'116,176,255',accent:'#78b5ff',wallTop:'#263348',wallMid:'#101722',wallBottom:'#05070b'}},
  native:{name:'Native Tool',description:'克制、均衡的 macOS 工具质感',material:{preset:'native',alpha:48,blur:24,radius:20,panel:'16,19,25',ambient:'108,168,255',accent:'#6ca8ff',wallTop:'#171c25',wallMid:'#0b0e14',wallBottom:'#040609'}},
  deep:{name:'Deep Space',description:'高对比、低干扰的纯黑工作台',material:{preset:'deep',alpha:78,blur:38,radius:24,panel:'3,5,9',ambient:'103,111,255',accent:'#949bff',wallTop:'#070810',wallMid:'#030408',wallBottom:'#010203'}},
  frost:{name:'Polar Frost',description:'明亮冰霜与冷白高光',material:{preset:'frost',alpha:18,blur:46,radius:28,panel:'205,222,239',ambient:'195,229,255',accent:'#b9e5ff',wallTop:'#486078',wallMid:'#1d2b3a',wallBottom:'#091019'}},
  cobalt:{name:'Cobalt Signal',description:'饱和钴蓝与精密仪器感',material:{preset:'cobalt',alpha:62,blur:28,radius:18,panel:'5,18,44',ambient:'31,104,255',accent:'#3289ff',wallTop:'#071a3c',wallMid:'#030d20',wallBottom:'#01050d'}},
  ember:{name:'Ember Console',description:'暖琥珀、焦黑与夜间控制台',material:{preset:'ember',alpha:66,blur:16,radius:12,panel:'38,15,9',ambient:'255,105,48',accent:'#ff8848',wallTop:'#32140d',wallMid:'#160907',wallBottom:'#070302'}},
};
function loadMaterial():Material{try{const value=JSON.parse(localStorage.getItem(MATERIAL_STORAGE_KEY)??'null') as Partial<Material>|null;if(value&&typeof value.alpha==='number'&&typeof value.blur==='number'&&typeof value.radius==='number')return{...MATERIAL_PRESETS.native.material,...value}}catch{}return{...MATERIAL_PRESETS.native.material}}
let material=loadMaterial();

function esc(value:unknown):string{return String(value??'').replace(/[&<>'"]/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]??c))}
function fmtTime(iso:string|null):string{if(!iso)return '尚未同步';const d=new Date(iso);return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(d)}
function elapsed(iso:string):string{const ms=Math.max(0,Date.now()-new Date(iso).getTime());const minutes=Math.floor(ms/60000);if(minutes<1)return '刚刚启动';if(minutes<60)return `${minutes} 分钟`;return `${Math.floor(minutes/60)} 小时 ${minutes%60} 分钟`}
function debug(message:string):void{window.personalhub?.log(message).catch(()=>undefined)}
function badge(status:string):string{const tone=status==='succeeded'||status==='running'?'ok':status==='failed'?'fail':'warn';return `<span class="badge ${tone}">${esc(status)}</span>`}
function card(content:string,extra=''):string{return `<article class="card glass ${extra}"><div class="card-body">${content}</div></article>`}
function pageHead(kicker:string,title:string,subtitle:string,meta=''):string{return `<div class="page-head"><div><div class="eyebrow">${esc(kicker)}</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div>${meta}</div>`}
function nav():string{return ([['overview','概览'],['plugins','插件'],['tasks','任务'],['logs','日志'],['lab','外观'],['settings','设置']] as Array<[Tab,string]>).map(([tab,label])=>`<button class="nav-button ${activeTab===tab?'active':''}" data-tab="${tab}">${label}</button>`).join('')}
function applyMaterial(next:Material,persist=true):void{material={...next};const root=document.documentElement;root.style.setProperty('--glass-alpha',String(material.alpha/100));root.style.setProperty('--glass-blur',`${material.blur}px`);root.style.setProperty('--radius',`${material.radius}px`);root.style.setProperty('--panel-rgb',material.panel);root.style.setProperty('--ambient-rgb',material.ambient);root.style.setProperty('--accent',material.accent);root.style.setProperty('--wall-top',material.wallTop);root.style.setProperty('--wall-mid',material.wallMid);root.style.setProperty('--wall-bottom',material.wallBottom);if(persist)localStorage.setItem(MATERIAL_STORAGE_KEY,JSON.stringify(material));const alphaOut=document.getElementById('alphaValue');const blurOut=document.getElementById('blurValue');const radiusOut=document.getElementById('radiusValue');if(alphaOut)alphaOut.textContent=`${material.alpha}%`;if(blurOut)blurOut.textContent=`${material.blur}px`;if(radiusOut)radiusOut.textContent=`${material.radius}px`}
applyMaterial(material,false);

async function render():Promise<void>{
  if(!window.personalhub){app.innerHTML='<div class="empty"><div><strong>主进程未连接</strong><span>Preload bridge 不可用</span></div></div>';return}
  try{
    const status=await window.personalhub.getStatus();if(!status)throw new Error('PersonalHub 尚未初始化');
    const content=await renderTab(status);
    const running=status.agentStatus==='running';const remoteOnline=status.remoteStatus==='online';
    const remoteLabel:Record<RemoteStatus,string>={unconfigured:'未配置远程连接',connecting:'正在连接',online:'远程在线',degraded:'连接异常',offline:'远程离线'};
    app.innerHTML=`<div class="app-shell ${status.platform==='darwin'?'mac-immersive':''}"><div class="app-frame">
      <header class="topbar glass"><div class="brand"><div class="brand-mark">P</div><div><strong>PersonalHub</strong><small>Local AI Worker</small></div></div><nav class="nav">${nav()}</nav><div class="top-actions"><span class="connection ${remoteOnline?'online':'offline'}">${remoteLabel[status.remoteStatus]}</span><button class="tool-btn" id="topRefresh">刷新</button></div></header>
      <main class="workspace"><div class="workspace-inner view-enter">${content}</div></main>
    </div></div>`;
    bindEvents();
  }catch(error){const message=error instanceof Error?error.message:String(error);debug(`render failed: ${message}`);app.innerHTML=`<div class="empty error"><div><strong>界面加载失败</strong><span>${esc(message)}</span></div></div>`}
}

async function renderTab(status:StatusResponse):Promise<string>{
  const hostMeta=`<code class="host-id">${esc(status.hostId??'未分配 Host ID')}</code>`;
  if(activeTab==='plugins'){
    const plugins=await window.personalhub!.getPlugins();
    const body=plugins.length?`<div class="grid plugin-grid">${plugins.map((plugin)=>card(`<div class="task-head"><div class="icon-box">${esc(plugin.name.slice(0,1).toUpperCase())}</div><span class="badge ok">已注册</span></div><h3>${esc(plugin.name)}</h3><p>${esc(plugin.description??`${plugin.runtime} · ${plugin.version}`)}</p><div class="chips">${plugin.capabilities.map((cap)=>`<span class="chip">${esc(cap.name)}</span>`).join('')}</div><div class="mono" style="margin-top:16px">${esc(plugin.id)} · ${esc(plugin.runtime)}</div>`,'plugin-card')).join('')}</div>`:`<div class="empty"><div><strong>尚未安装插件</strong><span>把插件放入 PersonalHub 数据目录后重启应用</span></div></div>`;
    return pageHead('Capabilities','插件','本机真实可调用的模型与工具',hostMeta)+body;
  }
  if(activeTab==='tasks'){
    const tasks=await window.personalhub!.getTasks();
    const body=tasks.length?`<div class="task-list">${tasks.map((task)=>card(`<div class="task-head"><div><strong>${esc(task.capability)}</strong><div class="mono">${esc(task.taskId)}</div></div>${badge(task.status)}</div><div class="mono" style="margin-top:12px">更新于 ${esc(fmtTime(task.updatedAt))}</div>${task.error?`<p class="error">${esc(task.error.message)}</p>`:task.output!==null?`<pre>${esc(JSON.stringify(task.output,null,2))}</pre>`:''}`)).join('')}</div>`:`<div class="empty"><div><strong>还没有本地任务</strong><span>从 adminOS 创建任务后会在这里留下执行记录</span></div></div>`;
    return pageHead('Execution','任务','本机领取与执行的任务历史',`<span class="chip">${tasks.length} 条记录</span>`)+body;
  }
  if(activeTab==='logs'){
    const logs=await window.personalhub!.getLogs();
    return pageHead('Diagnostics','日志','主进程、连接器与渲染器诊断信息','<button class="tool-btn" id="refreshLogs">刷新日志</button>')+card(`<div class="log-shell"><div class="section-title"><h3>personalhub-debug.log</h3><span>最近 100 KB</span></div><pre class="logs">${esc(logs||'暂无日志')}</pre></div>`);
  }
  if(activeTab==='settings'){
    const config=await window.personalhub!.getConfig();if(!config)return pageHead('Preferences','设置','配置尚不可用');
    return pageHead('Preferences','设置','连接、身份与启动行为',hostMeta)+card(`<form id="settingsForm" class="settings">
      <label>主机名称<input name="name" value="${esc(config.name)}" required></label><label>同步间隔（毫秒）<input name="agentIntervalMs" type="number" min="1000" value="${config.agentIntervalMs}" required></label>
      <label class="wide">AdminOS 地址<input name="serverUrl" value="${esc(config.serverUrl??'')}" placeholder="https://volc.zusheng.cc"></label>
      <label class="wide">调度 API Key<div class="input-row"><input id="apiKeyInput" name="apiKey" type="password" value="" placeholder="${config.apiKeyConfigured?'已配置，留空则保持不变':'输入 API Key'}"><button type="button" class="tool-btn" id="toggleApiKey">显示</button></div></label>
      <label class="checkbox"><input name="startOnLogin" type="checkbox" ${config.startOnLogin?'checked':''}> Windows 登录后自动启动 PersonalHub</label>
      <div class="wide toolbar"><button class="tool-btn primary" type="submit">保存设置</button><button class="tool-btn" type="button" id="restartApp">重启应用</button></div>
    </form>`);
  }
  if(activeTab==='lab'){
    const presets=Object.entries(MATERIAL_PRESETS).map(([id,preset])=>`<button class="preset ${material.preset===id?'active':''}" data-preset="${id}"><strong>${esc(preset.name)}</strong><small>${esc(preset.description)}</small></button>`).join('');
    return pageHead('Appearance Lab','视觉实验室','高反差材质预设与实时参数会自动保存','<span class="chip">已持久化</span>')+`<div class="lab-grid">
      ${card(`<div class="section-title"><h3>材质预设</h3><span>${Object.keys(MATERIAL_PRESETS).length} Presets</span></div><div class="preset-list">${presets}</div>`)}
      <div class="grid"><div class="preview-stage"><div class="preview-card glass"><div class="eyebrow">MATERIAL PREVIEW</div><h3>PersonalHub Lens</h3><p>透明度、模糊与圆角会立即作用到整个应用。</p><div class="chips" style="margin-top:14px"><span class="chip">Local First</span><span class="chip">Apple Native</span></div></div></div>
      ${card(`<div class="section-title"><h3>材质参数</h3><span>实时</span></div><div class="control-list"><label class="control"><div class="control-head"><span>面板透明度</span><output id="alphaValue">${material.alpha}%</output></div><input id="alphaControl" type="range" min="18" max="82" value="${material.alpha}"></label><label class="control"><div class="control-head"><span>背景模糊</span><output id="blurValue">${material.blur}px</output></div><input id="blurControl" type="range" min="0" max="48" value="${material.blur}"></label><label class="control"><div class="control-head"><span>卡片圆角</span><output id="radiusValue">${material.radius}px</output></div><input id="radiusControl" type="range" min="10" max="30" value="${material.radius}"></label></div>`)}</div>
    </div>`;
  }
  const running=status.agentStatus==='running';const tick=status.lastTick;const remoteOnline=status.remoteStatus==='online';
  return pageHead('Overview','运行概览','本机 AI 服务、远程调度与执行状态',hostMeta)+`
    ${card(`<div class="hero"><div class="orb">⌘</div><div><h2>${running?'准备接收远程任务':'远程调度已暂停'}</h2><p>${running?'PersonalHub 正在主动同步能力并领取任务。':'本机插件与 Ollama 不受影响，adminOS 暂时无法调度。'}</p><div class="chips"><span class="chip">${esc(status.connector)}</span><span class="chip">本地 API ${esc(status.apiPort)}</span></div></div></div><div class="stat-band"><div class="stat"><span>插件</span><strong>${status.pluginCount}</strong><small>${status.capabilityCount} 个能力</small></div><div class="stat"><span>能力</span><strong>${status.capabilityCount}</strong><small>可调度</small></div><div class="stat"><span>任务</span><strong>${status.taskCount}</strong><small>${tick?`${tick.succeeded} 成功`:'等待循环'}</small></div><div class="stat"><span>内存</span><strong>${status.memoryPercent}%</strong><small>仅指标</small></div></div>`,'overview-card')}
    <div class="grid split-grid">
      ${card(`<div class="section-title"><h3>远程调度状态</h3><span>${esc(status.remoteStatus)}</span></div><div class="summary"><div><span>最近成功心跳</span><strong>${esc(fmtTime(status.lastHeartbeatSuccessAt))}</strong></div><div><span>连续失败</span><strong>${status.consecutiveHeartbeatFailures}</strong></div><div><span>运行时长</span><strong>${esc(elapsed(status.startedAt))}</strong></div></div>${status.configurationIssue?`<p class="error">${esc(status.configurationIssue)}</p>`:''}${status.lastRemoteError?`<p class="error">${esc(status.lastRemoteError)}</p>`:''}<div class="toolbar" style="margin-top:16px"><button class="tool-btn ${running?'danger':'primary'}" id="toggleScheduling">${running?'停止远程调度':'启动远程调度'}</button><button class="tool-btn" id="runTick" ${running?'':'disabled'}>立即同步</button><button class="tool-btn" id="checkUpdate">检查更新</button></div><pre class="result" id="actionOutput"></pre>`)}
      ${card(`<div class="section-title"><h3>运行边界</h3><span>Local First</span></div><div class="list"><div class="list-row"><div class="icon-box">L</div><div><strong>本地插件继续运行</strong><small>停止调度不会停止 Ollama 或删除插件</small></div><span class="badge ok">独立</span></div><div class="list-row"><div class="icon-box">A</div><div><strong>AdminOS 主动连接</strong><small>客户端主动心跳、同步与领取任务</small></div><span class="badge ${remoteOnline?'ok':'warn'}">${esc(status.remoteStatus)}</span></div><div class="list-row"><div class="icon-box">U</div><div><strong>应用更新</strong><small>安装包校验后由用户确认安装</small></div><span class="badge">手动</span></div></div>`)}
    </div>`;
}

function toast(message:string):void{document.querySelector('.toast')?.remove();const node=document.createElement('div');node.className='toast';node.textContent=message;document.body.appendChild(node);window.setTimeout(()=>node.remove(),3200)}
async function runAction(button:HTMLButtonElement|undefined,action:()=>Promise<void>):Promise<void>{if(button)button.disabled=true;try{await action()}catch(error){toast(error instanceof Error?error.message:String(error))}finally{if(button)button.disabled=false}}
function bindEvents():void{
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button)=>button.addEventListener('click',()=>{activeTab=button.dataset.tab as Tab;void render()}));
  document.getElementById('topRefresh')?.addEventListener('click',()=>void render());document.getElementById('refreshLogs')?.addEventListener('click',()=>void render());
  const toggle=document.getElementById('toggleScheduling') as HTMLButtonElement|undefined;toggle?.addEventListener('click',()=>void runAction(toggle,async()=>{const status=await window.personalhub!.getStatus();if(status?.agentStatus==='running')await window.personalhub!.stopAgent();else await window.personalhub!.startAgent();await render()}));
  const runTick=document.getElementById('runTick') as HTMLButtonElement|undefined;runTick?.addEventListener('click',()=>void runAction(runTick,async()=>{const result=await window.personalhub!.runAgentTick();toast(`同步完成 · ${result.tasksProcessed} 个任务`);await render()}));
  const update=document.getElementById('checkUpdate') as HTMLButtonElement|undefined;update?.addEventListener('click',()=>void runAction(update,async()=>{const plan=await window.personalhub!.checkUpdate();if(!plan){toast('当前已是最新版本');return}toast(`正在下载 ${plan.artifactName}`);const path=await window.personalhub!.downloadUpdate(plan);toast(`更新包已校验：${path}`)}));
  document.getElementById('toggleApiKey')?.addEventListener('click',()=>{const input=document.getElementById('apiKeyInput') as HTMLInputElement|null;if(!input)return;input.type=input.type==='password'?'text':'password'});
  document.getElementById('restartApp')?.addEventListener('click',()=>void window.personalhub!.restartApp());
  const bindRange=(id:string,callback:(value:number)=>void)=>document.getElementById(id)?.addEventListener('input',(event)=>callback(Number((event.currentTarget as HTMLInputElement).value)));
  bindRange('alphaControl',(value)=>applyMaterial({...material,preset:'custom',alpha:value}));
  bindRange('blurControl',(value)=>applyMaterial({...material,preset:'custom',blur:value}));
  bindRange('radiusControl',(value)=>applyMaterial({...material,preset:'custom',radius:value}));
  document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((button)=>button.addEventListener('click',()=>{const id=button.dataset.preset??'native';const preset=MATERIAL_PRESETS[id];if(!preset)return;applyMaterial({...preset.material});const alphaInput=document.getElementById('alphaControl') as HTMLInputElement|null;const blurInput=document.getElementById('blurControl') as HTMLInputElement|null;const radiusInput=document.getElementById('radiusControl') as HTMLInputElement|null;if(alphaInput)alphaInput.value=String(material.alpha);if(blurInput)blurInput.value=String(material.blur);if(radiusInput)radiusInput.value=String(material.radius);document.querySelectorAll('.preset').forEach((item)=>item.classList.remove('active'));button.classList.add('active');toast(`${preset.name} 已应用并保存`)}));
  document.getElementById('settingsForm')?.addEventListener('submit',(event)=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;void runAction(form.querySelector('button[type="submit"]') as HTMLButtonElement,async()=>{const values=new FormData(form);const apiKey=String(values.get('apiKey')??'').trim();await window.personalhub!.saveConfig({name:String(values.get('name')??''),serverUrl:String(values.get('serverUrl')??'')||null,...(apiKey?{apiKey}:{}),agentIntervalMs:Number(values.get('agentIntervalMs')),startOnLogin:values.get('startOnLogin')==='on'});toast('设置已保存；连接信息变更需重启生效')})});
}

void render();
