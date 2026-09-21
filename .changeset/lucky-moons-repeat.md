---
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/logger': minor
'@aio-proxy/server': minor
'@aio-proxy/i18n': minor
'@aio-proxy/dashboard': minor
'aio-proxy': minor
---

调用链详情页改为整页三个标签页。「详情」页左边是带真实时间刻度尺和名称搜索的瀑布图，右边是选中 span 的状态、耗时与 Token 指标、可搜索的属性表，属性可一键成为列表页的筛选条件；同模型样本足够时还会显示这次请求的延迟分位对比，且等调用结束后才去查。此前重复抄一遍 Trace 标识与摘要的侧栏已移除。「请求」「响应」两页按跳列出入站和每次上游尝试，逐跳查看请求行、headers 和 body；调用还在跑时详情会跟着刷新，这两页跟上新写入的日志（跨本地零点也会扫到今天），流式跳在响应结束前保持进行中，选择器也会带上 span 还没落盘的上游跳，结束后再抓一次完整日志才固定下来、不再扫。线级抓包需要 `server.logging.enabled: true` 且 `level: debug`，未开启或日志已过保留期时会说明原因而不是显示空白。`level: debug` 下日志改为写穿磁盘，刚发出的请求立刻抓得到；过大的 body 会被截断，面板上会注明。
