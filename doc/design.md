# DSH-Approval-Mode 设计文档

> 本文档描述插件的设计目标、架构与关键机制。
> 用户可见的功能说明与安装方式见根目录 [`README.md`](../README.md)；
> 开发流程、版本要求与兼容性校验方法见 [`CONTRIBUTING.md`](../CONTRIBUTING.md)。

## 1. 背景与目标

DSH 的审批系统（`@deepseek-ai/dsh-user-approval`）内置两种会话级策略：

| 策略 | 行为 |
| --- | --- |
| `ask`（默认） | 工具调用需要审批：向已注册的应答器（answerers）发起 `approval/request` 水瀑布，GUI 应答器把请求广播给客户端，用户点击批准/拒绝。 |
| `never` | **直接拒绝**：在到达应答器之前短路，返回 `rejected`（fail closed）。 |

**不存在"自动批准"策略**——`never` 是"直接拒绝"而非"自动批准"。因此"绕过审批"必须由插件实现，且提权豁免没有原生对应物。

**目标**：在 DSH 窗口内、权限选择（access mode）控件旁边，提供可手动选择的「审批模式」控件（默认审批 / 绕过审批（提权除外）/ 绕过审批），绕过模式下工具调用自动放行且不弹出审批提示，并持久保存。

三个模式：

| 模式 | 普通工具调用 | 沙箱提权（工作区外写文件、需更宽沙箱的命令） |
| --- | --- | --- |
| `ask` | 走 DSH 原生审批（点击批准） | 弹窗，用户决定 |
| `bypass-except-escalation` | 自动放行 | **弹窗，用户决定** |
| `bypass` | 自动放行 | 自动放行 |

「提权」指 `@deepseek-ai/dsh-sandbox` 的 `approveEscalation()`：受限调用被拒绝后，模型用 `sandbox_permissions` + `justification` 重试同一次调用，请求一次严格更宽的模式。它是唯一会**放宽**沙箱边界的审批，因此单独成一档。

## 2. 总体架构

插件是一个标准 **DSH 组合包（bundle）**：npm 包 + `dsh.bundle.patch` 层 + `dsh.client` 客户端 manifest，通过官方 `dsh plugin add` 安装进 profile。分两个 half：

```
┌────────────────────────────────────────────────────────────┐
│ DSH Host                                                   │
│ index.js                                                   │
│ ├─ settings 服务注册 namespace "approval-mode"             │
│ │    schema: { defaultMode, sessions{sessionId->mode},     │
│ │              mode（0.1.2 及更早遗留的全局值） }（持久化）│
│ ├─ approval/request 应答器（prepend: true，水瀑布最前端）  │
│ │    bypass                    -> "allowed-once"           │
│ │    bypass-except-escalation  -> 提权 next()，其余放行    │
│ │    ask                       -> next()                   │
│ ├─ webServer 控制路由 GET/POST /approval-mode（回环校验）  │
│ │    地址决定对象：无 session=默认值，?session=会话        │
│ └─ settings/updated 监听 -> 只通知生效模式变了的会话       │
└────────────────────────────────────────────────────────────┘
        same-origin fetch（GET/POST /approval-mode[?session=…]）
┌────────────────────────────────────────────────────────────┐
│ 浏览器（Client）                                           │
│ lib/client.js（__ModuleLoader__ bundle）                   │
│ ├─ 座位 conversation.input.left：「按钮 + 弹出菜单」控件   │
│ │    读写 props.sessionId 指向的会话（缺失时用默认地址）   │
│ ├─ 插件页卡片 settings.plugin.item[key=approval-mode]：    │
│ │    设置 → 插件 → 插件配置 中的配置卡片（读默认值）       │
│ ├─ 每个地址一个 store（useMode），互不冒充                 │
│ └─ 读写 Host 控制路由（fetch，同源）                       │
└────────────────────────────────────────────────────────────┘
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
  const mode = sessionModeOf(ctx.settings.get(NS), req.agent?.session?.id);
  if (mode === "bypass") return "allowed-once";
  if (mode === "bypass-except-escalation") return isEscalationRequest(req) ? next() : "allowed-once";
  return next();
}, true);
```

