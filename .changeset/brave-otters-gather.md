---
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情页现在展示完整的 span 树：请求解析、会话解析、路由各自成为一条 span，每次 provider 尝试挂在
一条推理 span 下，尝试内部再分出请求准备与上游 HTTP 请求；瀑布图按父子结构排序，首字时延画成尝试时间条
上的一道刻度，失败的尝试此前没有首字时延，现在也记录。token 用量与响应模型收敛到那条推理 span，属性名
改用 OpenTelemetry GenAI 语义约定，接入 Langfuse 等平台时不再把每次重试都算成一次生成。
