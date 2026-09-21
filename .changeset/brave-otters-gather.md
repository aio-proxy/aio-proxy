---
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情页现在展示完整的 span 树：解析、会话、路由各成一条；每次请求有一层逻辑操作 span 覆盖路由与全部失败转移，其下每个 provider 尝试各成一条推理 span（厂商、模型、token），再往下是请求准备与每一次上游 HTTP 发送，同一 provider 的退避重试逐次成行。
瀑布图按父子结构排序，首字时延画成刻度；尝试的首字时延从尝试开始计，失败的尝试也记录，一次尝试观测到多个响应时说明无法归因的原因。
token 用量与模型不再挂在根 span 上；客户端主动取消不再标成错误。
