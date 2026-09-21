---
'@aio-proxy/server': patch
'aio-proxy': patch
---

请求日志此前只给 `authorization` 和 `x-api-key` 打码，`x-goog-api-key`、`api-key`、`proxy-authorization` 和 cookie
都是明文落盘的 —— 用 Google、Azure 或任何带会话 cookie 的上游时，日志文件里就有一份可直接冒用的凭据。URL 里的
凭据、`Location` / `Operation-Location` 这类带签名 URL 的头、provider 配置里自定义的认证头（`X-Secret`、
`X-Auth-Token` 这类不在任何固定名单上的），以及 camelCase 的 query 参数名（`accessToken`、`clientSecret`）同样都漏。
现在按凭据词识别，头和参数一并打码，抓包接口读旧日志时也会按当前规则重脱一遍。
