# PersonalHub ASR / Vision 迁移最终方案

> 调研日期：2026-07-11
> 调研方式：macOS 源码 + SSH 远程探查 Windows 11 实际运行环境
> 状态：调研完成，Phase 0 就绪

---

## 一、Windows 11 实际环境（SSH 远程探查结果）

### 1.1 硬件

| 项目 | 值 |
|---|---|
| 系统 | Windows 11 Pro (10.0.26200) |
| GPU | NVIDIA GeForce RTX 4060 8GB |
| 驱动 | 596.49, CUDA 13.2 |
| 内存 | 32GB |
| 磁盘 | C: 931G (310G free) / D: 931G (704G free) / E: 434G (36G free) |

### 1.2 旧 Worker 运行架构（WSL2）

```
Windows 11
├── 计划任务: AdminOSHostServicesStartAtLogon (登录时触发)
│   └── wscript.exe → Start-AdminOS-WSL.vbs → start-all.ps1
│       └── wsl -d Ubuntu-22.04 systemctl start adminos-host-daemon.service
│
└── WSL2 Ubuntu 22.04
    ├── adminos-host-daemon.service (systemd, enabled, running since Jul 9)
    │   └── /usr/bin/python3 /usr/local/bin/adminos-host-daemon
    │       (486 行自包含 Python 脚本)
    │       hostId: win11-4060-home
    │       Server: https://volc.zusheng.cc
    │       职责：注册/心跳/指标/服务状态/命令/部署
    │
    ├── Docker (WSL2 内)
    │   ├── asr 容器: EXITED (137) 46h ago
    │   └── vision 容器: EXITED (137) 47h ago
    │
    └── 模型文件
        ├── /srv/models/qwen-asr (12GB)
        └── /srv/models/qwen-vl (7.1GB, Qwen2.5-VL-3B-Instruct)
```

**关键发现：**
- 旧系统使用 WSL2 内的 systemd 服务，不是直接运行 host_daemon.py
- `adminos-host-daemon` 是 486 行的重写版本，**只做主机 Agent 职责，不做任何任务处理**
- ASR/Vision 任务处理在 Docker 容器内独立完成（各自负责 lease/下载/推理/上传）
- **Docker 容器当前已退出（exit 137），将近 2 天**，但 daemon 仍在运行并报服务超时错误
- 没有正在处理的生产任务

### 1.3 PersonalHub 当前状态（Electron 应用）

| 项目 | 值 |
|---|---|
| 安装位置 | `C:\Users\Zusheng\AppData\Local\Programs\PersonalHub\` |
| 运行状态 | 运行中（PID 43804） |
| 连接模式 | **local-only**（未连接任何服务器） |
| hostId | `c96e93f7-e58d-4f4b-9280-9b34006dd241` (UUID) |
| agentIntervalMs | 30000 |
| 开机自启 | false |
| 任务持久化 | tasks.jsonl（已有实现） |

### 1.4 server-zushengcc 仓库

| 项目 | 值 |
|---|---|
| 位置 | `C:\Users\Zusheng\Desktop\front\server-zushengcc` |
| 分支 | master（clean） |
| 远程 | imzusheng/server-zushengcc.git |
| 最近提交 | `edbedf4 fix(windows): hide host-services startup windows` |

### 1.5 PersonalHub 源码仓库

**Windows 上不存在 PersonalHub 源码仓库。** 源码只在 macOS：`/Volumes/PSSD/Dev/front/PersonalHub` (main 分支)。

---

## 二、当前 PersonalHub 架构（基于源码）

与之前的调研一致，核心要点：

### 2.1 Connector 切换逻辑（`src/desktop/main/main.ts:143-151`）

```typescript
const connector = USE_MOCK_CONTROL_PLANE
  ? new MockControlPlaneConnector()
  : config.serverUrl && config.apiKey
    ? new AdminOSConnector({ serverUrl, apiKey, hostId })
    : new LocalOnlyConnector();
