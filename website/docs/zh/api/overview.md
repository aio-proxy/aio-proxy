---
title: API 概览
outline: false
---

# API 参考

通过侧栏中的公开 HTTP 接口调用 aio-proxy。每个页面对应一个接口，包含参数、响应格式和请求示例。

## 连接你的实例

请向你部署的 aio-proxy 实例发送请求。示例使用 `http://127.0.0.1:9317`，请替换为你的实例地址。文档站不会发送请求。

启用身份验证时，请使用 aio-proxy API 密钥作为 Bearer 令牌，不要将上游提供商的密钥作为客户端凭据。

## 协议兼容性

Chat Completions、Responses 和 Messages 提供各自协议中已支持的部分。具体以每个接口的 schema 和兼容性说明为准，不代表自动支持上游所有功能。

流式开启方式因接口而异：聊天类请求使用 `stream: true`，Gemini 使用独立的 `streamGenerateContent` 路由，音频的 `stream_format` 依赖上游支持。实时接口使用 WebSocket 或 SDP 信令，不是 SSE。原始透传保留上游格式，aio-proxy 不保证媒体流的事件 schema。

文档也包含向量、Token 计数、图片、音频、视频、System One 评估和实时信令，实际可用性取决于配置的上游。不包含 Dashboard、内部路由以及明确未支持的接口：响应查询/删除/取消/input-items、视频列表/角色、实时 session/client-secret 创建、实时翻译和通话 accept/reject/refer。
