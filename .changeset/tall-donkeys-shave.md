---
'@aio-proxy/server': patch
'aio-proxy': patch
---

请求日志此前只给 `authorization` 和 `x-api-key` 打码，`x-goog-api-key`、`api-key`、`proxy-authorization` 和 cookie
都是明文落盘的 —— 用 Google、Azure 或任何带会话 cookie 的上游时，日志文件里就有一份可直接冒用的凭据。URL 里的
凭据同样漏，而且 camelCase 的参数名（`accessToken`、`authToken`、`clientSecret`、`refreshToken`）连后来加的
query 脱敏也认不出来。现在这些头和参数一并打码，抓包接口读旧日志时也会按当前规则重脱一遍。
