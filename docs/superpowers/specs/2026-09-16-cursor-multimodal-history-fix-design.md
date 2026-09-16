# Cursor 历史多模态请求修复设计

**日期：** 2026-09-16  
**状态：** 已确认根因，待实现

## 问题

`rfc-jp2-co.tail692374.ts.net` 上的 `aio-proxy` 在通过 Cursor provider 请求
`claude-fable-5-1` 时，只要先前的用户消息包含内联图片、当前轮继续追问，请求就会失败：

```text
internal: Unsupported content type: file
```

同一模型的新纯文本会话返回 200；在失败请求中仅移除历史 `input_image` 后也返回 200。
因此故障不在模型目录、OAuth、网络或模型本身，而在 Cursor 跨轮图片序列化。

## 根因

OpenAI 图片进入 AI SDK 后使用合法的 `LanguageModelV4FilePart`，其判别字段为
`type: "file"`。Cursor 当前轮和历史 turn 已经能把它转换成原生
`UserMessage.selectedContext.selectedImages`。

`buildRootMessages()` 又把历史用户图片原样复制到 `rootPromptMessagesJson`，生成：

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "inspect this image" },
    { "type": "file", "mediaType": "image/png", "data": { "type": "data", "data": "AQID" } }
  ]
}
```

`file` 是 aio-proxy/AI SDK 的内部消息类型，不是 Cursor root message 接受的内容类型，
所以上游在处理历史图片时返回 internal error。

## 目标行为

- 当前用户消息的图片继续编码到 `UserMessageAction.userMessage.selectedContext.selectedImages`。
- 历史用户消息的图片继续编码到 `ConversationTurnStructure` 引用的
  `UserMessage.selectedContext.selectedImages`，保留 MIME 类型与原始字节。
- `rootPromptMessagesJson` 的用户消息只携带其文本内容，不再发出
  `type: "file"`。
- 历史图片请求不再因为非法 root content type 返回 500。
- 文本历史、assistant 历史、工具调用/结果与 checkpoint 重用行为保持不变。

## 范围

修复位于 Cursor plugin 的 root history 构造边界。不要修改 core 的
`imageFilePart`/AI SDK 文件表示，不要猜测一个未经验证的 Cursor
`type: "image"` root JSON 结构，也不要引入新的转换抽象或依赖。

远端升级、服务重启和流量切换不属于本实现计划；它们需要单独授权。发布或部署前必须用
“图片首轮 + 文本追问”的真实 Cursor 请求确认后续回答仍能引用图片内容，而不是仅确认 500 消失。

## 验收标准

1. 一个覆盖完整多轮请求的单测证明 root JSON 中没有 `type: "file"`。
2. 同一单测证明历史 turn 的 `SelectedImage` 仍包含 `image/png` 与预期字节。
3. Cursor plugin 单测、`bun run check`、`bun run preflight` 全部通过。
4. changeset 同时对 `@aio-proxy/plugin-cursor` 与 `aio-proxy` 做 patch 变更。
5. 获得部署授权后，真实后续轮次不再返回 500，并能正确回答依赖历史图片的问题。
