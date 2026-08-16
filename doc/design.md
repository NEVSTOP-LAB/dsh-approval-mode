# DSH-Approval-Mode 设计文档

> 本文档描述插件的设计目标、架构、关键机制与验证记录，供维护与二次开发参考。
> 用户可见的功能说明与安装方式见根目录 [`README.md`](../README.md)。

## 1. 背景与目标

DSH 的审批系统（`@deepseek-ai/dsh-user-approval`）内置两种会话级策略：

| 策略 | 行为 |
| --- | --- |
| `ask`（默认） | 工具调用需要审批：向已注册的应答器（answerers）发起 `approval/request` 水瀑布，GUI 应答器把请求广播给客户端，用户点击批准/拒绝。 |
| `never` | **直接拒绝**：在到达应答器之前短路，返回 `rejected`（fail closed）。 |

**不存在"自动批准"策略**——`never` 是"直接拒绝"而非"自动批准"。因此"绕过审批"必须作为第三态由插件实现。

**目标**：在 DSH 窗口内、权限选择（access mode）控件旁边，提供可手动选择的「审批模式」控件（默认审批 / 绕过审批），绕过审批时所有工具调用自动放行且不弹出审批提示，并持久保存。

## 2. 总体架构

插件是一个标准 **DSH 组合包（bundle）**：npm 包 + `dsh.bundle.patch` 层 + `dsh.client` 客户端 manifest，通过官方 `dsh plugin add` 安装进 profile。分两个 half：

