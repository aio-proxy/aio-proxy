# Dashboard 外观与语言切换设计

## 目标

在 dashboard 侧边栏底部增加“外观”和“语言”两个下拉入口，让用户切换显示主题与界面语言，并记住选择。

## 交互

- “外观”提供“跟随系统”“浅色”“深色”三个选项，选择后立即生效。
- “语言”提供“简体中文”“English”两个选项，选择后刷新当前 dashboard URL，使所有 Paraglide 文案可靠更新。
- 当前选项在下拉菜单中显示选中状态。
- 两个入口位于 `SidebarFooter`，沿用现有侧边栏菜单按钮、下拉菜单和图标样式。

## 实现

- 在 dashboard 根部挂载现有依赖 `next-themes` 的 `ThemeProvider`，使用 `class` 属性驱动现有 `.dark` CSS，并启用系统主题。
- 外观菜单通过 `useTheme` 读取和设置 `system`、`light`、`dark`；持久化交给 `next-themes`。
- 语言菜单通过 `@aio-proxy/i18n` 的 `getLocale` 和 `setLocale` 切换 `zh-Hans`、`en`，随后刷新当前页面。启动时继续由入口文件设置 `document.documentElement.lang`。
- 新增所需中英文消息，不引入依赖或通用设置框架。

## 边界与错误处理

- 仅支持项目现有的两种 locale 和三种主题模式。
- 不实现无刷新 locale 响应式状态层。
- 如果当前主题值尚未在客户端挂载完成，菜单仍可打开，但不依赖服务端渲染状态；dashboard 是纯客户端应用，不存在 hydration 冲突。
- locale 切换调用完成后再刷新；若调用返回 Promise，则等待完成。

## 验证

- 单元测试覆盖主题/语言选项配置和 locale 切换行为中可独立验证的逻辑。
- 运行 dashboard 单元测试、类型检查或构建，以及仓库格式检查中与改动相关的命令。
- 手动确认侧边栏底部位置、下拉选中态、主题即时变化、语言切换后当前 URL 不变且文案更新。
