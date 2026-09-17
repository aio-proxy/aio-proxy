# Cursor Historical Multimodal Request Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Cursor provider 在内联图片进入对话历史后向 root prompt 发出不受支持的 `type: "file"`、导致后续 `claude-fable-5-1` 请求全部失败的问题。

**Architecture:** 保留现有双通道结构：Cursor 原生 `ConversationTurnStructure` 继续通过 `UserMessage.selectedContext.selectedImages` 承载历史图片，`rootPromptMessagesJson` 只承载 Cursor 已接受的文本和工具历史。修复集中在 `buildRootMessages()` 的用户消息分支，不修改 core 图片表示、路由或 provider 接口。

**Tech Stack:** Bun、TypeScript、AI SDK Language Model V4 prompt、Buf protobuf、`bun:test`、Changesets。

**Spec:** `docs/superpowers/specs/2026-09-16-cursor-multimodal-history-fix-design.md`

## Global Constraints

- 根因已由线上单变量探针确认：保留失败会话但移除历史 `input_image` 后 HTTP 500 恢复为 200。
- `LanguageModelV4FilePart.type === "file"` 是合法内部表示；不得修改 `packages/core/src/image-input/image-input.ts`。
- Cursor root message 不得包含 `type: "file"`；不要替换成未经协议证实的 `type: "image"`。
- 历史图片必须继续存在于 `ConversationTurnStructure → UserMessage.selectedContext.selectedImages`，MIME 与字节不得丢失。
- 不新增 helper、抽象、依赖或配置；最小修复是删除 root JSON 中重复且非法的图片复制逻辑。
- 不改变当前轮图片、文本历史、工具历史、checkpoint 重用与 provider fallback 行为。
- 用户可见修复必须包含 patch changeset，且同时列出 `@aio-proxy/plugin-cursor` 与 `aio-proxy`。
- 本计划不部署到 `rfc-jp2-co.tail692374.ts.net`，不升级或重启远端服务。
- 所有仓库命令使用 `rtk` 前缀。

## File Structure

- Modify: `packages/plugins/cursor/src/runtime/run-request/run-request.test.ts` — 在完整 run request 边界同时验证 root JSON 和历史 protobuf turn，覆盖线上失败形态。
- Modify: `packages/plugins/cursor/src/runtime/history/root-messages.ts` — 停止把历史图片复制成 Cursor 不支持的 root `file` content。
- Create via `bun changeset`: `.changeset/*.md`（本任务只生成一个文件）— 记录 Cursor 多轮图片请求修复，并让产品包发布说明包含该修复。

---

### Task 1: 用回归测试锁定历史图片的两个输出通道并实施最小修复

**Files:**
- Modify: `packages/plugins/cursor/src/runtime/run-request/run-request.test.ts:3-8,265-297`
- Modify: `packages/plugins/cursor/src/runtime/history/root-messages.ts:43-59`
- Test: `packages/plugins/cursor/src/runtime/run-request/run-request.test.ts`

**Interfaces:**
- Consumes: `buildCursorRunRequestBytes(input)`；输入为包含“历史 user 文本+图片、assistant 回复、当前 user 追问”的 `LanguageModelV4Prompt`。
- Produces: 不新增或修改公开接口。`ConversationStateStructure.rootPromptMessagesJson` 的历史 user root content 只含文本；`ConversationStateStructure.turns` 引用的历史 `UserMessage` 继续包含 `SelectedImage`。

- [ ] **Step 1: 写失败回归测试**

把 `run-request.test.ts` 的 protobuf import 从：

```ts
import { AgentClientMessageSchema, ConversationStateStructureSchema } from '../../gen/agent_pb';
```

改为：

```ts
import {
  AgentClientMessageSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from '../../gen/agent_pb';
```

紧跟现有测试 `a changed image in full history rebuilds instead of reusing stale cached turns` 后添加：

