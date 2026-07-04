# Changesets

版本管理与 npm 发布用 changesets，所有包版本通过 `fixed` 组同步。

`npm/aio-proxy` 的平台包依赖必须使用普通精确版本（如 `"0.0.0"`），不要使用 `workspace:*`。`changeset version` 会同步更新 `optionalDependencies`，`changeset publish` 再用 npm 发布所有未发布的 public 包。
