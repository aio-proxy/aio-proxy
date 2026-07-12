# Dashboard 测试清理设计

## 目标

删除通过读取源码、匹配字符串或解析 AST 来约束实现结构的 dashboard 测试，只保留真实行为测试。

## 保留标准

- 直接调用纯函数、状态机或服务逻辑并断言返回值或状态变化。
- 使用 Testing Library 渲染组件并模拟用户可观察的交互。
- 测试失败应表示行为变化，而不是文件组织、变量名或 JSX 写法变化。

## 删除范围

- 删除仅检查源码的 `delete-provider-dialog.test.tsx` 与 `provider-alias-drawer.test.tsx`。
- 从 provider options、JSON editor 和 usage overview 测试中删除源码字符串与 TypeScript AST 断言。
- 删除清理后不再使用的 Node 文件系统、path 和 TypeScript parser 辅助代码。
- 不新增替代测试来维持测试数量；对应 UI 后续发生行为变更时再补真实组件测试。

## 验证

- dashboard 测试中不再读取产品源码或调用 TypeScript AST parser。
- 剩余 Rstest 测试全部通过。
- Biome、Turbo dashboard 测试调度和 dashboard 构建通过。