```ts
test('keeps historical images in Cursor turns without emitting root file content', () => {
  const blobStore = new Map<string, Uint8Array>();
  const { conversationState } = buildCursorRunRequestBytes({
    prompt: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'inspect this image' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AQID' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'initial analysis' }] },
      { role: 'user', content: [{ type: 'text', text: 'what did the image show?' }] },
    ],
    wireModelId: 'claude-4.5-sonnet',
    displayModelId: 'claude-4.5-sonnet',
    displayName: 'Claude',
    maxMode: false,
    state: { conversationId: 'conv-image-follow-up', blobStore },
  });

  const rootMessages = conversationState.rootPromptMessagesJson.map((id) =>
    JSON.parse(new TextDecoder().decode(blobStore.get(Buffer.from(id).toString('hex')))),
  );
  expect(rootMessages).toContainEqual({
    role: 'user',
    content: [{ type: 'text', text: 'inspect this image' }],
  });
  expect(JSON.stringify(rootMessages)).not.toContain('"type":"file"');

  expect(conversationState.turns).toHaveLength(1);
  const turnBytes = blobStore.get(Buffer.from(conversationState.turns[0]!).toString('hex'));
  if (turnBytes === undefined) throw new Error('expected historical turn blob');
  const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
  if (turn.turn.case !== 'agentConversationTurn') throw new Error('expected agent turn');
  const userMessageBytes = blobStore.get(Buffer.from(turn.turn.value.userMessage).toString('hex'));
  if (userMessageBytes === undefined) throw new Error('expected historical user message blob');
  const historicalUser = fromBinary(UserMessageSchema, userMessageBytes);
  const image = historicalUser.selectedContext?.selectedImages[0];
  expect(image?.mimeType).toBe('image/png');
  expect(image?.dataOrBlobId.case).toBe('data');
  expect([...(image!.dataOrBlobId.value as Uint8Array)]).toEqual([1, 2, 3]);
});
```

这个测试必须放在 run-request 边界，而不是只测 `createCursorUserMessage()`：回归同时涉及 root JSON 与 protobuf turns 两个输出，单测一个 helper 无法重现线上故障。

- [ ] **Step 2: 运行测试并确认它以正确原因失败**

Run:

```bash
rtk bun test packages/plugins/cursor/src/runtime/run-request/run-request.test.ts
```

Expected: 新测试 FAIL；`rootMessages` 中的历史 user content 仍多出 `{"type":"file",...}`。既有测试保持通过，且历史 turn 的 SelectedImage 断言本身不暴露编码缺失。

- [ ] **Step 3: 删除 root JSON 中重复的历史图片序列化**

在 `packages/plugins/cursor/src/runtime/history/root-messages.ts` 中，把 `buildRootMessages()` 的 user 分支：

```ts
if (message.role === 'user') {
  const text = extractV4UserText(message.content);
  const content: unknown[] = text.length > 0 ? [{ type: 'text', text }] : [];
  for (const part of message.content) {
    if (
      part.type !== 'file' ||
      (part.mediaType !== 'image' && !part.mediaType.startsWith('image/')) ||
      part.data.type !== 'data'
    )
      continue;
    const data =
      part.data.data instanceof Uint8Array
        ? Buffer.from(part.data.data).toString('base64')
        : Buffer.from(part.data.data, 'base64').toString('base64');
    content.push({ type: 'file', mediaType: part.mediaType, data: { type: 'data', data } });
  }
  if (content.length > 0) messages.push({ role: 'user', content });
}
```

替换为：

```ts
if (message.role === 'user') {
  const text = extractV4UserText(message.content);
  // Historical images already travel in ConversationTurnStructure selectedImages;
  // Cursor root messages reject the AI SDK's `file` content type.
  if (text.length > 0) messages.push({ role: 'user', content: [{ type: 'text', text }] });
}
```

不要删除文件顶部的 `Buffer` import：`rootToolCallId()` 仍用它生成合法 tool call ID。

- [ ] **Step 4: 运行定向测试并确认通过**

Run:

```bash
rtk bun test packages/plugins/cursor/src/runtime/run-request/run-request.test.ts
```

Expected: 全部测试 PASS；新测试证明 root JSON 不再包含 `file`，同时历史 turn 仍保留 `image/png` 和 `[1, 2, 3]`。

- [ ] **Step 5: 运行 Cursor plugin 全量单测与静态检查**

Run:

```bash
rtk bun test packages/plugins/cursor
rtk bun run check
rtk git diff --check
```

Expected: 三条命令均退出 0。若 `format:check` 报本次修改的格式差异，只格式化两个已修改的 TypeScript 文件，然后重新执行本 Step：