```

**要切换到 AdminOS 模式，只需在 config 中设置 `serverUrl` 和 `apiKey`。**

### 2.2 任务持久化（已有实现）

`main.ts:68-141` 中 `wrapTaskStore` 将 TaskStore 的 create/update 操作写入 `tasks.jsonl`，`loadPersistedTasks` 启动时恢复。这是迁移所需的基础设施。

### 2.3 插件加载

从 `{userData}/plugins/` 目录递归扫描 `manifest.json`，自动注册。

### 2.4 当前缺口（与旧系统对比）

| 能力 | adminos-host-daemon | PersonalHub |
|---|---|---|
| 注册/心跳/指标 | ✅ | ✅ |
| 服务状态上报 | ✅ 通过 Docker API 查容器 | ✅ 通过 plugin healthcheck |
| 命令执行 | ✅ docker compose | ✅ |
| 部署 | ✅ 完整流程（下载/校验/解压/compose up） | ⚠️ 部分 |
| 任务处理 | ❌ 交给容器 | ❌ 未实现文件任务 |
| 在 Windows 运行 | WSL2 systemd | Electron 直接运行 |
| GPU 访问 | WSL2 透传 | ❌ 需通过 WSL2 或 Docker |

---

## 三、关键架构决策变更

基于实际环境，之前的一些假设需要修正：

### 修正 1：PersonalHub 不在 WSL2 内运行

PersonalHub 是 Electron 应用，直接在 Windows 上运行。它可以通过 `PythonVenvRuntime` 调 Windows 上的 Python，但 **GPU/CUDA 只在 WSL2 内可用**。

**结论：ASR/Vision 推理必须在 WSL2 内执行。**

### 修正 2：不需要复制 adminos-host-daemon

`adminos-host-daemon` 已经是重写版，干净地分离了主机 Agent 和任务处理。PersonalHub 要替代的就是它的主机 Agent 部分。

### 修正 3：任务处理在 Docker 容器内

旧 ASR/Vision agent 在容器内独立运行，自己做 lease/下载/推理/上传。迁移时可以选择：
- A) 保留容器，PersonalHub 通过 HTTP 调用
- B) 把 agent 改为 CLI 插件，PersonalHub 通过 WSL 调用

---

## 四、推荐目标架构（修订版）

```
Windows 11
│
├── PersonalHub Electron（常驻，开机自启）
│   ├── AgentLoop (30s tick)
│   │   职责：注册/心跳/指标/服务状态/命令/租约
│   ├── AdminOSConnector → https://volc.zusheng.cc
│   ├── ArtifactLayer（新增）
│   │   职责：文件下载/上传/校验/临时目录/清理
│   └── TaskRouter
│       └── capability 路由到插件
│
├── WSL2 Ubuntu 22.04（保持运行，不再需要 adminos-host-daemon）
│   ├── Docker
│   │   ├── asr 容器（保留，但不再自己做 lease）
│   │   └── vision 容器（保留，但不再自己做 lease）
│   └── 模型文件（不变）
│
└── 插件（在 PersonalHub plugins/ 目录）
    ├── asr/manifest.json
    │   runtime: wsl-docker → 调 WSL2 内的 asr 容器 HTTP API
    └── vision/manifest.json
        runtime: wsl-docker → 调 WSL2 内的 vision 容器 HTTP API
```

### 核心思路

1. **PersonalHub 接管所有主机 Agent 职责**（注册/心跳/指标/命令/部署/服务状态）
2. **Docker 容器改为被动 HTTP 服务**：去掉 lease/心跳/上传逻辑，只暴露推理 API
3. **ArtifactLayer 统一处理文件**：下载输入 → 传给容器 → 收集输出 → 上传 → 上报任务结果
4. **PersonalHub AgentLoop 负责租约和任务状态**

### WSL-Docker Runtime

需要新增一个 Runtime Adapter，通过 `wsl -d Ubuntu-22.04 -- docker exec` 或 HTTP 调容器。

更简单的方案：容器内暴露一个简单的 HTTP API：
```
POST /infer  { input_path, output_dir, params }
→ 推理 → 输出文件写入 output_dir
→ 返回 { files: [...], metadata: {...} }
```

PersonalHub 通过 `wsl -d Ubuntu-22.04` 调 `curl http://localhost:{port}/infer`。

---

## 五、职责划分（明确）

