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
│  ├─ 座位 conversation.input.left：「按钮 + 弹出菜单」控件       │
│  ├─ 插件页卡片 settings.plugin.item[key=approval-mode]：       │
│  │    设置 → 插件 → 插件配置 中的配置卡片（分段控件）           │
│  ├─ 两个界面共享一个模块级 store（useMode），改一处两处同步     │
│  └─ 读写 Host 控制路由（fetch，同源）                          │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 为什么用 webServer 路由而非 settings RPC

- 动态插件版曾用 `harness.handle` 包私有 RPC（`approvalMode/get`、`approvalMode/set`）；
  静态 bundle 中该机制不可用（`host.call` 是动态插件 builtin）。
- **settings RPC 语义随 DSH 演进**：早期 `dsh-host-apiproxy` 有硬编码暴露白名单
  （`exposedNamespaces()` = `modelProviderNamespaces()` + `WEB_SETTINGS_NAMESPACES`
  + `PRODUCT_SETTINGS_NAMESPACES`，白名单外返回 `settings-not-exposed`）；
  在 0.1.1-rc.2 中该白名单已移除，`settings.describe()` 返回所有已注册命名空间，
  写路径仅按命名空间是否已注册来门控（未注册返回 `settings-rejected`）。
  插件不再依赖这些内部符号，改走自包含的控制路由，避免与 settings RPC 的
  写入语义耦合。
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

### 3.4.1 插件页配置卡片（设置 → 插件 → 插件配置）

`@deepseek-ai/dsh-client-ui-settings-plugins` 的「插件」分区把**被服务的 settings
命名空间**与注册进 `settings.plugin.item` 槽位的卡片做**交集**渲染：

```js
// ConfigurablePluginsTabController.publish()
const served = new Set(describe().namespaces.map((view) => view.ns));
const namespaces = entries().flatMap((e) => served.has(e.options.key) ? [e.options.key] : []);
```

因此卡片能否出现由两件事决定，且两件都成立才渲染：

1. **Host 侧注册了该命名空间**——`ctx.settings.register(NS, …)`；`settings.describe()`
   在 0.1.1-rc.2 之后返回所有已注册命名空间（无白名单），本插件因此无需额外声明。
2. **浏览器侧以该命名空间为 `key` 注册卡片**——本插件的 `apply()`：

```js
ctx.inject(["settingsScope"], (scoped) => {
  scoped.slots.inject("settings.plugin.item", () => scoped.slots.register(
    { name: "settings.plugin.item", key: NS, locale: NS }, ApprovalModeSettingsCard));
});
```

**为什么用嵌套 `inject` 而不是模块级 `inject`**：`settingsScope` 由
`dsh-client-ui-settings` 提供（0.1.0-rc.7 起）。写进模块级 `inject` 会让整个插件
（包括输入框按钮）在旧宿主上一起不挂载；嵌套 inject 让宿主没有该服务时只是
**不注册这张卡片**。这条降级路径由 `scripts/check-client.mjs` 断言。

**卡片自带全部外观**：分区只提供 `<ul>`，卡片自己画。视觉逐条对齐宿主
`PluginCard`（`border .5px / radius 16px / header padding 14px 16px / chevron 旋转
.16s`），因为跨包 value import 在 client bundle 中不可用（bundle-purity 门禁）。

**一个设置，两个界面**：卡片与工具栏按钮写的是同一个 `mode`。两者共享模块级
`modeStore`（`useMode()` 订阅），任一界面写入后另一个立即跟随，不需要刷新；
读取只在首个订阅者出现时发生一次，读写失败时**保留最后一次生效的值**并在卡片上
显示错误行，而不是伪造 `ask`。

**语义**：该设置是「打开会话时使用的审批模式」，同时也是当前生效值（Host 应答器
每次请求实时读取），并且在工具栏点击时同样被改写——文案明确写了这一点，不暗示
存在 per-session 覆盖（那是 §6 的后续工作）。

### 3.5 打包与安装（bundle 规范）

包结构（对齐官方发布指南与 `dsh-better-sidebar` 先例）：

```
dsh-approval-mode/
├── package.json      # dsh.bundle.patch + dsh.client + exports {"./client"}
├── cordis.patch.yml  # - insert: [{ id: dsh-approval-mode, name: dsh-approval-mode }]
├── index.js          # Host half（ESM，import @deepseek-ai/schemastery）
└── lib/client.js     # Client half（window.__ModuleLoader__.load({id, factory})）
```

