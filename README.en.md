> [!NOTE]
> Compatible with DSH 0.2.x (`engines.dsh` in `package.json`); verified on `0.2.0-rc.2`, `0.2.1-rc.5` and `0.2.2-rc.5` (per-version load checks on Linux CI).

# DSH-Approval-Mode

An approval mode plugin for DSH. Adds an "approval mode" button next to the permission selector (Read Only / Workspace Write / Full Access) in the DSH window. Keep the permission at **Workspace Write** and pick "Bypass, escalations excepted" — tool calls are auto-approved, while file operations stay sandboxed to the workspace, safer and more convenient than Full Access.

> [!IMPORTANT]
> Both bypass modes **auto-approve tool calls**; ordinary operations show no confirmation prompt.
> - **Bypass, escalations excepted**: ordinary tool calls pass through; **writing outside the workspace, or any command that needs a wider sandbox, still prompts** and the one-shot grant is yours to give.
> - **Bypass approval**: escalations are auto-approved too, so the sandbox boundary opens with everything else (high risk).
>
> Use them only when you fully trust the current task, and switch back to "default approval" when done.
> When the session permission is Full Access, DSH never issues approval requests, so these modes have no effect.

<img width="998" height="169" alt="image" src="https://github.com/user-attachments/assets/76763839-e8c1-4dcf-9a4f-00d94b5110b3" />

## Features

- The button sits in the composer toolbar next to the permission selector, styled like the permission control
- **Default approval**: identical to stock DSH — tool calls require a click to approve
- **Bypass, escalations excepted**: tool calls are auto-approved; widening the sandbox to write outside the workspace still prompts you
- **Bypass approval**: every tool call is auto-approved, escalations included, with no prompt at all (high risk)
- Changes apply immediately and persist per session
- The button turns orange in either bypass mode: a hollow shield for escalations-excepted, a bolt for full bypass
- With Full Access permission, the button is greyed out and shows "绕过审批": DSH never issues approval requests, so the mode cannot be switched
- Switching mode notifies the agent of that session
- Settings → Plugins carries this plugin's **default approval mode** (rendered by the host from the plugin Config)

## Configuration

The approval mode is **two values**, each with its own entry point:

| Entry point | Where | Scope |
| --- | --- | --- |
| Approval-mode button | Composer toolbar, next to the permission selector | **The current session**: no other session is affected |
| Default approval mode | Settings → Plugins | **The default**: sessions without a mode of their own follow it, running ones included; a session already given its own mode on the button is unaffected |

The toolbar button never rewrites the default, and the default only moves the sessions that have no mode of their own: change the default in Settings, wave one session through with the button.

Where they live: the **default** is this plugin's own config field (stored by the host in the profile patch); each **session's own mode** is kept in `$DSH_HOME/approval-mode/sessions.json` (a plugin-owned directory, written atomically).
Both apply immediately and persist.

## Install

Requires the [dsh CLI](https://github.com/deepseek-ai/deepseek-harness) (see `engines.dsh` in `package.json` for the compatible range).

Install from the GitHub repository:

```sh
dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode
```

> [!NOTE]
> `--profile web` is the default profile; replace `web` with the name of any other profile.

> [!NOTE]
> Development, the reasoning behind the declared ranges and the compatibility checklist live in
> [CONTRIBUTING.md](./CONTRIBUTING.md).

Pinning a commit is recommended so later pushes cannot silently change what runs:

```sh
dsh plugin --profile web add github:NEVSTOP-LAB/dsh-approval-mode#<commit-sha>
```

Or download the tarball from [Releases](https://github.com/NEVSTOP-LAB/dsh-approval-mode/releases) and install it:

```sh
dsh plugin --profile web add ./dsh-approval-mode-0.2.1.tgz
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
