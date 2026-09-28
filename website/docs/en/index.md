---
description: AIO Proxy lets existing clients connect to, route across, and observe multiple model providers through one endpoint.
pageType: home

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
  - title: One endpoint
    details: Point existing clients at AIO Proxy instead of rewriting calls for every model provider.
    icon: 🔌
  - title: Model-based routing
    details: Match model aliases across providers, try higher Provider priority first, distribute same-priority traffic by Provider weight, and continue to the next candidate when an upstream fails.
    icon: ↗️
  - title: Visible requests
    details: Use the Dashboard to inspect Provider configuration, request records, and runtime status without guesswork.
    icon: 🔎
---
