# Dashboard Rstest Rsbuild Adapter 设计

## 目标

Rstest 通过官方 `@rstest/adapter-rsbuild` 复用 dashboard 的 `rsbuild.config.ts`，避免重复声明 React 等构建插件。

## 配置

- dashboard 添加 `@rstest/adapter-rsbuild` 开发依赖。
- `rstest.config.ts` 使用 `extends: withRsbuildConfig()`。
- Rstest 配置仅保留 `testEnvironment: "happy-dom"` 和 `setupFiles` 等测试专属选项。
- 不使用手动 `loadConfig` 或 `toRstestConfig`，因为当前不需要选择 environment 或改写 Rsbuild 配置。

## 验证

- 配置测试确认使用 `withRsbuildConfig()`，且不再直接实例化 `pluginReact()`。
- dashboard 77 个 Rstest 测试通过。
- Turbo dashboard 测试调度和 dashboard 生产构建通过。