- **依赖声明**：`@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery` 均为 DSH 宿主
  共享包（宿主 `dsh-plugin-desktop` 自身携带），放 `peerDependencies`，由 DSH
  共享依赖层 `$DSH_HOME/profiles/node_modules` 解析，避免在插件的 `node_modules`
  里装独立拷贝而遮蔽宿主版本（本地开发用 `devDependencies` 补齐这两项）；
  `@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`react` 同样放
  `peerDependencies`（与 better-sidebar 先例一致）。
- **Client manifest**：`dsh.client = { inject: ["@deepseek-ai/dsh-client-runtime"],
  platform: "web" }`——client-modules 扫描 host loader entries 中声明 `dsh.client`
  的包，将其 `./client` 导出作为 bundle 提供给浏览器（列表只用于模块图排序，
  图上不存在的名字会被跳过，见 §3.4.1 的嵌套 inject）。
- **bundle 格式**：`window.__ModuleLoader__.load({ id, factory })`，factory 为
  CJS 风格（`require("react")` 解析平台 seed 词）；导出 `{ name, inject, apply }`。
- **client 运行时服务**：模块级 `inject: ["slots", "locale"]`——slots 注册 UI 座位，
  locale 提供词典注册与座位注入的 `t`；可选服务（`settingsScope`）走嵌套
  `ctx.inject`，只有它缺失时不拖垮整个插件。
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

### 3.7 版本要求与兼容性

**声明位置就是 `package.json` 的 `peerDependencies`**：dsh-market 的兼容性预检
（`assessCompatibility` → `classifyPeer`）读的正是各插件 peer 范围与 profile 中
已解析的宿主版本，并把不一致判成 `belowMin`（低于声明下界 = 环境太旧）或
`aboveMax`（高于显式上界）。它另外会警告把 DSH 共享宿主包写进 `dependencies`
的插件（可能遮蔽宿主版本）——本插件的 DSH 包**全部只在 `peerDependencies`**，
`dependencies` 为空。

当前声明（与本插件实际消费的 API 一一对应）：

| peer | 范围 | 依据 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `^0.1.1-rc.2` | `createUserMessage`：稳定消息标识自 0.1.1-rc.2 起必需（否则会话恢复失败） |
| `@deepseek-ai/dsh-settings` | `^0.1.1-rc.2` | settings 服务的 `register/get/update`；与 dsh-llm 同属 DSH 核心版本线 |
| `@deepseek-ai/cordis` | `^4.0.1` | `ctx.on(…, true)` prepend、`ctx.inject`、`ctx.effect` |
| `@deepseek-ai/schemastery` | `^3.18.1` | namespace schema |
| `react` | `^18.2.0` | client bundle（宿主 seed 模块提供） |

**上界不设**（caret 只界到 0.2.0）：插件只用稳定公开服务——`settings`、
`webServer`、`approval/request` 水瀑布、slot 座位——不依赖内部符号，
这也是 §2.1 放弃 settings RPC 白名单与 typert Remote 的直接收益。

**逐版本校验记录见 §5.3**；对外描述（用户可见的那份）写在两份 README 的
`> [!NOTE]` 里，并保持与本表一致。

## 4. 源码结构

```
dsh-approval-mode/
├── README.md            # 用户可见功能 + 风险提示 + 安装说明 + 版本说明
├── README.en.md         # 同上（英文）
├── doc/design.md        # 本文档
├── package.json         # bundle manifest（dsh.bundle + dsh.client + peer 版本要求）
├── cordis.patch.yml     # 组合层：插入插件行
├── index.js             # Host half（应答器 + settings + 代理通知）
├── lib/client.js        # Client half（工具栏控件 + 插件页配置卡片）
└── scripts/
    ├── dshClient.js     # 轻量 DSH 回环 API 客户端（HTTP + WebSocket，自包含）
    ├── listen-only.mjs  # 审批帧监听验证脚本（不应答）
    └── check-client.mjs # 离线 client bundle 契约检查（无依赖，CI 用）
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
  apply 就位（`[dsh-approval-mode] loaded: mode = …` 启动行自 0.1.1-rc.4 起打印，
  此前靠 settings 注册成功与路由应答间接确认）。
