# PersonalHub

PersonalHub 是一个开源的个人电脑 AI Worker Runtime，把个人电脑变成可插拔、可本地调用、可选远端调度的 AI 能力节点。

## 定位

PersonalHub 的核心是**主动式 Worker Agent**，不是被动等待外部调用的服务器。

主要通信模式：

```
PersonalHub Desktop / Worker Agent
  → 主动上报 host 状态
  → 主动上报 capabilities
  → 主动拉取任务
  → 调用本地插件执行任务
  → 主动回传任务结果
```

因为个人电脑通常在 NAT、家庭路由器、公司网络后面，外部主动访问本机不稳定也不安全。所以 PersonalHub 选择**客户端主动连接控制面**的模式。

### Local API 的定位

Local API 不是主要远程入口。它的定位是：
- 本机调试
- 桌面 UI 内部调用
- 开发者模式
- 本机其它应用集成

### Connector 的定位

Connector 是未来远端控制面的接入方式。AdminOS 只是未来可选的 Connector 之一，**不绑定本项目**。

## 当前支持

- Plugin Manifest 校验（Zod）
- Plugin Registry（注册、查询、重复检测）
- Capability Registry（路由索引、冲突检测）
- Task Store（内存存储）
- Task Router（创建任务、执行任务、状态流转）
- Mock Runtime（image.describe / audio.transcribe / text.embed）
- Local API（Fastify，绑定 127.0.0.1）
- Connector 抽象（LocalOnlyConnector / MockControlPlaneConnector）
- AgentLoop（手动 tick：上报 → 拉任务 → 执行 → 回传）
- Electron 桌面壳（窗口、系统托盘、最小状态面板）
- Run Agent Tick 按钮
- GitHub Release 自动更新（自动检查、后台下载、进度展示、重启安装）

## 当前不支持

- 真实模型推理
- Docker / WSL / Python venv 运行时
- 真实远端 Connector（GenericHttpConnector / AdminOSConnector）
- WebSocket / 长连接
- 远端账号系统
- 插件市场
- 复杂权限系统
- 安装包签名
- 多机调度
- 后台常驻 Agent Loop（当前只支持手动 tick）
- 任务并发队列
- 数据库

## 如何运行测试

```bash
pnpm test
```

或直接用 vitest：

```bash
npx vitest run
```

## 如何做类型检查

```bash
pnpm typecheck
```

## 如何启动 Local API（纯 CLI，不启动桌面）

```bash
pnpm start
```

启动后会在 127.0.0.1 的随机端口上提供以下 API：

```
GET  /v1/health
GET  /v1/plugins
POST /v1/plugins/register
GET  /v1/capabilities
POST /v1/tasks
GET  /v1/tasks/:taskId
POST /v1/tasks/:taskId/execute
```

## 如何启动 Electron 桌面应用

```bash
pnpm dev:electron
```

这会同时启动 Vite 开发服务器和 Electron。

## 自动更新与发布

自动更新直接使用公开仓库 `imzusheng/PersonalHub` 的 GitHub Release，不依赖 AdminOS。正式安装包启动约 20 秒后自动检查，之后最多每 6 小时检查一次；发现新版本后在后台下载，概览页会展示进度，下载完成后由用户确认“重启并安装”。开发模式不会请求 Release。

发布时先更新 `package.json` 的版本号，再推送同版本 tag，例如版本 `0.1.1` 对应 `v0.1.1`。Release CI 会校验二者一致，并上传：

- Windows：NSIS EXE、`latest.yml` 和 blockmap
- macOS：DMG、ZIP、`latest-mac.yml` 和 blockmap

macOS 自动更新要求应用使用 Apple Developer ID 证书签名。将证书的 base64 或下载地址配置为仓库 Secret `MAC_CSC_LINK`，将证书密码配置为 `MAC_CSC_KEY_PASSWORD`；未配置时仍可生成安装包，但不能把 macOS 自动安装视为可用。Windows 当前可使用未签名 NSIS 更新包，但正式分发时仍建议配置代码签名以减少 SmartScreen 警告。

## 示例：注册插件

```bash
curl -X POST http://127.0.0.1:<port>/v1/plugins/register \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": {
      "id": "vision.mock",
      "name": "Mock Vision",
      "version": "0.1.0",
      "runtime": "mock",
      "capabilities": [{
        "name": "image.describe",
        "inputSchema": {
          "type": "object",
          "required": ["imageUrl"],
          "properties": { "imageUrl": { "type": "string" } }
        },
        "outputSchema": {
          "type": "object",
          "required": ["description"],
          "properties": { "description": { "type": "string" } }
        }
      }],
      "healthcheck": { "type": "mock" }
    }
  }'
```

