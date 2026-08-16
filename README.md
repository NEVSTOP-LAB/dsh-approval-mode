# DSH-Approval-Mode（DSH 审批模式）

DSH 窗口内审批模式切换插件：在输入框工具栏的**权限选择（Read Only / Workspace Write / Full Access）旁边**新增一个「审批模式」控件，可手动选择。

## 功能

- **审批模式控件**：位于 DSH 窗口输入框工具栏、权限下拉框旁边，样式与权限控件一致（胶囊按钮 + 弹出菜单，点击选择）。
- **两种模式**：

  | 选项 | 行为 |
  | --- | --- |
  | 默认审批（默认） | 与 DSH 原有行为完全一致：工具调用需要点击批准。 |
  | 绕过审批 | 所有工具调用自动批准，无需任何点击。 |

- 切换**立即生效**、**持久保存**（DSH 重启后保持上次选择）。
- 切换模式时会通知当前会话的代理，代理会感知到审批模式的变化。
- 选中「绕过审批」时，控件以**橙色警告色**高亮，提示当前处于高风险模式。

## 风险提示

> **绕过审批会让 DSH 代理直接执行文件修改、外部命令等敏感操作，且没有任何人为确认点。**
> 请仅在完全信任当前任务与工作区时启用；用完请及时切回「默认审批」。

- 绕过审批期间，所有需要审批的操作（包括越权文件写入、命令执行等）都会被自动放行，**不会弹出任何确认提示**。
- 当会话权限为「完全访问 (Full Access)」时，DSH 内置策略为直接拒绝（不产生审批请求），该模式下绕过审批不适用。

## 安装

本插件是标准的 DSH 组合包（bundle），通过官方 `dsh` CLI 安装（需要 [dsh CLI](https://github.com/deepseek-ai/deepseek-harness) 0.1.0-rc.6+）：

### 方式一：从 GitHub 仓库安装（推荐）

```sh
# 安装最新提交（建议锁定 commit SHA，见下）
dsh plugin --profile <name> add github:NEVSTOP-LAB/dsh-approval-mode

# 锁定版本/提交，避免后续推送改变实际内容：
dsh plugin --profile <name> add github:NEVSTOP-LAB/dsh-approval-mode#<commit-sha>
```

Git 安装拉取的是源码；本插件无需构建步骤（纯 JavaScript），因此**不需要** pnpm 构建授权（`allowBuilds`）。

### 方式二：从 tarball 安装

```sh
# 从 GitHub Releases 下载 dsh-approval-mode-<version>.tgz 后：
dsh plugin --profile <name> add ./dsh-approval-mode-0.1.0.tgz
```

### 方式三：发布到 npm 后

```sh
dsh plugin --profile <name> add dsh-approval-mode
```

### 安装后

```sh
# 验证组合层（应出现 "# == dsh-approval-mode" 段）：
dsh --profile <name> --dump-config

# 启动 profile：
dsh --profile <name> web
```

启动后，DSH 窗口输入框工具栏、权限下拉框旁边会出现「默认审批」按钮（盾牌图标）。

### 卸载

```sh
dsh plugin --profile <name> remove dsh-approval-mode
```

## 使用

1. 在 DSH 窗口输入框工具栏找到「默认审批」按钮（权限下拉框旁边，带盾牌图标）。
2. 点击按钮，从弹出菜单中选择：
   - **默认审批** —— 工具调用需要点击批准；
   - **绕过审批** —— 所有工具调用自动批准。
3. 状态实时生效并持久保存；按钮上的图标与颜色反映当前模式（绕过审批 = 闪电图标 + 橙色）。

## 开发

- `npm run check` — 语法检查 Host/Client 两个 half
- `npm run pack` — 打包 tarball 到 `dist/`
- `doc/design.md` — 架构与实现细节
- `scripts/listen-only.mjs` — 审批帧监听验证脚本（开发用）

## License

MIT — 见 [LICENSE](LICENSE)。