- 控制路由实测：
  - `GET /approval-mode` → `{"ok":true,"mode":"ask","defaultMode":"ask"}`
  - `POST {"mode":"bypass"}` → `{"ok":true,"mode":"bypass","changed":true}`；
    实例日志出现 `settings/updated: mode = bypass`（代理通知就位）
  - 无效 mode → HTTP 400
  - **持久化**：重启实例后 `GET` 仍返回 `bypass`（settings.yaml 落盘）
- Client bundle：`GET /plugins/dsh-approval-mode/client.js` → 200（进 web graph）。

### 5.3 0.1.5-rc.2 兼容性校验与离线契约检查（2026-09）

实测环境：DSH Desktop 2.0.11 / node v24.18.1 / `@deepseek-ai/*` 共享层
`0.1.5-rc.2`（`cordis` 4.0.2、`schemastery` 3.18.2），插件以
`git+https://github.com/NEVSTOP-LAB/dsh-approval-mode.git` 装在 `desktop` profile。

**按 API 逐个核对**（读宿主实现，不靠记忆）：

| 插件用法 | 0.1.5-rc.2 中的实现位置 | 结论 |
| --- | --- | --- |
| `ctx.settings.register(ns, schema, {applies})` | `dsh-settings` `SettingsProvider.register` | 一致；`describe()` 已无白名单，返回全部已注册命名空间 |
| `ctx.webServer.register({kind:"exact",path,handler})` | `dsh-host-webserver` `register` | 一致（重复 (kind,path) 抛错） |
| `ctx.on("approval/request", fn, true)`（prepend） | `dsh-user-approval` `ctx.waterfall(…, "approval/request", …)` | 一致 |
| `createUserMessage` | `dsh-llm` 导出表 | 一致 |
| `slots.register({name,id/order/label,locale})` + `props.t` | `dsh-client-ui-renderer`（`entry.locale` → `kit.t`） | 一致 |
| `props.useProjection("permissions")` | 标准 props（`dsh-client-ui-conversation` 等） | 一致 |
| `settings.plugin.item`（keyed slot）+ `settingsScope` | `dsh-client-ui-settings-plugins` / `dsh-client-ui-settings` | 一致；卡片 keyed by `approval-mode` |

**运行时证据**：

- 宿主日志 `[dsh-market] hot-mounted dsh-approval-mode`，无插件相关错误、
  `logs\host\*.error.log` 无本插件条目（0.1.5-rc.2 上正常挂载）。
- `$DSH_HOME/settings.yaml` 中存在 `approval-mode: { mode: bypass }` 且写入时间
  为当天：命名空间注册与 `settings.update` 写入路径在 0.1.5-rc.2 上工作正常。
- 控制路由在 GUI 外直接请求会得到 **403**：那是 DSH Desktop 的浏览器访问围栏
  （`lib/webserver.js` → `decideDesktopBrowserAccess`，无 renderer header 且未开启
  普通浏览器访问时一律 403 `forbidden`），**不是插件路由的问题**——Electron 窗口
  自带该 header，页面内同源 fetch 正常。把它当成插件故障会误判。

**离线契约检查**（`scripts/check-client.mjs`，已并入 `npm run check` / CI）：
以 stub 的 `window.__ModuleLoader__`、`document`、`react`、`fetch` 加载
`lib/client.js`，断言：两个界面各自注册进正确槽位、卡片 `key` = settings 命名空间、
无 `settingsScope` 的宿主只丢卡片不丢按钮、卡片渲染出两个选项且当前值选中、
点击后 `POST /approval-mode` 的 body 正确、卡片用到的词典 key 中英文都存在。
**反向验证**：把 `key: NS` 改成 `key: NS + "-probe"`，脚本报
`FAIL plugin card registered into settings.plugin.item keyed by the settings namespace`
并以退出码 1 结束（已实测）。

## 6. 已知边界与后续

- 模式全局生效（不区分会话）：插件页配置卡片设置的「打开会话时的默认模式」与
  工具栏按钮改的是同一个值。如需 per-session 覆盖，可扩展为 settings 默认 +
  会话覆盖（需自定义 RPC 或事件通道）。
- 多窗口模式同步：settings/updated 事件 + 各窗口重新读取；同一窗口内两个界面由
  模块级 `modeStore` 同步。
- 插件页卡片依赖宿主客户端 `settingsScope` 服务（0.1.0-rc.7+）；更旧的宿主上
  卡片不出现，其余功能不受影响（§3.4.1、§5.3）。
- 可发布 npm（`npm publish`）后 `dsh plugin add dsh-approval-mode`。
