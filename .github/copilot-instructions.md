# dsh-approval-mode 仓库约定

## DSH 插件依赖声明

- DSH 插件的宿主共享包一律声明在 `peerDependencies` 并逐项标 `peerDependenciesMeta.optional: true`，宿主版本范围写到顶层 `engines.dsh`（「下界 + 下一个大版本上界」，如 `>=0.1.1-rc.2 <0.3.0-0`），禁止放进 `dependencies`。
- 不标 `optional` 时，profile 的 `pnpm peers check` 会把这些包全报成 `missing peer`；放进 `dependencies` 会在插件自己的 `node_modules` 里装一份独立拷贝、遮蔽宿主版本。
