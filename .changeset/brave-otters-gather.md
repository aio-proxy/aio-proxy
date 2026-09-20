---
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情页现在展示完整的 span 树：请求解析、会话解析、路由各自成为一条 span，每次 provider 尝试挂在
一条推理 span 下，尝试内部的请求准备与上游 HTTP 请求再各成一条；瀑布图按父子结构排序，首字时延画成尝试
时间条上的一道刻度。尝试的首字时延改为从尝试开始计时（含请求准备与建连），失败的尝试此前没有这个数、现在
也记录；一次尝试里观测到多个响应时无法归因，面板会说明原因而不是留一个「—」。token 用量与模型不再重复挂
在根 span 和每次尝试上，收敛到那条推理 span，属性名对齐 OpenTelemetry GenAI 语义约定。
