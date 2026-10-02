---
'aio-proxy': patch
'@aio-proxy/server': patch
'@aio-proxy/dashboard': patch
'@aio-proxy/i18n': patch
---

保留每次上游发送的独立传输计时、重试失败原因和响应来源，并在调用链详情中显示发送次数与序号，避免多次响应的计时被歧义抑制。