| 模块 | 负责 | 不负责 |
|---|---|---|
| **AgentLoop** | 注册/心跳/指标/服务状态/命令/部署/租约/任务状态机 | 文件传输/模型推理 |
| **ArtifactLayer** | 下载输入文件/校验/临时目录/上传输出文件/清理 | 任务调度/租约 |
| **AdminOSConnector** | 所有 HTTP 通信（新增 multipart 上传、文件下载） | - |
| **TaskRouter** | capability 路由 + TaskContext 传递 | - |
| **WslDockerRuntime** | 通过 WSL2 调 Docker 容器 HTTP API | 文件/租约 |
| **ASR/Vision 容器** | 接收输入文件路径 → 推理 → 写入输出文件 | lease/心跳/下载/上传/状态上报 |

---

## 六、方案对比（修订）

| | A: 保留容器+HTTP 代理 | B: CLI 插件 | C: 全改 PersonalHub 原生 |
|---|---|---|---|
| 旧代码改动 | 小（去 lease/心跳/上传） | 中（改为 stdin/stdout） | 大（完全重写） |
| 模型加载 | 容器启动时加载一次 | 每次任务启动加载（慢） | 需自行管理 |
| GPU 访问 | Docker 透传（已验证） | 需验证 | 需验证 |
| Windows 兼容 | ✅ | ⚠️ 需 WSL Python | ⚠️ |
| 实现复杂度 | 低 | 中 | 高 |
| 推荐 | **✅ 推荐** | ❌ | ❌ |

**推荐方案 A**：保留 Docker 容器作为推理服务，容器改为被动 HTTP API，PersonalHub 通过 WSL2 调容器。

---

## 七、具体改动清单

### 7.1 PersonalHub 新增文件

| 文件 | 说明 | 行数估计 |
|---|---|---|
| `src/core/artifact/artifact-layer.ts` | 文件下载/上传/校验/临时目录/清理 | ~200 |
| `src/core/runtime/wsl-docker-runtime.ts` | 通过 WSL2 调 Docker 容器 HTTP API | ~100 |
| `plugins/asr/manifest.json` | ASR 插件 manifest | ~30 |
| `plugins/vision/manifest.json` | Vision 插件 manifest | ~30 |

### 7.2 PersonalHub 修改文件

| 文件 | 改动 | 行数估计 |
|---|---|---|
| `src/core/agent/agent-loop.ts` | processRemoteTask 集成 ArtifactLayer | +30 |
| `src/core/domain/task.ts` | 扩展 TaskContext（workDir, fileRefs） | +15 |
| `src/core/domain/task-router.ts` | 传递 TaskContext | +10 |
| `src/core/connector/adminos-connector.ts` | 新增 downloadInputFile, uploadArtifacts | +50 |
| `src/core/connector/connector.ts` | 接口扩展 | +15 |
| `src/core/runtime/runtime-adapter.ts` | cancel(), progress callback | +10 |
| `src/desktop/main/main.ts` | 注册 WslDockerRuntime | +5 |
| `src/core/app.ts` | runtime 注册 | +5 |

### 7.3 ASR 容器改动

| 改动 | 说明 |
|---|---|
| 新增 HTTP API (Flask/FastAPI) | `POST /infer` 接收 `{inputPath, outputDir, params}` |
| 去掉 | lease 逻辑、心跳、文件下载、上传、状态上报 |
| 保留 | 下载音频（如果有 URL 输入）、调 transcribe_bin、收集输出文件 |
| compose.yaml | 暴露端口（如 5001） |

### 7.4 Vision 容器改动

| 改动 | 说明 |
|---|---|
| 新增 HTTP API | `POST /infer` 接收 `{inputPath, outputDir, params}` |
| 去掉 | lease 逻辑、心跳、文件下载、上传、状态上报 |
| 保留 | 模型加载/卸载、推理、build_prompt |
| compose.yaml | 暴露端口（如 5002） |

### 7.5 服务端（server-zushengcc）

**零改动。** 利用已有通用 Job Lease（`POST /api/hosts/{hostId}/jobs/lease`，匹配 `serviceId IS NULL`）。

Admin 创建任务时**不指定 serviceId**，PersonalHub 通过 capability 路由自动领取。

### 7.6 WSL2 环境

| 改动 | 说明 |
|---|---|
| 停止 adminos-host-daemon.service | `systemctl stop adminos-host-daemon.service` |
| 禁用自启 | `systemctl disable adminos-host-daemon.service` |
| 保留 Docker | ASR/Vision 容器继续运行 |
| 保留计划任务（备用） | 如 PersonalHub 崩溃，可恢复旧系统 |

