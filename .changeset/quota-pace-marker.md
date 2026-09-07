---
'aio-proxy': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/i18n': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-github-copilot': minor
'@aio-proxy/plugin-google-antigravity': minor
'@aio-proxy/plugin-kimi-code': minor
'@aio-proxy/plugin-cursor': minor
'@aio-proxy/plugin-xai-grok': minor
---

Subscription quota bars now mark where an even burn would have left the allowance by now, turning
red when the window is being spent faster than that and drawing nothing while it tracks even. The
marker appears wherever the provider reports how long the window lasts, which the bundled OAuth
plugins now do; plugins can opt in through the new optional `OAuthQuotaItem.windowMinutes`. The
reading is also spoken by the bar's accessible value text.
