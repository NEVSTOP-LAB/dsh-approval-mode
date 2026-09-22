# 变更记录

本文件记录每个发布版本的用户可见变更。发布工作流
（[`.github/workflows/release.yml`](./.github/workflows/release.yml)）会调用
`scripts/release-notes.mjs`，把与 tag 对应的 `## [<版本>]` 小节抄进 GitHub Release
正文——所以**发版前先在这里写一节**，否则 Release 只会退化成提交列表。

更早的版本（`0.1.0` – `0.1.1-rc.3`）没有条目：当时 Release 正文只有安装说明，
历史内容见 [Releases](https://github.com/NEVSTOP-LAB/dsh-approval-mode/releases)。

## [Unreleased]

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

### 验证

- `npm run check`：语法检查 + `scripts/check-client.mjs` + 新增的
  `scripts/check-host.mjs`（Host 半离线契约检查：用 `module.registerHooks` 给
  `@deepseek-ai/*` 打桩后加载真实的 `index.js`，覆盖三模式应答、按会话解析、
  遗留值迁移与控制路由地址语义）。每条新断言都做过反向验证（退回修复 ⇒ 对应用例失败）。
- 实测（pnpm 11.8、`autoInstallPeers: false`）：旧清单复现 issue #10 的五条
  `missing peer`，新清单输出 `No peer dependency issues found`。

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
