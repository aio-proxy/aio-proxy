---
description: Configure Cursor, VS Code (Continue/Cline/Roo Code), Claude Code, Cherry Studio, and NextChat with AIO Proxy.
---

# Clients & Editors

AIO Proxy is fully compatible with official OpenAI, Anthropic, and Gemini HTTP specifications. Any client or application supporting a custom Base URL can connect seamlessly.

Default Local Service Address: `http://127.0.0.1:9317/v1`

---

## Cursor

1. Open Cursor Settings: `Settings` -> `Features` -> `Model Settings`.
2. Locate **OpenAI API Key**:
   - Enter your AIO Proxy API Key (or arbitrary characters like `sk-local` if authentication is disabled).
   - Click `Override OpenAI Base URL` and enter:
     ```text
     http://127.0.0.1:9317/v1
     ```
3. Add the model names exposed by your providers in AIO Proxy (such as `gpt-5`, `claude-sonnet-4-6`).

---

## VS Code Extensions (Continue / Cline / Roo Code)

Example with **Continue**:

Add models in `~/.continue/config.json`:

```json title="config.json"
{
  "models": [
    {
      "title": "AIO Proxy - GPT-5",
      "provider": "openai",
      "model": "gpt-5",
      "apiBase": "http://127.0.0.1:9317/v1",
      "apiKey": "sk-aio-proxy"
    },
    {
      "title": "AIO Proxy - Claude",
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "apiBase": "http://127.0.0.1:9317/v1",
      "apiKey": "sk-aio-proxy"
    }
  ]
}
```

---

## Claude Code CLI

If you use Anthropic's official Claude Code CLI in your terminal, redirect requests via environment variables:

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:9317"
export ANTHROPIC_API_KEY="sk-aio-proxy"
claude
```

---

## Chat UIs (Cherry Studio, NextChat, LobeChat)

- **API Base URL**: `http://127.0.0.1:9317` (or `http://127.0.0.1:9317/v1` depending on client conventions).
- **API Key**: Enter the key configured in `server.apiKeys` (or any string if authentication is disabled).
- **Model Name**: Enter the public model ID or alias declared in your configuration.