```bash
rtk bunx oxfmt packages/plugins/cursor/src/runtime/history/root-messages.ts packages/plugins/cursor/src/runtime/run-request/run-request.test.ts
```

- [ ] **Step 6: 提交根因修复**

先确认提交范围：

```bash
rtk git diff -- packages/plugins/cursor/src/runtime/history/root-messages.ts packages/plugins/cursor/src/runtime/run-request/run-request.test.ts
```

Expected: 一个测试新增、一个 user 分支删除非法图片复制逻辑，没有 core、路由或配置改动。

提交：

```bash
rtk git add packages/plugins/cursor/src/runtime/history/root-messages.ts packages/plugins/cursor/src/runtime/run-request/run-request.test.ts
rtk git commit -m "fix(cursor): preserve historical multimodal follow-ups" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: 添加发布说明并执行仓库级验证

**Files:**
- Create: `.changeset/*.md`（由本 Task 的单次 `bun changeset` 命令生成一个文件）
- Include: `docs/superpowers/plans/2026-09-16-cursor-multimodal-history-fix.md`
- Include: `docs/superpowers/specs/2026-09-16-cursor-multimodal-history-fix-design.md`
- Verify: `packages/plugins/cursor/src/runtime/history/root-messages.ts`
- Verify: `packages/plugins/cursor/src/runtime/run-request/run-request.test.ts`

**Interfaces:**
- Consumes: Task 1 已通过测试的 Cursor plugin 行为。
- Produces: `@aio-proxy/plugin-cursor` 与 `aio-proxy` 的 patch release metadata；不产生运行时代码接口。

- [ ] **Step 1: 用 Changesets CLI 创建 patch changeset**

Run:

```bash
rtk bun changeset --patch '@aio-proxy/plugin-cursor,aio-proxy' --message 'Fixed Cursor multimodal follow-up requests failing after an inline image moved into conversation history.'
```

Expected: CLI 生成且只生成一个新 `.changeset/*.md` 文件，内容等价于：

```md
---
'@aio-proxy/plugin-cursor': patch
'aio-proxy': patch
---

Fixed Cursor multimodal follow-up requests failing after an inline image moved into conversation history.
```

不要运行 `changeset version` 或 `changeset publish`；版本与发布由 CI 管理。

- [ ] **Step 2: 运行完整 preflight**

Run:

```bash
rtk bun run preflight
```

Expected: `lint:types`、`format:check`、全部 unit/artifact tests 均通过，命令退出 0。

- [ ] **Step 3: 检查最终 diff 与 changeset 范围**

Run:

```bash
rtk git diff --check
rtk git status --short
rtk git diff -- .changeset packages/plugins/cursor/src/runtime/history/root-messages.ts packages/plugins/cursor/src/runtime/run-request/run-request.test.ts
```

Expected: Task 1 已提交时，运行时代码已干净；未提交内容只剩一个新 changeset 和本计划的 plan/spec 文档。changeset 仅列出两个指定包和一段用户可见说明。若执行方式把两项任务合并为一个提交，最终运行时 diff 也只能包含上述两个 TypeScript 文件。

- [ ] **Step 4: 提交 changeset**

Task 1 已提交且 Step 3 已确认 `.changeset/` 只有这一个新增文件，因此以下 glob 只会暂存本 Task 的 release metadata；同时提交本次 planning artifacts：

```bash
rtk git add .changeset/*.md docs/superpowers/plans/2026-09-16-cursor-multimodal-history-fix.md docs/superpowers/specs/2026-09-16-cursor-multimodal-history-fix-design.md
rtk git commit -m "chore: document cursor multimodal history fix" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Post-Implementation Release Gate

本计划到此完成，不连接或修改远端服务。后续获得部署授权并安装含本修复的版本后，必须重放以下两轮请求：

```text
Turn 1: 发送一张内容可明确识别的图片，并询问图片内容。
Turn 2: 不重复发送图片，追问一个只有看过该图片才能回答的细节。
```

Expected: 两轮均返回成功；第二轮没有 `Unsupported content type: file`，并且答案能引用首轮图片细节。若仅 500 消失但第二轮无法引用图片，停止发布：这说明 Cursor 没有从历史 turn 读取 `SelectedImage`，需要先捕获官方客户端的历史图片 wire payload，再另立协议兼容方案；不要把图片猜写成 root `type: "image"`。
