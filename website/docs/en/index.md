---
description: AIO Proxy lets existing clients connect to, route across, and observe multiple model providers through one endpoint.
pageType: home
titleSuffix: Every model. Every client. One endpoint.

hero:
  name: AIO Proxy
  text: Every model. Every client. One endpoint.
  tagline: Keep the SDKs and coding agents you already use, plug in API keys or the subscriptions you already pay for, and get routing, failover, and full request traces from one local binary.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/start/getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/aio-proxy/aio-proxy
features:
  - title: Every protocol, one endpoint
    details: OpenAI Responses, Chat Completions, Anthropic Messages, and Gemini clients share one endpoint. Matching protocols pass through raw; the rest are converted, including tools, reasoning, and streaming.
    icon: 🔌
  - title: Routing and failover
    details: Higher Provider priority tiers are tried first, Provider weight splits traffic within a tier, sessions stay on one Provider, and a failed upstream falls through to the next candidate.
    icon: ↗️
  - title: Bring your subscriptions
    details: Log in with OAuth to ChatGPT, Claude, GitHub Copilot, Google Antigravity, Cursor, xAI Grok, and more, and use them as standard API endpoints.
    icon: 🔑
  - title: Coding agents in one command
    details: '`aiop agent configure` wires up Codex, Grok Build, OpenCode, Pi, and OMP; anything else only needs a base URL.'
    icon: 🤖
  - title: Requests you can see
    details: The Dashboard records every request and Provider attempt with status, latency, tokens, cost, and full traces, exportable to OpenTelemetry.
    icon: 🔎
---
