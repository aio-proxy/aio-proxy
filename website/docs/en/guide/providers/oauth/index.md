---
description: Overview of AIO Proxy built-in OAuth plugins, browser-based PKCE login, dynamic model discovery, and token lifecycle management.
---

# OAuth Plugin Providers Overview

AIO Proxy features 10 built-in OAuth plugins that allow you to securely connect your personal or organization subscription accounts without dealing with raw API keys.

## Supported OAuth Plugins

| Provider Key         | Target Service              | Authentication Flow      |
| :------------------- | :-------------------------- | :----------------------- |
| `openai-chatgpt`     | OpenAI ChatGPT Pro / Team   | PKCE OAuth Web Login     |
| `claude-code`        | Claude Pro / Team / Max     | OAuth Browser Login      |
| `cursor`             | Cursor IDE Subscription     | OAuth Browser Login      |
| `github-copilot`     | GitHub Copilot / Enterprise | Device Code Flow         |
| `google-antigravity` | Google Antigravity          | Google OAuth PKCE        |
| `kimi-code`          | Kimi Code                   | OAuth Device Flow        |
| `muse-code`          | Muse Code                   | OAuth Device Flow        |
| `opencode-go`        | OpenCode Go                 | OAuth Flow               |
| `openrouter`         | OpenRouter PKCE             | OAuth Authorization Code |
| `xai-grok`           | xAI Grok                    | Device Code Flow         |

---

## Logging In & Device Authorization

You can initiate login directly from the CLI or via the Dashboard UI:

```sh
# Initiate browser login flow
aio-proxy oauth login <provider-id>
```

Tokens are securely stored in `~/.aio-proxy/tokens/` and automatically refreshed prior to expiration.
