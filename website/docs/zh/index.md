---
description: AIO Proxy 让现有客户端通过一个端点连接、路由和观测多个模型提供商。
pageType: home

hero:
  name: AIO Proxy
  text: 所有模型，所有客户端，一个端点。
  tagline: 继续使用现有的 SDK 和编程 Agent，接入 API Key 或你已经订阅的服务，一个本地二进制即可获得智能路由、自动故障转移与完整请求链路。
  actions:
    - theme: brand
      text: 开始使用
      link: /zh/guide/start/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/aio-proxy/aio-proxy
features:
  - title: 所有协议，一个端点
    details: OpenAI Responses、Chat Completions、Anthropic Messages 与 Gemini 客户端共用一个端点。协议一致时原样透传，不一致时自动转换工具调用、推理内容与流式输出。
    icon: 🔌
  - title: 路由与故障转移
    details: 高优先级层先试，同层内按提供商权重分摊流量，会话固定在同一个 Provider，上游失败时自动切到下一个候选。
    icon: ↗️
  - title: 接入已有订阅
    details: 通过 OAuth 登录 ChatGPT、Claude、GitHub Copilot、Google Antigravity、Cursor、xAI Grok 等订阅，作为标准 API 端点使用。
    icon: 🔑
  - title: 一条命令接好 Agent
    details: '`aiop agent configure` 可直接配置 Codex、Grok Build、OpenCode、Pi 与 OMP，其他工具只需修改 Base URL。'
    icon: 🤖
  - title: 请求全程可见
    details: Dashboard 记录每一次请求与 Provider 尝试的状态、延迟、Token、费用与完整链路，并可导出到 OpenTelemetry。
    icon: 🔎
---
