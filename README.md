# DSH-Approval-Mode

DSH 审批模式插件。在 DSH 窗口的权限下拉框（Read Only / Workspace Write / Full Access）旁边加一个「审批模式」按钮，权限可以保持 **Workspace Write**，审批模式选「绕过审批」——工具调用自动放行，但文件操作仍被沙箱限制在工作区内，比切到 Full Access 更安全、更方便。

> [!IMPORTANT]
> 「绕过审批」会**自动批准所有工具调用**，包括文件修改、外部命令等敏感操作，全程没有确认提示。
> 只在完全信任当前任务时使用，用完记得切回「默认审批」。
> 当会话权限为 Full Access 时，DSH 本身不会发起审批请求，此模式不生效。

<img width="998" height="169" alt="image" src="https://github.com/user-attachments/assets/76763839-e8c1-4dcf-9a4f-00d94b5110b3" />

## 功能

- 按钮在输入框工具栏、权限选择旁边，样式和权限控件一致
- **默认审批**：和 DSH 原有行为一样，工具调用需要点击批准
- **绕过审批**：所有工具调用自动批准，不用点击
- 切换立即生效，重启后保持
- 绕过审批时按钮显示为橙色
- 权限为 Full Access 时，按钮置灰并显示「绕过审批」：DSH 不再发起审批请求，模式不可切换
- 切换模式会通知当前会话的代理
- 设置 → 插件 → **插件配置**中有本插件的配置卡片，可设置打开会话时使用的默认审批模式

## 配置

审批模式有**两个**入口，改的是同一个设置（全局、立即生效、写入 `settings.yaml` 持久保存）：

| 入口 | 位置 | 用途 |
| --- | --- | --- |
| 审批模式按钮 | 输入框工具栏，权限下拉框旁边 | 随手切换当前会话 |
| 配置卡片 | 设置 → 插件 → 插件配置 | 设置打开会话时使用的默认模式 |

## 安装

需要 [dsh CLI](https://github.com/deepseek-ai/deepseek-harness)（下界 `0.1.1-rc.2`，实测 `0.1.5-rc.2`，见下方版本说明）。

从 GitHub 仓库安装：

```sh
dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode
```

> [!NOTE]
> `--profile web` 是默认 profile。桌面版（[DSH Desktop](https://github.com/anywhere-labs/deepseek-harness-desktop)）用 `--profile desktop`；其他 profile 把 `web` 换成对应名字即可。

> [!NOTE]
> **版本要求**：需要 DSH `0.1.1-rc.2` 及以上（0.1.x 线，无上界）；已在 DSH `0.1.5-rc.2`
> （DSH Desktop 2.0.11）上验证。低于 `0.1.1-rc.2` 的宿主会被 dsh-market 标记为
> 「低于声明下界」，请先升级 DSH。
> 「设置 → 插件 → 插件配置」中的配置卡片需要 DSH `0.1.0-rc.7` 及以上；更旧的宿主只是
> 不显示这张卡片，输入框旁边的「审批模式」按钮与绕过审批不受影响。
> 开发、版本声明的判定依据与兼容性校验方法见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

建议锁定提交，避免后续更新改变实际内容：

```sh
dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode#<commit-sha>
```

也可以从 [Releases](https://github.com/NEVSTOP-LAB/dsh-approval-mode/releases) 下载 tarball 安装：

```sh
dsh plugin --profile web add ./dsh-approval-mode-0.1.1-rc.4.tgz
```

安装后确认组合层里出现该插件：

```sh
dsh --profile web --dump-config
```

启动后，输入框工具栏权限下拉框旁边会出现「默认审批」按钮。

卸载：

```sh
dsh plugin --profile web remove dsh-approval-mode
```

## License

MIT
