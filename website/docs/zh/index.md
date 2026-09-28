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
  - title: 统一端点
    details: 将现有客户端指向 AIO Proxy，无需为每个模型提供商改写调用方式。
    icon: 🔌
  - title: 按模型路由
    details: 使用模型别名匹配多个提供商，优先尝试更高的提供商优先级，在同一优先级内按提供商权重分配流量，并在上游失败时继续尝试。
    icon: ↗️
  - title: 请求可见
    details: 通过 Dashboard 查看 Provider 配置、请求记录与运行状态，定位问题更直接。
    icon: 🔎
---
