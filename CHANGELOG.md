# 变更记录

本文件记录每个发布版本的用户可见变更。发布工作流
（[`.github/workflows/release.yml`](./.github/workflows/release.yml)）会调用
`scripts/release-notes.mjs`，把与 tag 对应的 `## [<版本>]` 小节抄进 GitHub Release
正文——所以**发版前先在这里写一节**，否则 Release 只会退化成提交列表。

更早的版本（`0.1.0` – `0.1.1-rc.3`）没有条目：当时 Release 正文只有安装说明，
历史内容见 [Releases](https://github.com/NEVSTOP-LAB/dsh-approval-mode/releases)。

## [Unreleased]

### 修复

- **DSH 0.1.7 起插件不挂载，按钮显示「审批模式未知」。** DSH 0.1.7 把 settings 服务从
  「插件注册命名空间 + settings 文档」换成了「插件 Config + profile patch 配置表单」：
  `ctx.settings.register` 已不存在。旧版 `index.js` 在 `apply` 第一行就抛
  `TypeError: ctx.settings.register is not a function`，宿主半根本没挂载 ⇒
  `/approval-mode` 控制路由不存在 ⇒ 浏览器读设置失败（落到 SPA fallback）⇒
  store 置 `known=false` ⇒ 工具栏按钮与插件页卡片都显示「审批模式未知」。修复后的分工：

  - **默认模式 = 本插件自己的配置字段** `Config.defaultMode`（`.volatile()`）。
    0.1.7+ 由宿主按 Config schema 在「设置 → 插件」自动渲染表单读写，改值只更新引用、
    不重挂插件；0.1.6 及更早的宿主没有这套投影，仍走原来的 `approval-mode`
    settings 命名空间（该服务存在时注册并读写）。
  - **按会话模式改存插件自有文件** `$DSH_HOME/approval-mode/sessions.json`（原子写入：
    临时文件 + rename）。0.1.7+ 的 settings 服务只能编辑插件 Config，按会话的运行期状态
    不该进 profile patch；该文件首次加载时会把旧 settings 文档里的 `sessions` 映射
    迁移过来，之后不再读它。
  - **`inject` 不再要求 settings 服务**：只要求 `webServer`。settings 通过
    `ctx.inject` 可选接入，因此两代 settings 服务、以及完全没有 settings 服务的组合
    都能挂载（应答器 + 控制路由 + 会话存储照常）。

- **升级提示**：0.1.7 已弃用旧的 settings 文档通道（`settings.yaml` 被改名成
  `settings.yaml.imported`），升级前写在 `approval-mode` 命名空间里的**默认模式**
  在 0.1.7+ 无法再读取——请在「设置 → 插件 → dsh-approval-mode」重新选一次默认模式。
  按会话的模式由插件自动迁移，无需手动处理。

### 变更

- **`@deepseek-ai/dsh-settings` 不再作为 peer 声明**：插件不再 import 该包（只使用宿主
  注入的 settings 服务，且两代服务都兼容）。peer 范围只剩 `@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-llm`、`@deepseek-ai/schemastery`、`react`。

### 验证

- `npm run check`：`scripts/check-host.mjs` 重写并覆盖两代 settings 服务——新增断言含
  「没有 `register` 的 settings 服务能挂载（本次回归）」「live config 引用决定默认值」
  「默认写入按插件自己的 loader entry id 走 settings 服务」「会话映射跨重启存活」
  「坏文件退化为空、写入时修复」「旧文档的 sessions 一次性迁移」「宿主侧 volatile 变更只通知一次」。
  逐条反向验证：把 `inject` 与 `ctx.settings.register` 恢复成旧写法，该脚本报 4 条
  `FAIL`（含「能挂载而不抛异常」），确认后改回。
- 真实宿主实测（DSH Desktop 2.0.14 / DSH 0.1.7-rc.1）见 CONTRIBUTING §4.1。

## [0.1.3] - 2026-09-22

### 新增

- **第三个审批模式「绕过审批（提权除外）」**：工具调用照常自动放行，但工作区外写文件、
  执行需要更宽沙箱的命令所需的**提权仍会弹窗**，由你决定是否放行这一次。此前只有两种
  模式，其中「绕过审批」连提权一起自动批准；现在两档都在，按任务选择。（#9）

### 变更

- **默认审批模式与当前会话的审批模式拆成两个值**：插件页配置卡片只写「打开会话时使用的
  默认模式」，工具栏的「审批模式」按钮只改**当前会话**，两者不再互相改写；会话模式按
  会话持久保存，重启后保持。（#11）
- **升级兼容**：0.1.2 及更早版本写入的全局 `mode` 升级后仍然决定默认值，无需手动重设。
- **宿主共享包标记为 optional peer**：`pnpm peers check` 不再报那五条 `missing peer`
  （这些包由 DSH 共享层提供，在 profile 里必然「缺失」）；宿主版本下界改由 `engines.dsh`
  显式声明，dsh-market 浏览期的「低于声明下界」判定因此不受影响。（#10）

### 文档

- README（中/英）：新增第三个模式的说明与「提权仍会弹窗」的风险提示；配置章节改为两个值、
  两个入口，并说明改默认值对没有自己模式的会话（含正在运行的）立即生效。
- `doc/design.md`：新增三个模式的对照表与提权识别判据（§3.1.1）、按会话的状态模型（§3.3）、
  控制路由契约（§3.3.1），同步插件页卡片、打包与依赖声明说明。
- `CONTRIBUTING.md`：`engines.dsh` 与 optional peer 的判定依据、唯一被削弱的信号与实测方法；
  新增 `scripts/check-host.mjs` 的存在理由与反向验证清单；版本号规则改为陈述实际做法。

### 验证

- `npm run check`：语法检查 + `scripts/check-client.mjs` + 新增的
  `scripts/check-host.mjs`（Host 半离线契约检查：用 `module.registerHooks` 给
  `@deepseek-ai/*` 打桩后加载真实的 `index.js`，覆盖三模式应答、按会话解析、
  遗留值迁移与控制路由地址语义）。每条新断言都做过反向验证（退回修复 ⇒ 对应用例失败）。
- 实测（pnpm 11.8、`autoInstallPeers: false`）：旧清单复现 issue #10 的五条
  `missing peer`，新清单输出 `No peer dependency issues found`。
- 修复了 Copilot 在 #12 上提出的 5 条问题（默认值对继承会话的生效范围、两处「绕动」错别字、
  §1 目标句未限定提权），5 个 review thread 已 resolve。

## [0.1.2] - 2026-09-17

### 新增

- **插件页配置卡片**：`设置 → 插件 → 插件配置` 中新增本插件的卡片，可设置打开会话时使用的
  审批模式（默认审批 / 绕过审批）。它与输入框工具栏的「审批模式」按钮写的是同一个全局设置，
  两个界面实时同步；切换后仍会通知在线代理。

### 变更

- **审批模式状态机**：读取失败时两个界面显示「审批模式未知」（工具栏置灰、卡片不选中任何
  选项），不再把 schema 默认值当作当前设置；写入失败回滚到 Host 最后确认过的值，而不是上一次
  乐观值；并发的选择、被取代的读取与乱序返回的响应都不会让界面显示 Host 从未接受过的模式。
- **版本要求**：`@deepseek-ai/dsh-settings` 对齐到 `^0.1.1-rc.2`，与 `@deepseek-ai/dsh-llm`
  同属一条 DSH 版本线；DSH 共享宿主包仍然只声明在 `peerDependencies`。声明的下界是
  `0.1.1-rc.2`，无上界。
- **发布包内容**：`CONTRIBUTING.md`、`doc/` 与 `CHANGELOG.md` 进入 tarball，
  README 中的相对链接对 tarball 用户同样有效（此前指向的文档根本不在包里）。

### 文档

- README（中/英）：版本说明只陈述用户需要行动的事实——需要 DSH `0.1.1-rc.2` 及以上、
  实测 `0.1.5-rc.2`。
- 新增 `CONTRIBUTING.md`：本地检查、版本要求的逐条依据、兼容性校验方法与记录、打包发版清单、
  开发坑。
- `doc/design.md`：补齐插件页卡片的派发机制（settings 命名空间 ∩ slot key）与状态机的三条
  不变式（`known` / `confirmed` / `generation`）。

### 验证

- `npm run check`：5 个文件的 `node --check` + 离线 client bundle 契约检查（26 条断言）全绿；
  每条新断言都做过反向验证（退回修复 ⇒ 对应用例失败）。
- 兼容性：按 API 逐项对照 DSH `0.1.5-rc.2`（`settings`、`webServer`、`approval/request`
  水瀑布、`createUserMessage`、slot `locale`、`settings.plugin.item` + `settingsScope`），
  记录见 CONTRIBUTING §4.1。
- 修复了 Copilot 在 #8 上提出的 4 类问题（未知态、回滚目标、被取代的读取、发布包死链），
  相关 3 个 review thread 已 resolve。
