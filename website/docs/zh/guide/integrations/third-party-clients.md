---
description: 将 Cursor、VS Code、Claude Code、Cherry Studio、NextChat 等主流工具指向 AIO Proxy。
---

# 常用客户端与编辑器

AIO Proxy 完全兼容 OpenAI、Anthropic 与 Gemini 官方 HTTP 接口。任何支持自定义 Base URL 的客户端都可以无缝接入。

默认本地服务地址：`http://127.0.0.1:9317/v1`

---

## Cursor 配置

1. 打开 Cursor 设置：`Settings` -> `Features` -> `Model Settings`。
2. 找到 **OpenAI API Key**：
   - 填入你的 AIO Proxy API Key（如果开启了鉴权；未开启则填任意非空字符如 `sk-local`）。
   - 点击 `Override OpenAI Base URL`，填写：
     ```text
     http://127.0.0.1:9317/v1
     ```
3. 在模型列表中添加你在 AIO Proxy 中配置的模型名称（如 `gpt-5`、`claude-sonnet-4-6` 等）。

---

## VS Code 插件 (Continue / Cline / Roo Code)

以 **Continue** 为例：

在 `~/.continue/config.json` 中添加模型：

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

如果你在终端中使用 Anthropic 官方的 Claude Code 命令行工具，可以通过环境变量重定向请求：

```sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:9317"
export ANTHROPIC_API_KEY="sk-aio-proxy"
claude
```

---

## 桌面与 Web 对话客户端 (Cherry Studio, NextChat, LobeChat)

- **API 地址 (Base URL)**：`http://127.0.0.1:9317`（某些客户端要求补全为 `http://127.0.0.1:9317/v1`）。
- **API Key**：填入配置在 `server.apiKeys` 中的密钥（未开启强制鉴权时可填任意字符）。
- **自定义模型**：输入你在 AIO Proxy 中定义的公开模型 ID 或别名。
