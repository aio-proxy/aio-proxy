---
description: 配置 OpenAI Video 视频生成、查询与作业管理协议（兼容 Sora 视频 API）。
---

# OpenAI Video 协议 (`openai-video`)

`openai-video` 用于兼容基于 OpenAI Sora 规范构建的视频生成、轮询检索与作业删除端点：

- 创建视频作业：`POST /v1/videos`
- 查询视频状态：`GET /v1/videos/{video_id}`
- 下载视频内容：`GET /v1/videos/{video_id}/content`
- 删除视频作业：`DELETE /v1/videos/{video_id}`
- 视频重混 (Remix)：`POST /v1/videos/{video_id}/remix`

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "sora-gateway": {
      "kind": "api",
      "protocol": "openai-video",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "{{env.SORA_GATEWAY_KEY}}",
      "models": ["sora-2"],
    },
  },
}
```

## 协议特性

- **默认模型**：未指定模型时，AIO Proxy 默认按 `sora-2` 寻找候选提供商。
- **状态 Pinning**：由于视频任务是异步生成，查询、下载与删除操作依赖初次创建时在进程内记录的提供商绑定；请通过同一 AIO Proxy 实例管理完整的视频作业生命周期。
- **纯透传模式**：该协议仅支持通过原始透传方式调用。
