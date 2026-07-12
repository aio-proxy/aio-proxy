# i18n Locale 自称设计

## 目标

语言选择器不再从翻译消息读取语言名称，由 `@aio-proxy/i18n` 统一提供每种 locale 的本语言名称。

## API

- 导出 `getLocaleName(locale: Locale): string`。
- 使用 `Intl.DisplayNames([locale], { type: "language" }).of(locale)` 获取 autonym。
- 如果运行环境未返回名称，回退到 locale 代码。
- 继续使用 Paraglide 生成的 `locales` 作为受支持语言及顺序的唯一来源。

## Dashboard

- 语言菜单遍历 `locales`，通过 `getLocaleName(locale)` 渲染标签。
- 删除 `language_zh_hans` 与 `language_en` 消息键。
- 新增语言不需要修改 dashboard 或复制语言名称到每种消息文件。

## 验证

- i18n 就近单测验证 `en` 显示为 `English`、`zh-Hans` 显示为 `简体中文`。
- dashboard 组件测试 mock `locales` 与 `getLocaleName`，继续验证语言选择行为。
- i18n、dashboard 测试与 dashboard 构建通过。
