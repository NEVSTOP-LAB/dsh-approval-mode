# 贡献指南（CONTRIBUTING）

面向维护者与二次开发。用户可见的功能、安装与配置见 [README.md](./README.md)，
架构与关键机制见 [doc/design.md](./doc/design.md)。

本文档是**开发流程、版本要求与验证方法**的出处：README 只陈述用户需要知道的事实，
原因、判定依据与操作步骤都在这里。

## 目录

- [1. 目录结构](#1-目录结构)
- [2. 本地开发与检查](#2-本地开发与检查)
- [3. 版本要求与兼容性](#3-版本要求与兼容性)
- [4. 兼容性校验怎么做](#4-兼容性校验怎么做)
- [5. 打包与发版](#5-打包与发版)
- [6. 开发坑](#6-开发坑)

## 1. 目录结构

```
dsh-approval-mode/
├── README.md            # 用户可见：功能、风险提示、安装、配置
├── README.en.md         # 同上（英文）
├── CONTRIBUTING.md      # 本文档：开发流程、版本要求、验证方法
├── doc/design.md        # 设计文档：架构与关键机制
├── package.json         # bundle manifest（dsh.bundle + dsh.client + peer 版本要求）
├── cordis.patch.yml     # 组合层：插入插件行
├── index.js             # Host half（审批应答器 + settings + 控制路由 + 代理通知）
├── lib/client.js        # Client half（工具栏控件 + 插件页配置卡片）
└── scripts/
    ├── dshClient.js     # 轻量 DSH 回环 API 客户端（HTTP + WebSocket，自包含）
    ├── listen-only.mjs  # 审批帧监听验证脚本（不应答）
    ├── check-client.mjs # 离线 client bundle 契约检查（零依赖）
    └── pack.mjs         # 跨平台打包（npm pack → dist/）
```

分两半：Host（`index.js`，注册 settings 命名空间 `approval-mode`、`approval/request`
应答器、`GET/POST /approval-mode` 控制路由）与 Client（`lib/client.js`，
`window.__ModuleLoader__` bundle）。设计细节见 doc/design.md §2–§3。

## 2. 本地开发与检查

仓库**没有 `node_modules`，也不安装依赖**：检查脚本只用 Node 内置模块，clone 下来直接跑。

```sh
npm run check
```

等价于：

```sh
node --check index.js
node --check lib/client.js
node --check scripts/dshClient.js
node --check scripts/listen-only.mjs
node --check scripts/check-client.mjs
node scripts/check-client.mjs
```

### 2.1 `scripts/check-client.mjs` 为什么存在

`lib/client.js` 是 `window.__ModuleLoader__` bundle：它不能被 `import`，没有类型检查，
出错只会出现在浏览器 console 里——而「注册错槽位」「key 写错」这类错误在界面上表现为
**卡片/按钮静默消失**，没有任何报错。该脚本用 stub 的 `window.__ModuleLoader__`、
`document`、`react`、`fetch` 加载真实 bundle，把能离线断言的部分全部断言掉：

1. 工具栏控件注册进 `conversation.input.left`（`locale` 绑定 `approval-mode` 词典）；
2. 插件页卡片注册进 `settings.plugin.item`，且 `key` **等于** settings 命名空间
   —— 宿主的「插件」分区按这个交集派发卡片，写错就永远不渲染；
3. 宿主没有客户端 `settingsScope` 服务时，**只丢卡片、不丢工具栏按钮**（降级路径）；
4. 卡片渲染出两个选项、当前值选中、点击后 `POST /approval-mode` 的 body 正确；
5. 卡片用到的词典 key 在 zh/en 中**都存在**。

### 2.2 证明它能失败

一个永远绿的检查等于没有检查。改动卡片注册后，把 `key: NS` 临时改成
`key: NS + "-probe"` 再跑一次，应当看到：

```
FAIL plugin card registered into settings.plugin.item keyed by the settings namespace
```

并以退出码 1 结束（2026-09-17 实测）。确认后改回。

### 2.3 端到端验证（可选）

UI 行为的最终确认只能靠真实宿主，需要**重启 DSH**才能装载新版本：

```sh
npm run pack
dsh plugin --profile <test-profile> add ./dist/dsh-approval-mode-<version>.tgz
```

两个注意点：

- **不要对 `link:` 安装执行 `dsh plugin remove`**（见 §6）。
- 在 GUI 之外直接请求控制路由（`curl http://127.0.0.1:<port>/approval-mode`）会得到
  **403 `forbidden`**：那是 DSH Desktop 的浏览器访问围栏
  （`dsh-plugin-desktop/lib/webserver.js` → `decideDesktopBrowserAccess`，
  非 Electron renderer 且未开启普通浏览器访问时一律拒绝），**不是插件路由故障**。
  页面内的同源 fetch 正常。

## 3. 版本要求与兼容性

### 3.1 声明在哪里

**`package.json` 的 `peerDependencies`**。dsh-market 的兼容性预检
（`assessCompatibility` → `classifyPeer`）读的就是各插件的 peer 范围与 profile 中
已解析的宿主版本，并把不一致判成 `belowMin`（低于声明下界 = 环境太旧）或
`aboveMax`（高于显式上界）。README 只复述结论，判定依据是本表。

| peer | 范围 | 依据 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `^0.1.1-rc.2` | `createUserMessage`：稳定消息标识自 0.1.1-rc.2 起必需，低于它的宿主会让会话恢复失败（见已关闭的 #1） |
| `@deepseek-ai/dsh-settings` | `^0.1.1-rc.2` | settings 服务的 `register/get/update`；与 dsh-llm 对齐到同一条 DSH 核心版本线 |
| `@deepseek-ai/cordis` | `^4.0.1` | `ctx.on(…, true)` prepend、`ctx.inject`、`ctx.effect` |
| `@deepseek-ai/schemastery` | `^3.18.1` | namespace schema |
| `react` | `^18.2.0` | client bundle（宿主 seed 模块提供） |

### 3.2 为什么上界不设

caret 只界到 `0.2.0`，不写显式上界：插件只使用**稳定的公开服务**——`settings`、
`webServer`、`approval/request` 水瀑布、slot 座位——不依赖内部符号。这正是
doc/design.md §2.1 放弃 settings RPC 白名单与 typert Remote 的收益：宿主升级到更新的
0.1.x 时，插件不需要跟着改。

### 3.3 为什么 DSH 共享宿主包只放 peerDependencies

放进 `dependencies` 会在插件自己的 `node_modules` 里装独立拷贝、遮蔽宿主版本；
dsh-market 也会就此告警。本插件 `dependencies` 为空，宿主共享包全部由
`$DSH_HOME/profiles/node_modules` 解析。（`devDependencies` 里的同名两项只服务本地开发。）

### 3.4 版本号与发布的关系

插件版本跟 DSH 核心版本线走（当前 `0.1.1-rc.<n>`）。发布流程见 §5。

### 3.5 配置卡片的额外依赖，以及它为什么不进 README

配置卡片需要宿主的客户端 `settingsScope` 服务（由 `@deepseek-ai/dsh-client-ui-settings`
提供，0.1.0-rc.7 起）。该下界**低于**本插件声明的 DSH 下界 `0.1.1-rc.2`，因此在所有
**受支持**的宿主上卡片都可用——README 因此只声明版本下界，不再描述「旧宿主少一张卡片」
这种落在支持范围之外的情形。

降级路径仍然存在，且由 `scripts/check-client.mjs` 断言：它覆盖的是**组装层没有引入
`dsh-client-ui-settings`** 的非常规组合（版本够新、客户端少了该服务）。此时只有卡片不出现，
工具栏按钮与绕过审批不受影响。

## 4. 兼容性校验怎么做

每次 DSH 大版本更新后，按下面的顺序重新校验，并把结论写回 §3.1 的表和 README 的事实段。

1. **逐 API 对照宿主实现**（读代码，不靠记忆）：

   | 插件用法 | 宿主侧位置 |
   | --- | --- |
   | `ctx.settings.register(ns, schema, {applies})` / `settings.get/update` | `@deepseek-ai/dsh-settings` |
   | `ctx.webServer.register({kind:"exact",path,handler})` | `@deepseek-ai/dsh-host-webserver` |
   | `ctx.on("approval/request", fn, true)`（prepend） | `@deepseek-ai/dsh-user-approval`（`ctx.waterfall`） |
   | `createUserMessage` | `@deepseek-ai/dsh-llm` 导出表 |
   | `slots.register({…, locale})` → 组件 `props.t` | `@deepseek-ai/dsh-client-ui-renderer`（locale seat） |
   | `props.useProjection("permissions")` | standard props |
   | `settings.plugin.item`（keyed slot）+ `settingsScope` | `@deepseek-ai/dsh-client-ui-settings-plugins` / `dsh-client-ui-settings` |

2. **确认卡片仍会被派发**：宿主「插件」分区渲染的是
   `describe().namespaces`（被服务的 settings 命名空间）与 `settings.plugin.item`
   中 `key` 相同的卡片的**交集**。命名空间在 0.1.1-rc.2 之后由 `describe()` 全量返回
   （白名单已移除），卡片侧由 §2.1 的检查脚本守住。

3. **留运行时证据**：宿主日志出现 `[dsh-approval-mode] loaded: mode = …`（挂载成功）
   与 `hot-mounted`；`$DSH_HOME/settings.yaml` 中出现 `approval-mode: { mode: … }`
   （命名空间注册 + 写入通路正常）；`logs/host/*.error.log` 无本插件条目。

4. **注意误判**：§2.3 的 403 是 DSH Desktop 的浏览器访问围栏，与插件无关。

### 4.1 校验记录

- **0.1.5-rc.2（DSH Desktop 2.0.11，node v24.18.1，共享层 `@deepseek-ai/*` 0.1.5-rc.2、
  cordis 4.0.2、schemastery 3.18.2）— 通过。** 上面第 1 步列出的 API 全部一致；
  宿主日志 `hot-mounted dsh-approval-mode` 且无插件错误；`settings.yaml` 中
  `approval-mode: { mode: bypass }` 写入成功；离线契约检查全绿（§2）。
- 更早版本（0.1.0-rc.x / 0.1.1-rc.x）的验证记录见 doc/design.md §5.1–§5.2。

## 5. 打包与发版

```sh
npm run pack        # → dist/dsh-approval-mode-<version>.tgz
```

- **CI**（`.github/workflows/ci.yml`）：push/PR 到 main 时跑 `npm run check` 与 `npm run pack`。
- **Release**（`.github/workflows/release.yml`）：推送 `v*` tag 时触发，**先校验
  `package.json` 的 version 与 tag 一致**（不一致直接失败），然后 check、pack、
  创建 GitHub Release 并附上 `dist/*.tgz`。

发版清单：

1. 改 `package.json` 的 `version`；
2. 同步两份 README 里 tarball 示例的文件名（`dsh-approval-mode-<version>.tgz`）——
   这里最容易腐坏；
3. 跑 `npm run check`；
4. 提交并推送，然后打 `v<version>` tag。

发布内容由 `package.json` 的 `files` 决定：`index.js`、`lib/client.js`、
`cordis.patch.yml`、两份 README、LICENSE，以及本文档与 `doc/`——README 指向本文档的
**相对链接在安装后的包里同样可用**（缺了它，tarball 用户点开就是死链）。`scripts/`
是开发工具，不进 tarball。

## 6. 开发坑

1. **`dsh plugin remove` 对 `link:` 安装的依赖会删除 link 目标目录内容**
   （开发中曾清空源目录）。开发验证请用 tarball 安装（`add ./x.tgz`），
   不要对 `link:` 安装执行 remove。
2. **`link:` 目录安装时 Node 从包真实路径解析 import**，找不到 DSH 共享层
   （`@deepseek-ai/*`）；tarball / npm / git 安装由 pnpm store 管理依赖，无此问题。
3. **pnpm ≥10 拒绝依赖的构建脚本**：如安装报 `ERR_PNPM_IGNORED_BUILDS`，
   按官方指南在 profile 的 `pnpm-workspace.yaml` 添加 `allowBuilds: { <pkg>: true }`。
   本插件无构建脚本，不受影响。