- `bypass`：直接返回 `allowed-once` —— 链被终结，GUI 应答器不被调用，
  **不会广播 `approval/requested`**，审批提示根本不出现（已验证，见 §5）。
- `bypass-except-escalation`：提权请求调用 `next()`，交回 GUI 应答器弹窗；其余同 `bypass`。
- `ask`：调用 `next()` —— 链继续，GUI 应答器照常 claim，行为与原生一致。

审计闭环不变：`approval.request()` 的 `approval/asked` / `approval/decided`
事件对照常写入会话日志（`allowed-once` 是唯一放行 outcome）。

### 3.1.1 提权的识别与边界

`dsh-sandbox` 的 `approveEscalation()` 发出的审批请求带固定前缀的 reason：

```js
reason: `escalate sandbox to ${mode}: ${justification}`
```

`ApprovalRequestEvent` 只有 `agent / toolName / callId / reason / signal`，
没有任何结构化字段区分审批种类，因此这个前缀是唯一可用的判据
（`ESCALATION_REASON = /^escalate sandbox to [^:]+:/`）。`dsh-tool-bash`、
`dsh-tool-pwsh`、`dsh-tool-fs` 三个受限家族都经它发起，判据因此覆盖全部提权路径。

边界：`reason` 是自由文本。若将来宿主改变了拼写，`bypass-except-escalation`
会退化为普通 `bypass`（自动放行且不再弹窗），不会误拦普通审批——
`scripts/check-host.mjs` 用真实的 reason 字样断言这条契约。

### 3.2 与 `never` 策略的关系

`decide()` 中 `never` 在**到达应答器之前**短路（`approval/request` 根本不会触发）。
因此权限预设 `danger-full-access`（捆绑 `approval: never`）的会话不会产生审批
请求，绕过模式对该会话不生效（README 已提示此边界）。

### 3.3 状态模型

- 模式存于 **settings 服务**（namespace `approval-mode`），持久化（settings.yaml），
  重启后保持。两个值：
  - **`defaultMode`**：打开会话时使用的默认模式，由插件页配置卡片写。
  - **`sessions`**：`{ sessionId → mode }`，每个会话自己的模式，由工具栏按钮写。
  - **`mode`**：0.1.2 及更早版本唯一的全局值，仍然可读；写了 `defaultMode` 之后被遮蔽。
    这样升级不会丢掉用户已有的设置，也不需要写迁移代码。
- schema：`z.object({ mode, defaultMode, sessions: z.dict(...).default({}) })`，
  三个模式值构成封闭词汇；`applies: "live"`（写入立即生效，无需重启）。
- **解析顺序**：`sessions[sessionId]` → `defaultMode` → 遗留 `mode` → `ask`。
  `unknown` / 越界值一律回落到 `ask`（fail closed）。
- Host 应答器每次请求时实时读取 `ctx.settings.get(NS)` 并按请求会话解析，无需事件同步。
- 模式变更时（`settings/updated` 事件，ns 匹配）逐个比较每个在线代理的
  **生效模式**前后是否变化，只向真的变了的会话 `inject` 一条用户消息（尽力而为）。
  改默认值只会通知跟随默认值的会话，改某个会话只通知该会话。

### 3.3.1 控制路由契约

地址决定读写对象，body 只携带值：

| 请求 | 含义 |
| --- | --- |
| `GET /approval-mode` | 默认模式（`mode` = `defaultMode`，另附 `defaultMode`） |
| `GET /approval-mode?session=<id>` | 该会话的生效模式（无自有模式时等于默认值） |
| `POST /approval-mode` `{mode}` | 写默认模式 |
| `POST /approval-mode?session=<id>` `{mode}` | 写该会话的模式 |

