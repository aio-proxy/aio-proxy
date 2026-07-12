# Dashboard Rstest 设计

## 目标

为 `packages/dashboard` 接入 Rstest，替换该 package 现有的 Bun test 运行方式，并将测试文件与主要被测源码就近放置。

## 配置

- 使用仓库现有 Bun workspace 管理依赖。
- 在 dashboard package 添加 `@rstest/core`、`@testing-library/react`、`@testing-library/jest-dom` 和 `happy-dom` 开发依赖；复用已有 `@rsbuild/plugin-react`。
- 新增 `rstest.config.ts`，启用 React 插件、`happy-dom` 和统一 setup 文件。
- setup 文件注册 jest-dom matcher，并在每个测试后执行 Testing Library cleanup。
- `test:unit` 使用 `rstest run`，不影响仓库其他 package 继续使用 Bun test。

## 测试布局

- 删除 `packages/dashboard/_test`。
- 测试使用 `*.test.ts` 或 `*.test.tsx`，放在主要被测模块旁边。
- 覆盖多个文件的测试归属到承担主要行为的模块目录，不新建集中式测试目录。
- 所有测试 API 从 `@rstest/core` 导入；文件读取和目录扫描使用 Node 标准库，不依赖 `Bun.file` 或 `Bun.Glob`。

## 当前功能测试

- `sidebar-preferences.test.tsx` 与组件同目录。
- 通过 Testing Library 实际渲染组件，验证“外观”和“语言”入口存在。
- mock `next-themes` 与 i18n 的边界 API，验证选择主题调用 `setTheme`，选择不同语言调用 `setLocale` 并刷新页面。
- 不通过读取源码字符串来证明组件行为。

## 验证

- `bun run --cwd packages/dashboard test:unit` 使用 Rstest 并通过全部迁移后的测试。
- dashboard 生产构建通过。
- Biome 检查覆盖配置、setup、测试与 package.json。
- `packages/dashboard` 中不再存在 `bun:test`、`Bun.file`、`Bun.Glob` 或独立 `_test` 目录。