---

## 八、Windows 部署方式

```
开机自启链:
PersonalHub Electron (startOnLogin: true)
├── AdminOSConnector → https://volc.zusheng.cc
├── AgentLoop (30s tick)
│   ├── 注册/心跳/指标（从 Windows 采集，WSL2 nvidia-smi 查 GPU）
│   ├── 服务状态（通过 plugin healthcheck 检查 WSL2 容器）
│   └── 任务处理
│       ├── ArtifactLayer 下载输入文件到 Windows 临时目录
│       ├── 通过 ArtifactLayer 传到 WSL2 共享路径
│       ├── WslDockerRuntime 调容器 HTTP API 推理
│       └── ArtifactLayer 上传输出文件
│
└── 备用: 旧 WSL2 daemon（disabled 但保留，可随时恢复）
```

---

## 九、分阶段迁移计划（修订版）

### Phase 0：环境验证（已完成 ✅）

**已确认：**
- ✅ Windows 11 + RTX 4060 + CUDA 13.2
- ✅ WSL2 Ubuntu 22.04 运行 adminos-host-daemon
- ✅ Docker 容器存在（ASR/Vision）但已退出
- ✅ 模型文件完整（ASR 12GB, Vision 7.1GB）
- ✅ PersonalHub Electron 已安装，local-only 模式
- ✅ 当前无生产任务在处理中
- ⬜ 待确认：server-zushengcc 后端是否有 pending 任务

**行数估计**: 0（只读，已完成）

### Phase 1：PersonalHub 接入 AdminOS（不领取任务）

**目标**: PersonalHub 连接到 volc.zusheng.cc，完成注册/心跳/指标，但不领取 ASR/Vision 任务

**具体步骤:**
1. 在 PersonalHub 配置中填入 `serverUrl=https://volc.zusheng.cc` 和 `apiKey`
2. 设置 `hostId=win11-4060-home-pb`（不同 hostId 避免冲突）
3. 注册一个测试 capability（`asr.test`），不使用 `asr`/`vision`
4. 验证 AdminOS 控制台看到新主机在线
5. 验证心跳/指标正常
6. 旧 adminos-host-daemon 不受影响

**行数估计**: 0（仅配置变更）

**风险**: 极低（capability 名称隔离）

**回滚**: 清空 serverUrl 配置，恢复 local-only

### Phase 2：构建 ASR/Vision HTTP 容器 + WslDockerRuntime

**目标**: 容器改为被动推理服务，PersonalHub 可以调用

**具体步骤:**
1. 启动 ASR/Vision Docker 容器，确认能正常运行
2. 在容器内新增 HTTP API（Flask 简单接口）
3. 实现 WslDockerRuntime（通过 `wsl -- docker exec` 或 HTTP 调容器）
4. 创建 ASR/Vision 插件 manifest
5. 做一次手动端到端测试（不用任务系统，手动调 API）

**行数估计**: ~400（WslDockerRuntime + HTTP API + manifest）

**风险**: 低（不影响生产，容器可以独立测试）

### Phase 3：实现 ArtifactLayer + 集成

**目标**: 文件下载/上传/临时目录/清理通用能力上线

**具体步骤:**
1. 实现 ArtifactLayer（下载/校验/上传 multipart/重试/清理）
2. AgentLoop.processRemoteTask 集成 ArtifactLayer
3. 扩展 TaskContext（workDir, fileRefs）
4. 用一个测试 ASR 任务跑通完整链路

**行数估计**: ~400（ArtifactLayer + AgentLoop 修改 + 集成）

**风险**: 中（仅影响测试任务，使用 `asr.test` capability）

### Phase 4：切换生产

**目标**: PersonalHub 正式接管 ASR/Vision 生产任务

**具体步骤:**
1. ASR/Vision 插件 capability 改为正式名称（`asr`/`vision`）
2. 停止旧 adminos-host-daemon 的 ASR/Vision 容器
3. **不停止** adminos-host-daemon 本身（保留作为备用，只禁用容器管理）
4. 修改 Admin 任务创建逻辑：不指定 serviceId，让 PersonalHub 领取
5. 观察 24h