回环校验（`isLoopbackRequest`）在读写之前；非法 mode → 400 `invalid-mode`，
非法 JSON → 400 `bad-json`，其他方法 → 405，非回环 → 403。
`?session=`（空值）等同于不带该参数，即默认地址。

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

**差异点（有意）**：两个绕过模式都使用警告色 `--dsw-alias-state-warn-primary`
（安全提示）；图标区分三态——默认审批为实心盾牌，提权除外为空心盾牌，
全部绕动为闪电。

**Full Access 联动**：组件通过 standard props 的 `useProjection("permissions")`
订阅会话权限投影（响应式，切换权限即时更新）。当 `currentValue ===
"danger-full-access"` 时（DSH 策略 `never`，不会发起审批请求，绕过无意义）：
按钮**置灰禁用**（disabled 样式 `--dsw-alias-label-dimmed`），并显示「绕过审批」
（与实际"全部放行"行为一致），title 说明原因；点击不产生任何写入。

client bundle 无法 import primitives 的 `Menu`/图标组件，菜单与内联 SVG 图标
（shield / bolt / check / chevron）均为自绘；样式通过 `document.createElement("style")`
注入，随插件 fiber 清理。

**会话地址的来源**：`conversation.input.left` 是 `scope: "session"` 座位，
standard props 注入 `sessionId`（`dsh-client-ui-session` 的 `BUILTIN_SOURCE`）。
控件用它构造会话地址，因此切换按钮改的是当前会话。宿主没给 `sessionId` 时
（受支持宿主不会发生：composer 本身以 `sessionId !== undefined` 为渲染前提）
控件回落到默认地址，也就是 0.1.2 的行为——这是可用的降级，不是死按钮。

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

**两个值，两个界面**：卡片写 `defaultMode`，工具栏按钮写 `sessions[sessionId]`。
client 侧按地址建 store（`storeFor(sessionId)`，`null` 即默认地址），
`useMode(address)` 订阅其中一个，因此两者不会互相冒充：卡片不会显示某个会话的
临时选择，工具栏也不会把默认值当成当前会话的值。没有自有模式的会话跟随默认值，
所以它的 store 同时订阅默认 store，默认值一改就重读自己的生效值——否则按钮会
继续显示一个 Host 已经不再为它解析的值。

状态机的三条不变式（每个地址的 store 各自持有，且由 `scripts/check-client.mjs` 覆盖）：

- **`known`** 表示 `mode` 是否真的来自 Host。读取失败时置 false，界面显示
  「未知」（按钮置灰、卡片不选中任何选项），**不把 schema 默认值当作当前设置**。
- **`confirmed`** 是 Host 最后确认过的值（读成功或写成功），也是写入失败时**唯一**
  的回滚目标。若回滚到上一次乐观值，两次选择重叠时就会显示一个 Host 从未接受过的模式。
- **`generation`** 双向设栅：写入只由最新一次选择收尾；读取结果若已被后续选择取代则
  丢弃，不再发布过期模式。被取代但**成功**的写入仍会更新 `confirmed` —— Host 确实应用了它，
  但只有**最新**一次成功可以成为回滚目标（响应可能乱序返回）。

