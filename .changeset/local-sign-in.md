---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/cli': minor
'@aio-proxy/dashboard': minor
'@aio-proxy/types': minor
'@aio-proxy/i18n': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-github-copilot': minor
---

ChatGPT and GitHub Copilot Providers can use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex signed in when it refreshes, and removing the Provider never signs the tool out.
