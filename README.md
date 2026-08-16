# DSH-Approval-Mode

DSH 审批模式插件。在 DSH 窗口的权限下拉框（Read Only / Workspace Write / Full Access）旁边加一个「审批模式」按钮，可以手动切换。

> [!IMPORTANT]
> 「绕过审批」会**自动批准所有工具调用**，包括文件修改、外部命令等敏感操作，全程没有确认提示。
> 只在完全信任当前任务时使用，用完记得切回「默认审批」。
> 当会话权限为 Full Access 时，DSH 本身不会发起审批请求，此模式不生效。

## 功能

- 按钮在输入框工具栏、权限选择旁边，样式和权限控件一致
- **默认审批**：和 DSH 原有行为一样，工具调用需要点击批准
- **绕过审批**：所有工具调用自动批准，不用点击
- 切换立即生效，重启后保持
- 绕过审批时按钮显示为橙色
- 切换模式会通知当前会话的代理

## 安装

需要 [dsh CLI](https://github.com/deepseek-ai/deepseek-harness)（0.1.0-rc.6 及以上）。

从 GitHub 仓库安装：

```sh
dsh plugin --profile <name> add github:NEVSTOP-LAB/dsh-approval-mode
```

建议锁定提交，避免后续更新改变实际内容：

```sh
dsh plugin --profile <name> add github:NEVSTOP-LAB/dsh-approval-mode#<commit-sha>
```

也可以从 [Releases](https://github.com/NEVSTOP-LAB/dsh-approval-mode/releases) 下载 tarball 安装：

```sh
dsh plugin --profile <name> add ./dsh-approval-mode-0.1.0.tgz
```

安装后确认组合层里出现该插件：

```sh
dsh --profile <name> --dump-config
```

启动后，输入框工具栏权限下拉框旁边会出现「默认审批」按钮。

卸载：

```sh
dsh plugin --profile <name> remove dsh-approval-mode
```

## License

MIT
