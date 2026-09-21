---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/logger': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情改为整页三个标签页。「详情」是带时间刻度的瀑布图加选中 span 的状态、耗时、Token 与可筛选属性；同模型样本足够时，结束后才查延迟分位。原摘要侧栏已去掉。「请求」「响应」按跳列出站与每次上游发送（含同一次尝试里失败后再发的那些，以及进程中断后从抓包恢复的跳），无正文的成功响应记为完成；还在跑时详情会刷新并跟上跨零点的新日志，缺天会标明不完整，流式跳在响应结束前保持进行中，根 span 先结束而抓包 body 还没写完时也会继续扫（fetch 在出响应前抛错的 hop 除外），结束后再抓一次完整日志。抓包需 `server.logging.enabled: true` 且 `level: debug`（写穿磁盘）；未开启或过期时说明原因，过大 body 会截断并注明。
