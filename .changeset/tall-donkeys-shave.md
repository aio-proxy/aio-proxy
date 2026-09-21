---
'@aio-proxy/server': patch
'aio-proxy': patch
---

请求日志此前只给少数固定头打码，provider 自定义认证头、URL 凭据（含 `#access_token=` 这种 fragment）、带签名的 `Location` / `Link`（含 path-relative）都会明文落盘。现在按凭据词识别头和参数（含 `X-Authorization`、`X-Bearer` 这种小写后切不出 `auth` 的名字），抓包接口读旧日志时也会按当前规则再脱一遍。
