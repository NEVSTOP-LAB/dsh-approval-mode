# dsh-approval-mode 仓库约定

## DSH 插件依赖声明

- DSH 插件的宿主共享包一律声明在 `peerDependencies` 并逐项标 `peerDependenciesMeta.optional: true`，宿主版本下界写到顶层 `engines.dsh`，禁止放进 `dependencies`。
- 不标 `optional` 时，profile 的 `pnpm peers check` 会把这些包全报成 `missing peer`；放进 `dependencies` 会在插件自己的 `node_modules` 里装一份独立拷贝、遮蔽宿主版本。
