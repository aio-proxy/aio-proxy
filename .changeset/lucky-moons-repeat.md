---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/logger': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情改为整页三个标签页。「详情」是带时间刻度的瀑布图加选中 span 的状态、耗时、Token 与可筛选属性；同模型样本足够时，结束后才查延迟分位。原摘要侧栏已去掉。「请求」「响应」按跳列出站与每次上游发送（含同一次尝试里失败后再发的那些，以及进程中断后从抓包恢复的跳），无正文的成功响应记为完成，故意不抓的视频正文在客户端读完、失败或取消时才记终态；还在跑时详情会刷新并跟上跨零点的新日志，缺天会标明不完整，流式跳在响应结束前保持进行中，根 span 先结束而抓包 body 还没写完时也会继续扫（fetch 在出响应前抛错、以及进程中断后恢复的除外），结束后再抓一次完整日志。丢掉 4xx/5xx 正文的失败跳显示失败，不显示取消。取消的调用链（根 span 保持 UNSET）不进成功/失败柱和延迟分位。计 token 请求的上游 HTTP 挂在对应 attempt 下，debug 抓包也会带上 attempt（含 anthropic raw 直通）。抓包需 `server.logging.enabled: true` 且 `level: debug`（写穿磁盘）；未开启或过期时说明原因，过大 body 会截断并注明。
