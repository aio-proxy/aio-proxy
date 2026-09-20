---
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情页现在展示完整的 span 树：解析、会话、路由各成一条 span；每次请求有一层逻辑操作 span 覆盖路由与
全部失败转移，其下每个 provider 尝试各成一条推理 span，带 GenAI 语义约定的厂商、模型与 token 属性，再往下
是请求准备与每一次上游 HTTP 发送 —— 同一个 provider 内部的退避重试此前完全不可见，现在逐次成行并记录次数。
瀑布图按父子结构排序，首字时延画成刻度；尝试的首字时延改为从尝试开始计时，失败的尝试此前没有这个数、现在
也记录，一次尝试观测到多个响应时会说明无法归因的原因。token 用量与模型不再挂在根 span 上；客户端主动取消
不再标成错误。
