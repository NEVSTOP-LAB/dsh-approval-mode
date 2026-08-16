# DSH-Approval-Mode

An approval mode plugin for DSH. Adds an "approval mode" button next to the permission selector (Read Only / Workspace Write / Full Access) in the DSH window.

> [!IMPORTANT]
> "Bypass approval" **auto-approves every tool call**, including file modifications and external commands. There is no confirmation prompt at all.
> Use it only when you fully trust the current task, and switch back to "default approval" when done.
> When the session permission is Full Access, DSH never issues approval requests, so this mode has no effect.

<img width="998" height="169" alt="image" src="https://github.com/user-attachments/assets/76763839-e8c1-4dcf-9a4f-00d94b5110b3" />

## Features

- The button sits in the composer toolbar next to the permission selector, styled like the permission control
- **Default approval**: identical to stock DSH — tool calls require a click to approve
- **Bypass approval**: every tool call is auto-approved, no clicks needed
- Changes apply immediately and persist across restarts
- The button turns orange in bypass mode
- With Full Access permission, the button is greyed out and shows "绕过审批": DSH never issues approval requests, so the mode cannot be switched
- Switching mode notifies the agents in live sessions

## Install

Requires the [dsh CLI](https://github.com/deepseek-ai/deepseek-harness) (0.1.0-rc.6 or newer).

Install from the GitHub repository:

```sh
dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode
```

> [!NOTE]
> `--profile web` is the default profile. Use `--profile desktop` for DSH Desktop; replace `web` with the name of any other profile.

Pinning a commit is recommended so later pushes cannot silently change what runs:

```sh
dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode#<commit-sha>
```

Or download the tarball from [Releases](https://github.com/NEVSTOP-LAB/dsh-approval-mode/releases) and install it:

```sh
dsh plugin --profile web add ./dsh-approval-mode-0.1.0.tgz
```

Verify the composed config contains the plugin layer:

```sh
dsh --profile web --dump-config
```

After boot, the "默认审批" button appears next to the permission selector in the composer toolbar.

Uninstall:

```sh
dsh plugin --profile web remove dsh-approval-mode
```

## License

MIT