```
┌────────────────────────── DSH Host ──────────────────────────┐
│  index.js                                                      │
│  ├─ settings 服务注册 namespace "approval-mode"               │
│  │    schema: { mode: "ask" | "bypass" }（默认 ask，持久化）   │
│  ├─ approval/request 应答器（prepend: true，水瀑布最前端）     │
│  │    bypass → 直接返回 "allowed-once"                        │
│  │    ask    → next()（走 DSH 原有审批流程）                   │
│  ├─ webServer 控制路由 GET/POST /approval-mode（回环校验）     │
│  └─ settings/updated 监听 → 通知所有在线代理                   │
└──────────────────────────────────────────────────────────────┘
        same-origin fetch（GET/POST /approval-mode）
┌────────────────────────── 浏览器（Client）────────────────────┐
│  lib/client.js（__ModuleLoader__ bundle）                      │
│  ├─ 注册 conversation.input.left 座位（权限控件旁边）          │
│  ├─ 渲染「按钮 + 弹出菜单」控件（复刻 PermissionSelect 视觉）   │
│  └─ 读写 Host 控制路由（fetch，同源）                          │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 为什么用 webServer 路由而非 settings RPC

- 动态插件版曾用 `harness.handle` 包私有 RPC（`approvalMode/get`、`approvalMode/set`）；
  静态 bundle 中该机制不可用（`host.call` 是动态插件 builtin）。
- **settings RPC 有硬编码暴露白名单**：`dsh-host-apiproxy` 的
  `exposedNamespaces()` = `modelProviderNamespaces()` + `WEB_SETTINGS_NAMESPACES`
  + `PRODUCT_SETTINGS_NAMESPACES`（固定列表，注释明确"第三方注册的 namespace
  默认不对配置客户端可见"），白名单外返回 `settings-not-exposed`，且**无法扩展**。
  实测：Host 端 `ctx.settings.get` 可读（注册成功），但 `api.settings.describe`
  不返回该 namespace。
- typert Remote 的 client 端 `$mount` 需要编译器生成的严格描述符，手写成本高。
- **最终方案**：模式仍存 settings 服务（Host 内部读写，不受白名单影响），
  client 通过 Host 在公开 `webServer` 服务上注册的**控制路由**
  `GET/POST /approval-mode`（同源 fetch）读写。路由自带回环 Host 校验
  （防御 `0.0.0.0` 部署）。

## 3. 关键机制

### 3.1 绕过审批：水瀑布抢先应答

审批决策链（`dsh-user-approval` 的 `ApprovalService.decide`）：

```js
// approval.request() 先 append approval/asked，再进入决策
if (policy === "never") return "rejected";          // 策略短路
const answer = ctx.waterfall("approval/request", req, () => "unavailable");
```

`approval/request` 是 **waterfall**（Cordis 事件）：监听器按注册顺序执行，
**先注册者先执行**；不调用 `next()` 即终结整条链。DSH 的 GUI 应答器
（`dsh-host-apiproxy`）在 Host 启动时注册，总是 claim 请求（挂起等待客户端
应答并广播 `approval/requested`）。若本插件按普通顺序注册，将永远轮不到执行。

**解法**：以 `prepend: true` 注册，使应答器排在链的最前端：

```js
ctx.on("approval/request", async (req, next) => {
  if (modeOf(ctx.settings.get(NS)) === "bypass") return "allowed-once";
  return next();
}, true);
```

- `bypass`：直接返回 `allowed-once` —— 链被终结，GUI 应答器不被调用，
  **不会广播 `approval/requested`**，审批提示根本不出现（已验证，见 §5）。
- `ask`：调用 `next()` —— 链继续，GUI 应答器照常 claim，行为与原生一致。

审计闭环不变：`approval.request()` 的 `approval/asked` / `approval/decided`
事件对照常写入会话日志（`allowed-once` 是唯一放行 outcome）。

### 3.2 与 `never` 策略的关系

`decide()` 中 `never` 在**到达应答器之前**短路（`approval/request` 根本不会触发）。
因此权限预设 `danger-full-access`（捆绑 `approval: never`）的会话不会产生审批
请求，绕过模式对该会话不生效（README 已提示此边界）。

### 3.3 状态模型

- 模式存于 **settings 服务**（namespace `approval-mode`），全局生效（作用于
  所有会话），**持久化**（settings.yaml），重启后保持。
- schema：`z.object({ mode: z.union(["ask", "bypass"]).default("ask") })`，
  `applies: "live"`（写入立即生效，无需重启）。
- Host 应答器每次请求时实时读取 `ctx.settings.get(NS)`，无需事件同步。
- 模式变更时（`settings/updated` 事件，ns 匹配）遍历 `ctx.agents.list()`
  向每个在线代理 `inject` 一条用户消息，使其感知模式变化（尽力而为）。

### 3.4 UI 位置与视觉

**座位选择**：`conversation.input.left`（composer 工具行左端、resident chrome
（access mode / plan / attach）之后的 list 座位，`replaceRisk: none`），即权限
控件旁边的常驻小控件位。Slot 契约：`{ id, order?, label? }` + standardProps。

**视觉对齐**：旁边权限控件（`dsh-client-ui-conversation` 的 `PermissionSelect`）
是「按钮 + 向上弹出菜单」，**不是原生 `<select>`**。本插件复刻其精确样式：

| 元素 | 规格（取自 PermissionSelect.module.css） |
| --- | --- |
| trigger | 高 28px；圆角 24px；padding `0 4px 0 8px`；font 13px/500；色 `--dsw-alias-label-secondary`；hover 背景 `--dsw-alias-interactive-bg-hover`；focus-visible 光环 `--dsw-alias-border-l3` |
| chevron | `--dsw-alias-label-caption`；点击旋转 180°（0.12s 过渡） |
| 菜单 | 向上弹出（side: top，`bottom: calc(100% + 6px)`）；`--dsw-alias-bg-overlay` 背景；圆角 10px；菜单项 hover 高亮、选中品牌色 + 对勾 |

**差异点（有意）**：绕过审批时 trigger 与菜单项使用警告色
`--dsw-alias-state-warn-primary`（安全提示），图标切换为闪电；默认审批为盾牌。

**Full Access 联动**：组件通过 standard props 的 `useProjection("permissions")`
订阅会话权限投影（响应式，切换权限即时更新）。当 `currentValue ===
"danger-full-access"` 时（DSH 策略 `never`，不会发起审批请求，绕过无意义）：
按钮**置灰禁用**（disabled 样式 `--dsw-alias-label-dimmed`），并显示「绕过审批」
（与实际"全部放行"行为一致），title 说明原因；点击不产生任何写入。

client bundle 无法 import primitives 的 `Menu`/图标组件，菜单与内联 SVG 图标
（shield / bolt / check / chevron）均为自绘；样式通过 `document.createElement("style")`
注入，随插件 fiber 清理。

### 3.5 打包与安装（bundle 规范）

包结构（对齐官方发布指南与 `dsh-better-sidebar` 先例）：

```
dsh-approval-mode/
├── package.json      # dsh.bundle.patch + dsh.client + exports {"./client"}
├── cordis.patch.yml  # - insert: [{ id: dsh-approval-mode, name: dsh-approval-mode }]
├── index.js          # Host half（ESM，import @deepseek-ai/schemastery）
└── lib/client.js     # Client half（window.__ModuleLoader__.load({id, factory})）
```

- **依赖声明**：`@deepseek-ai/schemastery` 放 `dependencies`（Host 代码真实
  import，必须出现在 profile 的 pnpm 树）；`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-settings`、`react` 放 `peerDependencies`（由 DSH 共享依赖层
  `$DSH_HOME/profiles/node_modules` 解析，与 better-sidebar 先例一致）。
- **Client manifest**：`dsh.client = { inject: ["@deepseek-ai/dsh-client-runtime",
  "@deepseek-ai/dsh-client-connection"], platform: "web" }`——client-modules
  扫描 host loader entries 中声明 `dsh.client` 的包，将其 `./client` 导出作为
  bundle 提供给浏览器。
- **bundle 格式**：`window.__ModuleLoader__.load({ id, factory })`，factory 为
  CJS 风格（`require("react")` 解析平台 seed 词）；导出 `{ name, inject, apply }`。
- **client 运行时服务**：`inject: ["slots", "connection"]`——slots 注册 UI 座位，
  connection 提供 settings RPC 的 api。
- **slot 组件拿 ctx**：slot 组件 props 不含 ctx，apply 时闭包捕获到模块级变量。

### 3.6 已知坑

1. **`dsh plugin remove` 对 `link:` 安装的依赖会删除 link 目标目录内容**
   （本次开发中源目录被清空）。开发验证请用 tarball 安装（`add ./x.tgz`），
   不要对 `link:` 安装执行 remove。
2. **link: 目录安装时 Node 从包真实路径解析 import**，找不到 DSH 共享层
   （`@deepseek-ai/*`）；tarball / npm / git 安装由 pnpm store 管理依赖，无此问题。
3. **pnpm ≥10 拒绝依赖的构建脚本**：如安装报 `ERR_PNPM_IGNORED_BUILDS`，
   按官方指南在 profile 的 `pnpm-workspace.yaml` 添加
   `allowBuilds: { <pkg>: true }`。本插件无构建脚本，不受影响。

## 4. 源码结构

```
dsh-approval-mode/
├── README.md            # 用户可见功能 + 风险提示 + 安装说明
├── doc/design.md        # 本文档
├── package.json         # bundle manifest（dsh.bundle + dsh.client）
├── cordis.patch.yml     # 组合层：插入插件行
├── index.js             # Host half（应答器 + settings + 代理通知）
├── lib/client.js        # Client half（按钮+弹出菜单控件）
└── scripts/
    ├── dshClient.js     # 轻量 DSH 回环 API 客户端（HTTP + WebSocket，自包含）
    └── listen-only.mjs  # 审批帧监听验证脚本（不应答）
```

## 5. 验证记录

### 5.1 动态插件版（前身，apprv-1）

- `conversation.input.left` 座位 occupants 含 `approval-mode-select`（active）。
- 绕过审批端到端（mux 监听实录）：`approval/asked` → `approval/decided
  {outcome:"allowed-once"}`，**无 `approval/requested` 帧**（提示未广播）。
- ask 模式回归：`approval/requested` 正常广播（原生流程）。

### 5.2 bundle 版（静态，验证通过）

- `dsh plugin --profile <name> add ./dsh-approval-mode-0.1.0.tgz` 安装成功，
  profile `dsh.profile.bundles` 正确追加。
- `dsh --profile <name> --dump-config` 出现 `# == dsh-approval-mode` 层。
- 测试实例启动：插件行 `include:dsh-approval-mode` fiberPhase `active`；
  apply 日志确认 settings 注册、应答器（prepend）、路由、监听器全部就位。
- 控制路由实测：
  - `GET /approval-mode` → `{"ok":true,"mode":"ask","defaultMode":"ask"}`
  - `POST {"mode":"bypass"}` → `{"ok":true,"mode":"bypass","changed":true}`；
    实例日志出现 `settings/updated: mode = bypass`（代理通知就位）
  - 无效 mode → HTTP 400
  - **持久化**：重启实例后 `GET` 仍返回 `bypass`（settings.yaml 落盘）
- Client bundle：`GET /plugins/dsh-approval-mode/client.js` → 200（进 web graph）。

## 6. 已知边界与后续

- 模式全局生效（不区分会话）；如需 per-session，可扩展为 settings 默认 +
  会话覆盖（需自定义 RPC 或事件通道）。
- 多窗口模式同步：settings/updated 事件 + 各窗口重新读取。
- 可发布 npm（`npm publish`）后 `dsh plugin add dsh-approval-mode`。
