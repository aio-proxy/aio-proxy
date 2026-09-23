---
'aio-proxy': minor
'@aio-proxy/plugin-openai-chatgpt': minor
'@aio-proxy/plugin-sdk': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
---

Configure ChatGPT's user agent once on the Plugins page for all ChatGPT providers, without signing in again. The default follows the latest stable Codex version through cached, proxy-aware npm and GitHub lookups, with a fallback when both fail. Plugin options support simple Handlebars variables such as `{{latest_codex_rs_version}}`, and plugin form fields can declare default values. Previously saved provider-level user agents are ignored.
