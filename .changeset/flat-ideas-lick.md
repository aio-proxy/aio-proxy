---
'@aio-proxy/cli': major
'@aio-proxy/core': major
'@aio-proxy/dashboard': major
'@aio-proxy/plugin-github-copilot': major
'@aio-proxy/plugin-google-antigravity': major
'@aio-proxy/plugin-kimi-code': major
'@aio-proxy/plugin-openai-chatgpt': major
'@aio-proxy/plugin-sdk': major
'@aio-proxy/plugin-xai-grok': major
'@aio-proxy/server': major
'@aio-proxy/types': major
'aio-proxy': major
---

Move plugin display identity to descriptor metadata. Plugins must upgrade to descriptor API v2: use metadata.displayName and metadata.icon, OAuthAdapter.displayName, and OAuthLoginResult.accountLabel; old label and OAuth adapter icon fields are removed.
