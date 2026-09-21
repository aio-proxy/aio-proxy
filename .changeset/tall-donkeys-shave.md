---
'@aio-proxy/server': patch
'aio-proxy': patch
---

请求日志此前会把自定义认证头和带签名的 URL、Location、Link 明文落盘。现在这些凭据会打码。