**行数估计**: ~50（capability renaming + 部署脚本）

**风险**: 高（生产任务切换）

**回滚方式**:
```bash
# 最快回滚（5 分钟内）:
# 1. PersonalHub 中删除 serverUrl/apiKey → 变为 local-only
# 2. WSL2 内: systemctl start adminos-host-daemon.service
# 3. docker compose up -d (启动旧 ASR/Vision 容器)
# 4. Admin 恢复指定 serviceId
```

### Phase 5：清理

**目标**: 停用 adminos-host-daemon，完全由 PersonalHub 接管

**前置条件**: Phase 4 稳定运行 ≥ 1 周

**具体步骤:**
1. `systemctl disable --now adminos-host-daemon.service`
2. 移除 Windows 计划任务 `AdminOSHostServicesStartAtLogon`
3. 设置 PersonalHub `startOnLogin: true`
4. 文档更新

**行数估计**: 0（运维操作）

**风险**: 低（daemon 在 Phase 4 已不参与生产）

---

## 十、关键文件路径速查

### Windows 11
| 用途 | 路径 |
|---|---|
| server-zushengcc 仓库 | `C:\Users\Zusheng\Desktop\front\server-zushengcc` |
| PersonalHub 安装 | `C:\Users\Zusheng\AppData\Local\Programs\PersonalHub\` |
| PersonalHub 配置 | `C:\Users\Zusheng\AppData\Roaming\PersonalHub\config.json` |
| PersonalHub 日志 | `C:\Users\Zusheng\AppData\Roaming\PersonalHub\logs\` |
| PersonalHub 插件 | `C:\Users\Zusheng\AppData\Roaming\PersonalHub\plugins\` |
| WSL 启动脚本 | `C:\Users\Zusheng\AppData\Local\AdminOS\start-all.ps1` |
| WSL 停止脚本 | `C:\Users\Zusheng\AppData\Local\AdminOS\stop-all.ps1` |

### WSL2 (Ubuntu 22.04)
| 用途 | 路径 |
|---|---|
| adminos-host-daemon 源码 | `/usr/local/bin/adminos-host-daemon` |
| 配置文件 | `/etc/adminos/host-services.env` |
| systemd service | `/etc/systemd/system/adminos-host-daemon.service` |
| 模型目录 | `/srv/models/qwen-asr`, `/srv/models/qwen-vl` |
| Docker compose | `/srv/adminos-host-services/current/compose.yaml` |
| 数据目录 | `/srv/adminos-host-services/data/` |

### macOS（源码）
| 用途 | 路径 |
|---|---|
| PersonalHub 源码 | `/Volumes/PSSD/Dev/front/PersonalHub` |
| server-zushengcc 源码 | `/Volumes/PSSD/Dev/front/server-zushengcc` |
| 旧 host_daemon.py | `apps/server/worker/host-services/scripts/host_daemon.py` |
| 旧 ASR agent | `apps/server/worker/host-services/asr/agent.py` |
| 旧 Vision agent | `apps/server/worker/host-services/vision/agent.py` |

---

## 十一、未确认事项

1. **server-zushengcc 后端是否有 pending ASR/Vision 任务**：需登录 AdminOS 查看
2. **Docker 容器为何 exit 137**：需查看容器日志确认原因（OOM？手动 kill？）
3. **Vision 模型 Qwen2.5-VL-3B-Instruct 在 8GB 显存上推理耗时**：需实测确认
4. **PersonalHub 在 Electron 关闭窗口后是否继续运行 AgentLoop**：当前代码 `window-all-closed` 会 quit，需改为托盘模式
5. **Windows 从睡眠恢复后 WSL2 时钟漂移**：可能影响租约时间判断

---

## 十二、立即可以做的（Phase 0 后续）

1. **在 AdminOS 创建一个 `asr.test` 测试任务**，确认后端 API 正常
2. **在 Docker 内手动跑一次 ASR 推理**，确认容器可以重新启动
3. **查看容器日志**，确认 exit 137 的根本原因
4. **在 PersonalHub 代码中实现 WslDockerRuntime 原型**（macOS 开发，Windows 测试）
5. **将 PersonalHub 源码克隆到 Windows**：`git clone https://github.com/imzusheng/PersonalHub.git`
