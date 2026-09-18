---
'@aio-proxy/server': patch
'aio-proxy': patch
---

请求日志此前只给 `authorization` 和 `x-api-key` 打码，`x-goog-api-key`、`api-key`、`proxy-authorization` 和 cookie 都是明文落盘的 —— 用 Google、Azure 或任何带会话 cookie 的上游时，日志文件里就有一份可直接冒用的凭据。现在这几个头一并打码。
