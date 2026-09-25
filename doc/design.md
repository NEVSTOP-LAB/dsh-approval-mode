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

**目标**：在 DSH 窗口内、权限选择（access mode）控件旁边，提供可手动选择的「审批模式」控件（默认审批 / 绕过审批（提权除外）/ 绕过审批），绕过模式下普通工具调用自动放行且不弹出审批提示——**提权除外那一档仍会弹窗**，见下表——并持久保存。

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
│ ├─ 默认模式 = 插件 Config.defaultMode（.volatile() 实时）   │
│ │    0.1.7+：宿主按 Config schema 渲染配置表单，写入后就地   │
│ │            更新引用（不重挂插件）                          │
│ │    <=0.1.6：走遗留 settings 命名空间 "approval-mode"      │
│ │    （该服务仍有 register 时注册并读写；遗留 mode 仍可读）  │
│ ├─ 按会话模式 = $DSH_HOME/approval-mode/sessions.json       │
│ │    { sessionId -> mode }，原子写入；无文件时一次性迁移旧   │
│ │    settings 文档里的 sessions 映射                         │
│ ├─ approval/request 应答器（prepend: true，水瀑布最前端）  │
│ │    bypass                    -> "allowed-once"           │
│ │    bypass-except-escalation  -> 提权 next()，其余放行    │
│ │    ask                       -> next()                   │
│ ├─ webServer 控制路由 GET/POST /approval-mode（回环校验）  │
│ │    地址决定对象：无 session=默认值，?session=会话        │
│ └─ 变更观察：settings/updated（旧）或 loader/volatile-update │
│      （0.1.7+ 配置表单写入）-> 只通知生效模式变了的会话     │
└────────────────────────────────────────────────────────────┘
        same-origin fetch（GET/POST /approval-mode[?session=…]）
