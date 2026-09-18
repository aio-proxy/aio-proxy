---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/logger': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情页的瀑布图加了真实时间刻度尺和 span 名称搜索，右栏在同模型样本足够时显示这次请求的延迟分位对比。「请求」「响应」两个标签页不再只看得到入站那一组，而是按跳列出入站和每次上游尝试，逐跳查看请求行、headers 和 body；线级抓包需要 `server.logging.enabled: true` 且 `level: debug`，未开启或日志已过保留期时会说明原因而不是显示空白。`level: debug` 下日志改为写穿磁盘，刚发出的请求立刻抓得到；单跳单方向的 body 超过 1 MB 会截断并在面板上注明。