## 示例：创建任务

```bash
curl -X POST http://127.0.0.1:<port>/v1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "capability": "image.describe",
    "input": { "imageUrl": "file://test.png" }
  }'
```

获取返回的 taskId 后：

```bash
curl -X POST http://127.0.0.1:<port>/v1/tasks/<taskId>/execute
```

## 如何手动验证 agent.tick

### 方式一：Electron UI

启动桌面应用后，Overview 页面有 **Run Agent Tick** 按钮，点击即可执行一次 agent.tick()。

### 方式二：使用 MockControlPlaneConnector

设置环境变量 `PERSONALHUB_CONNECTOR=mock-cp` 启动 Electron，Connector 会切换为 MockControlPlaneConnector，可以测试主动上报 / 拉任务 / 回传结果闭环。

### 方式三：代码中直接调用

```typescript
import { createPersonalHub } from './src/core/app.js';
import { MockControlPlaneConnector } from './src/core/connector/mock-control-plane-connector.js';

const connector = new MockControlPlaneConnector([
  { remoteTaskId: 'r1', capability: 'image.describe', input: { imageUrl: 'file://test.png' } },
]);

const hub = await createPersonalHub({ connector });
const result = await hub.agent.tick();
console.log(result);
// { heartbeatSent: true, capabilitiesPublished: true, tasksProcessed: 1, succeeded: 1, failed: 0, errors: 0 }
```

## 项目结构

```
PersonalHub/
  src/
    core/
      domain/
        plugin-manifest.ts    # Zod manifest 校验
        plugin-registry.ts     # 插件注册
        capability-registry.ts # 能力索引
        task.ts               # Task 类型 + input 校验
        task-store.ts          # 内存任务存储
        task-router.ts         # 任务路由 + 执行
      runtime/
        runtime-adapter.ts    # Runtime 接口
        mock-runtime.ts       # Mock 实现
      connector/
        connector.ts          # Connector 接口 + 类型
        local-only-connector.ts
        mock-control-plane-connector.ts
      agent/
        agent-loop.ts         # AgentLoop（tick）
        host-snapshot.ts      # Host 状态快照
      api/
        server.ts             # Fastify server
        routes/
          health.ts
          plugins.ts
          capabilities.ts
          tasks.ts
      app.ts                  # Core 入口，整合所有组件
    desktop/
      main/
        main.ts               # Electron 主进程
      preload/
        index.ts              # contextBridge 安全暴露 API
      renderer/
        index.html
        main.ts               # 最小状态面板
    index.ts                  # 纯 CLI 入口
  tests/
    core/
      domain/
      api/
      connector/
      agent/
  package.json
  tsconfig.json
  vitest.config.ts
  vite.config.ts
```

## 核心模块职责

### Core Domain
- **PluginManifest**: 用 Zod 校验插件清单，检测缺字段、重复 capability、非法 runtime
- **PluginRegistry**: 插件注册、查询、重复 ID / 冲突 capability 检测
- **CapabilityRegistry**: 能力查询、插件路由索引
- **TaskStore**: 内存任务存储，创建 / 查询 / 更新 / 列表
- **TaskRouter**: 创建任务（校验 capability + input schema），执行任务（找 runtime → 调 adapter → 更新状态）

### Runtime
- **RuntimeAdapter**: 接口定义，未来可扩展 docker / wsl / native
- **MockRuntime**: 返回 mock output，支持 forceError 测试

### Connector
- **Connector**: 接口定义，表达"客户端主动连接控制面"
- **LocalOnlyConnector**: 默认模式，所有方法 no-op
- **MockControlPlaneConnector**: 测试用，记录 heartbeat / capabilities / tasks / results

### AgentLoop
- **AgentLoop.tick()**: 一次完整循环 = 上报 heartbeat → 发布 capabilities → 拉取 tasks → 逐个执行 → push 结果
- 出错时 reportError，不崩溃

## 下一阶段建议

1. **后台常驻 Agent Loop**: 支持 `agent.start(intervalMs)` / `agent.stop()`
2. **GenericHttpConnector**: 支持真实 HTTP 上报 / 拉任务
3. **AdminOSConnector**: 适配 server-zushengcc 控制面
4. **Docker Runtime**: 真实容器化插件运行
5. **WSL Runtime**: Windows WSL 内运行插件
6. **GPU 资源检测**: 上报 GPU 状态
7. **安装包签名**: macOS / Windows 签名
8. **桌面 UI 增强**: 插件管理页、任务历史页
9. **配置持久化**: 插件注册 / Connector 配置持久化到文件