┌────────────────────────────────────────────────────────────┐
│ 浏览器（Client）                                           │
│ lib/client.js（__ModuleLoader__ bundle）                   │
│ ├─ 座位 conversation.input.left：「按钮 + 弹出菜单」控件   │
│ │    读写 props.sessionId 指向的会话（缺失时用默认地址）   │
│ ├─ 插件页卡片 settings.plugin.item[key=approval-mode]：    │
│ │    0.1.6 及更早：设置 → 插件 → 插件配置 里的卡片（读默认）│
│ │    0.1.7+：该槽位已不存在，宿主按 Config 自渲染配置项，    │
│ │    客户端只保留工具栏控件（嵌套 inject 自动降级）          │
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
- **最终方案**：`webServer` 控制路由仍是浏览器半读写的唯一通道——它自带回环 Host 校验
  （防御 `0.0.0.0` 部署），且**不随 settings 服务换代而改变**：0.1.7 换掉了 settings 的
  存储与写入语义，控制路由的契约一个字节没动。存的两端各自跟随宿主：默认模式是插件
  Config（0.1.7+）或 settings 命名空间（<=0.1.6），按会话模式是插件自有文件（§3.3）。

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
  const sessionId = req.agent?.session?.id;
  const stored = sessionModes.get(sessionId);               // 插件自有文件（§3.3）
  const mode = MODES.includes(stored) ? stored : readDefault();
  if (mode === "bypass") return "allowed-once";
  if (mode === "bypass-except-escalation") return isEscalationRequest(req) ? next() : "allowed-once";
  return next();
}, true);
```

应答器在水瀑布里是**同步**路径：`readDefault()` 读的是内存里的实时引用，会话映射在首次
读取时一次性同步加载文件，因此这里不出现 `await`。

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

两个值，**各存各的地方**，因为它们随宿主换代的方式完全不同：

| 值 | 存储 | 谁写 | 0.1.7+ | <=0.1.6 |
| --- | --- | --- | --- | --- |
| **默认模式** | 插件 `Config.defaultMode`（`.volatile()`）；旧宿主是 settings 命名空间 `approval-mode` | 宿主配置表单（0.1.7+）／插件页卡片（<=0.1.6） | profile patch，由宿主写入后就地更新引用 | settings.yaml |
| **按会话模式** | `$DSH_HOME/approval-mode/sessions.json` | 工具栏按钮（控制路由） | 同一份文件 | 同一份文件（首次迁移旧 `sessions`） |

**为什么按会话模式不进 Config**：0.1.7+ 的 settings 服务只能编辑**插件 Config**，而那是
写进 profile patch 的静态配置；按会话状态以开放的 session id 为键、随会话增减，塞进配置会
污染 profile patch、每次切换都重写配置文件，语义也不对。运行期状态因此放在插件自有目录，
**原子写入**（临时文件 + `rename`），读取同步、懒加载一次——应答器在水瀑布里不能 `await`。

- **解析顺序**：会话文件命中 → 默认模式 → `ask`。`unknown` / 越界值一律回落到 `ask`
  （fail closed）；文件损坏时按空处理并记日志，下一次写入即修复。
- **默认模式的优先级**：遗留命名空间里的**显式**值（升级前用户的选择，<=0.1.6 宿主仍在写）
  → live config 引用（0.1.7+）→ 普通 config 值 → `ask`。这样两代宿主、以及只是把
  `Config` 解析成普通值的老 schemastery，都不会读错来源。
- **迁移**：文件不存在时，把旧 settings 文档里的 `sessions` 映射一次性搬进文件并落盘；
  之后不再读它（旧文档里的值保持原样，不做写回）。
- Host 应答器每次请求时实时读取内存中的引用与映射，无需事件同步。
- 模式变更时逐个比较每个在线代理的**生效模式**前后是否变化，只向真的变了的会话 `inject`
  一条用户消息（尽力而为）。改默认值只会通知跟随默认值的会话，改某个会话只通知该会话。
  变更来源有三处，收敛在同一个观察点、每个变化只通知一次：本插件自己的写入、旧命名空间的
  `settings/updated`、以及 0.1.7+ 载入器提交 volatile 更新后发出的 `loader/volatile-update`。

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
session 地址会成为会话映射的键，因此 `__proto__` / `constructor` / `prototype`
三个会改写原型而不是新增条目的键被拒（400 `invalid-session`）——否则写入会被静默丢弃。
默认模式在 0.1.7+ 走宿主 settings 服务的 `update(entryId, {defaultMode})`：本插件用
`configEditor.configuration()` 按 **fiber uid** 认出自己的 loader entry id（不假设包名等于
entry id），服务缺失或认不出时返回 500 `settings-unavailable`，而不是假装写成功。

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
全部绕过为闪电。

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

### 3.4.1 设置页里的默认模式（两代宿主两种呈现）

**DSH 0.1.7+（当前）**：设置页的配置项由宿主**按插件 `Config` 自动渲染**——`settings`
服务把每个插件 entry 的 Config schema 投影成表单（`configForms`），浏览器侧用 schema-form
渲染，写入走 `settings.update(entryId, patch)`。因此本插件**不需要任何客户端卡片代码**：
声明 `Config.defaultMode`（`.volatile()`）就已经在「设置 → 插件」里出现一个下拉框，
选中即写 profile patch，载入器把新值就地提交进插件持有的引用（`loader/volatile-update`），
插件不重挂。

**DSH <= 0.1.6（兼容分支）**：宿主「插件」分区把**被服务的 settings 命名空间**与注册进
`settings.plugin.item` 槽位的卡片做**交集**渲染：

```js
// ConfigurablePluginsTabController.publish()
const served = new Set(describe().namespaces.map((view) => view.ns));
const namespaces = entries().flatMap((e) => served.has(e.options.key) ? [e.options.key] : []);
```

两件事都成立才渲染：Host 侧注册了命名空间（`ctx.settings.register(NS, …)`），且浏览器侧
以该命名空间为 `key` 注册了卡片：

```js
ctx.inject(["settingsScope"], (scoped) => {
  scoped.slots.inject("settings.plugin.item", () => scoped.slots.register(
    { name: "settings.plugin.item", key: NS, locale: NS }, ApprovalModeSettingsCard));
});
```

**为什么用嵌套 `inject` 而不是模块级 `inject`**：`settingsScope` 由
`dsh-client-ui-settings` 提供；写进模块级 `inject` 会让整个插件（包括输入框按钮）在
没有该服务的宿主上一起不挂载。嵌套 inject 让 0.1.7+ 宿主（该服务已不存在）只是
**不注册这张卡片**——那里的默认模式由宿主的 Config 表单承担。这条降级路径由
`scripts/check-client.mjs` 断言。

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
  `@deepseek-ai/cordis` 与 `react` 同样放 `peerDependencies`（与 better-sidebar 先例一致）。
  `@deepseek-ai/dsh-settings` **不再声明**：插件从 0.1.4 起不 import 该包，只用宿主注入的
  settings 服务（两代契约都兼容），声明一个不再使用的包会误导兼容性判定。
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

### 5.5 DSH 0.1.7 的 settings 换代（0.1.4 开发期）

0.1.7 把 settings 服务从「插件注册命名空间 + 一个 settings 文档」换成「插件 `Config` +
profile patch 配置表单」，`register`/`get` 消失、`update(ns, patch)` 的语义变成写插件自身的
配置。旧版 `index.js` 因此在 `apply` 第一行抛 `TypeError: ctx.settings.register is not a
function`（实测：宿主日志 `dsh-2026-09-25.log` 第 3 行，`DSH Desktop 2.0.14` / DSH
`0.1.7-rc.1`），宿主半不挂载 ⇒ 控制路由不存在 ⇒ 按钮显示「审批模式未知」。

- 宿主侧证据：`logs/host/dsh-*.log` 的 `TypeError: ctx.settings.register is not a function`
  与 `at new apply (…/dsh-approval-mode/index.js:192:16)`；同文件里 `[hmr]` 与 `[dsh-market]
  hot-mounted` 说明 bundle 本身装载了，失败发生在 `apply`。
- 接口对照：`@deepseek-ai/dsh-settings@0.1.7-rc.1` 的 `SettingsForms`（`configure` /
  `describe` / `update` / `replace` / `mutate` / `write`）取代了旧的命名空间注册；插件 `Config`
  的 `.volatile()` 字段在 `apply(ctx, config)` 里是 `{ get() }` 实时引用，载入器在
  `_commitVolatile()` 中就地更新并发出 `loader/volatile-update`。
- `scripts/check-host.mjs` 覆盖两代服务：无 `register` 的服务能挂载、live 引用决定默认值、
  默认写入按插件自己的 entry id 走 settings 服务、会话映射跨重启存活、坏文件退化并自修复、
  旧文档 `sessions` 一次性迁移、宿主侧变更只通知一次。
- 反向验证（2026-09-25，实测）：把 `inject` 与 `ctx.settings.register` 恢复成旧写法 ⇒
  4 条 FAIL，其中「a settings service WITHOUT register (0.1.7+) mounts the plugin instead
  of throwing」正是本次回归；确认后改回，全绿。
- 真实宿主实测（DSH 0.1.7-rc.1，`dsh --profile <临时 profile>`）：插件挂载行出现、
  `GET /approval-mode` 200、写默认值落到 profile patch 的 `config.defaultMode`、写会话落到
  `sessions.json`、重启后两者都在，且默认值写入**没有**产生第二次挂载行（volatile 就地更新）。

## 6. 已知边界与后续

- 改默认值会立即改变**没有自己模式**的会话的生效模式（含正在运行的会话，Host 每次请求都重新解析，
  界面由 `watchDefault` 与重新挂载时的重读跟随）；用工具栏单独设过模式的会话不受默认值影响。
- 多窗口模式同步：变更观察事件（旧命名空间的 `settings/updated`、0.1.7+ 的
  `loader/volatile-update`）驱动通知，各窗口重新读取自己地址的值；同一窗口内每个地址由
  各自的 store 同步，会话 store 另订阅默认 store 以跟随默认值。
- 按会话模式按 session id 永久保存在 `$DSH_HOME/approval-mode/sessions.json` 里，随会话数
  线性增长，不做过期清理（会话本身是长期可恢复的）；单个条目是几十字节。
- 提权识别依赖 `dsh-sandbox` 的 reason 前缀文本，宿主改拼写即退化为普通 `bypass`
  （§3.1.1）。
- 0.1.7+ 的默认模式只能经宿主的配置表单修改；本插件的控制路由也支持 `POST /approval-mode`
  写默认值（走 `settings.update`），但浏览器半在 0.1.7+ 不再渲染那张卡片（§3.4.1）。
- 升级到 0.1.7+ 后，旧 settings 文档里的**默认模式**无法再读取（宿主的旧文档通道已废弃），
  需要重设一次；按会话模式自动迁移（§3.3）。
- 插件页卡片依赖宿主客户端 `settingsScope` 服务（0.1.0-rc.7+）：只影响 <=0.1.6 且
  **未组装 `dsh-client-ui-settings`** 的非常规组合，此时只有卡片不出现（§3.4.1）。
- 可发布 npm（`npm publish`）后 `dsh plugin add dsh-approval-mode`。