**语义**：`defaultMode` 是「打开会话时使用的审批模式」，工具栏按钮不再改写它；
`bypass` 与 `bypass-except-escalation` 的区别是后者把提权留给用户（§3.1、§3.1.1）。

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
- **peer 全部标 `optional`**：profile 的 `pnpm-workspace.yaml` 设了
  `autoInstallPeers: false`，而这些 peer 由上一层共享层提供、pnpm 看不到，因此
  `pnpm peers check` 必然把它们报成 `missing peer`。`peerDependenciesMeta.optional = true`
  让 pnpm 不再报这些必然的缺失，同时**保留 `peerDependencies` 里的版本范围**——
  dsh-market 的浏览期兼容性判定读的正是它。宿主版本下界另由顶层
  `engines.dsh` 显式声明（见 [CONTRIBUTING.md §3](../CONTRIBUTING.md#3-版本要求与兼容性)）。
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

`link:` 安装会删除源目录、link 安装解析不到 DSH 共享层、pnpm ≥10 拒绝构建脚本——
三条开发坑与规避方式见 [CONTRIBUTING.md §6](../CONTRIBUTING.md#6-开发坑)。

### 3.7 版本要求与兼容性

版本要求有两个声明处：`package.json` 的 `engines.dsh`（宿主版本下界）与
`peerDependencies`（各共享包的可用范围）。每条范围对应的依据、上界为何不设、
peer 为何标 `optional`、以及逐版本校验方法见
[CONTRIBUTING.md §3–§4](../CONTRIBUTING.md#3-版本要求与兼容性)。

## 4. 源码结构

目录结构与各文件职责见 [CONTRIBUTING.md §1](../CONTRIBUTING.md#1-目录结构)。

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
  apply 就位（`[dsh-approval-mode] loaded: default mode = …` 启动行自 0.1.1-rc.4 起打印，
  此前靠 settings 注册成功与路由应答间接确认）。
- 控制路由实测（0.1.2 时的单值契约，现值见 §3.3.1）：
  - `GET /approval-mode` → `{"ok":true,"mode":"ask","defaultMode":"ask"}`
  - `POST {"mode":"bypass"}` → `{"ok":true,"mode":"bypass","changed":true}`；
    实例日志出现 `settings/updated`（代理通知就位）
  - 无效 mode → HTTP 400
  - **持久化**：重启实例后 `GET` 仍返回 `bypass`（settings.yaml 落盘）
- Client bundle：`GET /plugins/dsh-approval-mode/client.js` → 200（进 web graph）。

### 5.3 0.1.5-rc.2 兼容性校验（2026-09）

逐 API 对照表、运行时证据（宿主日志、`settings.yaml`）、GUI 外请求得到 403 的原因，
以及离线契约检查的断言清单与反向验证方法，全部记在
[CONTRIBUTING.md §4](../CONTRIBUTING.md#4-兼容性校验怎么做)（含校验记录）。

### 5.4 提权豁免与按会话模式（0.1.3 开发期，离线验证）

- `scripts/check-host.mjs`：应答器在 `bypass-except-escalation` 下对真实 reason
  （`escalate sandbox to danger-full-access: …`）调用 `next()`、对普通请求返回
  `allowed-once`，`bypass` 对两者都放行，`ask` 对两者都委派；模式按会话解析、
  默认值兜底；遗留 `mode` 仍决定默认值；控制路由的地址语义与四类拒绝。
- `scripts/check-client.mjs`：工具栏读写会话地址、卡片读写默认地址且互不冒充；
  三选项渲染与词典键完整性。
- 反向验证：把提权分支改回 `allowed-once` ⇒ host 检查 2 条失败；把写路径的地址
  换回 `ROUTE_PATH` ⇒ client 检查 1 条失败。

## 6. 已知边界与后续

- 已有会话的模式不随默认值变化：改默认值只影响之后打开的会话，已在运行的会话保持
  自己的生效模式（跟随默认值且没有自有覆盖的会话会立即跟随新默认值）。
- 多窗口模式同步：settings/updated 事件 + 各窗口重新读取；同一窗口内每个地址由各自的
  store 同步，会话 store 另订阅默认 store 以跟随默认值。
- 会话模式按 session id 永久保存在 `settings.yaml` 的 `sessions` 里，随会话数线性增长，
  不做过期清理（会话本身是长期可恢复的）。
- 提权识别依赖 `dsh-sandbox` 的 reason 前缀文本，宿主改拼写即退化为普通 `bypass`
  （§3.1.1）。
- 插件页卡片依赖宿主客户端 `settingsScope` 服务（0.1.0-rc.7+）：该下界低于本插件声明的
  DSH 下界，故只影响**未组装 `dsh-client-ui-settings`** 的非常规组合，此时只有卡片不出现
  （§3.4.1、CONTRIBUTING §3.5）。
- 可发布 npm（`npm publish`）后 `dsh plugin add dsh-approval-mode`。
