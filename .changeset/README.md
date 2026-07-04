# Changesets

版本管理用 changesets，所有包版本通过 `fixed` 组同步。发布不走 `changeset publish`，由 `.github/workflows/release.yml` 按序（先平台包后主包）用 `bun publish` 完成。
