# Confirmed Architecture Findings Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复已核实的流取消、Responses 工具出站、上游敏感头、真实 body 上限、stream 背压、非 loopback 暴露和低风险一致性问题。

**Architecture:** 保持 `ProtocolAdapter` 和唯一 routing pipeline 的现有接口不变。把跨协议共享的流生命周期和请求读取做成深模块，协议 egress 只保留协议编码状态；安全策略采用 local-only 默认，非 loopback 直接在配置解析阶段拒绝。

**Tech Stack:** Bun, TypeScript 6, Web Streams, Hono, Zod, AI SDK 7, OpenAI SDK 6, Bun test.

## Global Constraints

- 所有行为变更必须按 RED → GREEN 顺序实现。
- 同协议 raw passthrough 的响应字节不得改变。
- `packages/server/src/routes/pipeline.ts` 仍是唯一候选循环；route 文件不得新增 provider 分支。
- 不增加新的运行时依赖。
- 默认部署模型保持 local-only；本计划不实现远程 Dashboard 登录或 session。
- 每个 Task 独立提交、独立验证，可单独回滚。

---

### Task 1: 让所有协议 egress 向上游传播 cancel

**Files:**
- Create: `packages/core/src/egress/cancellable-stream.ts`
- Modify: `packages/core/src/egress/anthropic-messages.ts`
- Modify: `packages/core/src/egress/openai-completions.ts`
- Modify: `packages/core/src/egress/openai-responses.ts`
- Modify: `packages/core/src/egress/gemini-generate-content.ts`
- Test: `packages/core/_test/egress/cancellable-stream.test.ts`
- Test: `packages/server/_test/pipeline.test.ts`

**Interfaces:**
- Produces: `createCancellableEgressStream<T>(source, run): ReadableStream<Uint8Array>`.
- `run` receives an async iterable `parts` and an `enqueue(bytes)` callback; the module owns reader cancellation, release, close and error propagation.

- [ ] **Step 1: Write the failing lifecycle test**

```ts
test("downstream cancellation cancels the source reader exactly once", async () => {
  let cancelled: unknown;
  const source = new ReadableStream<number>({
    pull(controller) {
      controller.enqueue(1);
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });

  const reader = output.getReader();
  await reader.read();
  await reader.cancel("client disconnected");

  expect(cancelled).toBe("client disconnected");
});
```

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/egress/cancellable-stream.test.ts`

Expected: FAIL because `createCancellableEgressStream` does not exist.

- [ ] **Step 3: Implement the shared stream lifecycle module**

```ts
export type EgressRunContext<T> = {
  readonly parts: AsyncIterable<T>;
  readonly enqueue: (value: Uint8Array) => void;
};

export function createCancellableEgressStream<T>(
  source: ReadableStream<T>,
  run: (context: EgressRunContext<T>) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let cancelled = false;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const parts = {
    async *[Symbol.asyncIterator]() {
      while (!cancelled) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    },
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await run({ parts, enqueue: (value) => controller.enqueue(value) });
        if (!cancelled) controller.close();
      } catch (error) {
        if (!cancelled) controller.error(error);
      } finally {
        release();
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}
```

- [ ] **Step 4: Replace the four protocol SSE wrappers**

Each writer keeps its current state machine, but replaces `new ReadableStream({ async start(controller) { ... } })` with:

```ts
return createCancellableEgressStream(stream, async ({ parts, enqueue }) => {
  const send = (value: Uint8Array) => enqueue(value);
  for await (const part of parts) {
    // Existing protocol switch, unchanged.
  }
  // Existing protocol terminal frames, unchanged.
});
```

- [ ] **Step 5: Add pipeline-level cancellation verification**

Extend the real adapter SSE test so cancelling `response.body` observes cancellation on the provider model stream, not only on the test adapter's `pipeThrough` stream.

- [ ] **Step 6: Verify GREEN**

Run: `rtk bun test packages/core/_test/egress packages/server/_test/pipeline.test.ts`

Expected: PASS; source `cancel()` is called once and all existing SSE snapshots remain byte-identical.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/core/src/egress packages/core/_test/egress packages/server/_test/pipeline.test.ts
rtk git commit -m "fix(core): propagate egress stream cancellation"
```

---

### Task 2: 补齐 OpenAI Responses tool-call egress

**Files:**
- Modify: `packages/core/src/egress/openai-responses.ts`
- Test: `packages/core/_test/egress/openai-responses.test.ts`
- Test: `packages/server/_test/openai-responses.test.ts`

**Interfaces:**
- Consumes: AI SDK `tool-input-start`, `tool-input-delta`, `tool-input-end` stream parts.
- Produces: official OpenAI Responses `function_call` output items and matching stream events.

- [ ] **Step 1: Write failing JSON and SSE tests**

Use one tool call (`call_1`, `get_weather`, `{"city":"Paris"}`) and assert:

```ts
expect(response.output).toContainEqual({
  type: "function_call",
  id: expect.stringMatching(/^fc_/),
  call_id: "call_1",
  name: "get_weather",
  arguments: '{"city":"Paris"}',
  status: "completed",
});
```

For SSE, assert ordered events:

```ts
expect(eventTypes).toEqual([
  "response.created",
  "response.output_item.added",
  "response.function_call_arguments.delta",
  "response.function_call_arguments.done",
  "response.output_item.done",
  "response.completed",
]);
```

Also assert every event references the same item ID and `sequence_number` is monotonic.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/egress/openai-responses.test.ts`

Expected: FAIL because tool parts are ignored and no function-call item exists.

- [ ] **Step 3: Add response-local tool state**

```ts
type ToolState = {
  readonly id: string;
  readonly callId: string;
  readonly name: string;
  arguments: string;
};

type ResponseState = {
  readonly text: string[];
  readonly reasoning: string[];
  readonly tools: Map<string, ToolState>;
  metadata: ResponseMetadata;
  usage?: ResponseUsage;
};
```

Create the item ID once at `tool-input-start` using `fc_${crypto.randomUUID()}`. Accumulate deltas by AI SDK part ID; never derive a new item ID in event constructors.

- [ ] **Step 4: Emit official JSON and SSE shapes**

Add `ResponseFunctionToolCall` to `outputItems(state)`. During streaming emit official `ResponseStreamEvent` variants for item added, argument delta/done and item done. Preserve text/reasoning output indices by deriving each index from the ordered output-item list rather than hard-coded booleans.

- [ ] **Step 5: Verify GREEN**

Run: `rtk bun test packages/core/_test/egress/openai-responses.test.ts packages/server/_test/openai-responses.test.ts`

Expected: PASS for JSON, SSE, mixed reasoning/text/tool ordering and multiple tool calls.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/core/src/egress/openai-responses.ts packages/core/_test/egress/openai-responses.test.ts packages/server/_test/openai-responses.test.ts
rtk git commit -m "fix(core): preserve responses tool calls"
```

---

### Task 3: 清洗 raw passthrough 的客户端凭证头

**Files:**
- Modify: `packages/core/src/provider/api.ts`
- Test: `packages/core/_test/provider/api.test.ts`

**Interfaces:**
- Produces private `upstreamHeaders(inbound, protocol, apiKey): Headers`.
- Invariant: client credentials never cross the provider seam; only provider configuration can create upstream credentials.

- [ ] **Step 1: Write failing protocol-matrix tests**

For every protocol, send inbound `authorization`, `proxy-authorization`, `cookie`, `x-api-key`, and `x-goog-api-key`. Assert all are absent when provider `apiKey` is absent.

With a configured key, assert only the protocol-owned header exists:

```ts
const expected = {
  [ProviderProtocol.OpenAICompatible]: ["authorization", "Bearer provider-key"],
  [ProviderProtocol.OpenAIResponse]: ["authorization", "Bearer provider-key"],
  [ProviderProtocol.Anthropic]: ["x-api-key", "provider-key"],
  [ProviderProtocol.Gemini]: ["x-goog-api-key", "provider-key"],
} as const;
```

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/provider/api.test.ts`

Expected: FAIL because inbound credentials currently survive when no provider key is configured.

- [ ] **Step 3: Implement private header ownership**

```ts
const CLIENT_CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-goog-api-key",
] as const;

function upstreamHeaders(inbound: Headers, protocol: ProviderProtocol, apiKey: string | undefined): Headers {
  const headers = new Headers(inbound);
  headers.delete("host");
  for (const name of CLIENT_CREDENTIAL_HEADERS) headers.delete(name);
  headers.set("accept-encoding", "identity");
  headers.set("x-forwarded-by", "aio-proxy/0.0.0");
  if (apiKey === undefined) return headers;
  if (protocol === ProviderProtocol.Anthropic) headers.set("x-api-key", apiKey);
  else if (protocol === ProviderProtocol.Gemini) headers.set("x-goog-api-key", apiKey);
  else headers.set("authorization", `Bearer ${apiKey}`);
  return headers;
}
```

- [ ] **Step 4: Verify GREEN**

Run: `rtk bun test packages/core/_test/provider/api.test.ts`

Expected: PASS; custom non-sensitive headers and request bytes remain unchanged.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/core/src/provider/api.ts packages/core/_test/provider/api.test.ts
rtk git commit -m "fix(core): sanitize passthrough credentials"
```

---

### Task 4: 用有界读取真正执行 8 MiB body 上限

**Files:**
- Modify: `packages/core/src/protocol/request.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/server/src/routes/pipeline.ts`
- Test: `packages/core/_test/protocol/adapter.test.ts`
- Test: `packages/server/_test/pipeline.test.ts`
- Test: `packages/server/_test/anthropic-messages.test.ts`

**Interfaces:**
- Produces: `RequestBodyTooLargeError`.
- Changes: `readJsonRequest(raw, maxBytes = 8 * 1024 * 1024)` reads incrementally and throws before retaining more than the limit.

- [ ] **Step 1: Write failing chunked/no-Content-Length tests**

Create a `Request` backed by a `ReadableStream<Uint8Array>` with no `Content-Length`, emit bytes past 8 MiB, and assert the route returns the protocol-shaped 413 without beginning request recording.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/protocol/adapter.test.ts packages/server/_test/pipeline.test.ts`

Expected: FAIL because `raw.clone().json()` reads the complete body.

- [ ] **Step 3: Implement bounded JSON reading**

```ts
export class RequestBodyTooLargeError extends Error {}

export async function readJsonRequest(raw: Request, maxBytes = 8 * 1024 * 1024): Promise<unknown> {
  const reader = raw.clone().body?.getReader();
  if (reader === undefined) return JSON.parse("");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        throw new RequestBodyTooLargeError("Request body too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
```

- [ ] **Step 4: Map the typed error at the shared pipeline seam**

Before `adapter.errors.requestError(error)`, handle:

```ts
if (error instanceof RequestBodyTooLargeError) return adapter.errors.tooLarge();
```

Keep the strict `Content-Length` check as a fast rejection; bounded reading is the authoritative limit.

- [ ] **Step 5: Verify GREEN**

Run: `rtk bun test packages/core/_test/protocol packages/server/_test/pipeline.test.ts packages/server/_test/anthropic-messages.test.ts`

Expected: PASS for oversized declared, malformed declared, chunked and absent-length bodies.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/core/src/protocol packages/core/src/index.ts packages/core/_test/protocol packages/server/src/routes/pipeline.ts packages/server/_test
rtk git commit -m "fix(server): enforce bounded request bodies"
```

---

### Task 5: 让 usage capture 按下游需求拉取

**Files:**
- Modify: `packages/server/src/usage-capture.ts`
- Test: `packages/server/_test/request-recorder.test.ts`

**Interfaces:**
- Keeps: `UsageCapture.stream(options): Captured<ReadableStream<TextStreamPart<ToolSet>>>` unchanged.
- Changes implementation from eager `start()` loop to one-read-per-`pull()`.

- [ ] **Step 1: Write the failing backpressure test**

Create a source stream that counts pulls. Construct `capture.stream(...)` without reading its returned stream and assert the source has not been drained. After each returned-reader `read()`, assert at most one additional source read occurred.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/server/_test/request-recorder.test.ts`

Expected: FAIL because current `start()` drains the source immediately.

- [ ] **Step 3: Move terminal observation into `pull()`**

Implement one `reader.read()` per pull. On `finish`, record usage before enqueueing. On done, close and resolve completion; on error, resolve failure/cancelled and error the controller. Keep the existing `cancel(reason)` implementation and reader-release guard.

- [ ] **Step 4: Verify GREEN**

Run: `rtk bun test packages/server/_test/request-recorder.test.ts packages/server/_test/pipeline.test.ts`

Expected: PASS for backpressure, finish usage, abort, error and downstream cancellation.

- [ ] **Step 5: Commit**

```bash
rtk git add packages/server/src/usage-capture.ts packages/server/_test/request-recorder.test.ts packages/server/_test/pipeline.test.ts
rtk git commit -m "fix(server): preserve model stream backpressure"
```

---

### Task 6: 强制 local-only 监听策略

**Files:**
- Modify: `packages/types/src/config.ts`
- Create: `packages/types/_test/config.test.ts`
- Test: `packages/server/_test/server.test.ts`
- Modify: `README.md`

**Interfaces:**
- Keeps `server.host` configurable only among `127.0.0.1`, `::1`, and `localhost`.
- Remote authenticated mode is explicitly outside this plan.

- [ ] **Step 1: Write failing config tests**

```ts
test.each(["0.0.0.0", "192.168.1.20", "example.test"])("rejects non-loopback host %s", (host) => {
  expect(() => ConfigSchema.parse({ server: { host }, providers: {} })).toThrow();
});

test.each(["127.0.0.1", "::1", "localhost"])("accepts loopback host %s", (host) => {
  expect(ConfigSchema.parse({ server: { host }, providers: {} }).server.host).toBe(host);
});
```

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/types/_test/config.test.ts packages/server/_test/server.test.ts`

Expected: FAIL because arbitrary host strings are currently accepted.

- [ ] **Step 3: Restrict the host schema**

```ts
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

host: z
  .string()
  .refine((host) => LOOPBACK_HOSTS.has(host), "Remote binding requires an authenticated remote-mode design")
  .default("127.0.0.1")
```

- [ ] **Step 4: Document the invariant**

State that aio-proxy currently trusts the local machine and deliberately refuses remote binding. Do not document port forwarding as supported deployment.

- [ ] **Step 5: Verify GREEN**

Run: `rtk bun test packages/types/_test/config.test.ts packages/server/_test/server.test.ts`

Expected: PASS; default host remains unchanged.

- [ ] **Step 6: Commit**

```bash
rtk git add packages/types/src/config.ts packages/types/_test/config.test.ts packages/server/_test/server.test.ts README.md
rtk git commit -m "fix(types): restrict server binding to loopback"
```

---

### Task 7: 清理已确认的低风险漂移

**Files:**
- Modify: `packages/core/src/protocol/errors.ts`
- Test: `packages/core/_test/protocol/errors.test.ts`
- Modify: `packages/server/src/server-state.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Test: `packages/server/_test/server.test.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Renames `ServerState.redactedConfig()` to `currentConfig()`; HTTP handlers remain responsible for `redactSecrets()`.
- Normalizes explicit client aborts to HTTP 499 across protocol error envelopes; timeout behavior remains 500 until separately specified.

- [ ] **Step 1: Write failing abort mapping tests**

For OpenAI, Anthropic and Gemini adapters, wrap an `AbortError` in `AiSdkProviderError` and assert status 499 with each protocol's native error envelope.

- [ ] **Step 2: Verify RED**

Run: `rtk bun test packages/core/_test/protocol/errors.test.ts`

Expected: Anthropic and Gemini return 500 while OpenAI returns 499.

- [ ] **Step 3: Separate abort detection from timeout detection**

```ts
function isAbort(error: unknown): boolean {
  const cause = error instanceof AiSdkProviderError ? error.cause : error;
  return cause instanceof Error && cause.name === "AbortError";
}
```

Use it in all provider error mappers before generic 500 mapping. Do not map `TimeoutError` to 499.

- [ ] **Step 4: Rename the misleading config interface**

Replace `redactedConfig()` with `currentConfig()` in `ServerState` and all dashboard callers. Keep `redactSecrets(state.currentConfig())` at the HTTP response seam.

- [ ] **Step 5: Correct the weight documentation**

Replace the AGENTS statement that weights do not exist with:

```md
3. Resolve candidates by descending configured `weight`; equal or absent weights preserve config order.
```

- [ ] **Step 6: Verify GREEN**

Run: `rtk bun test packages/core/_test/protocol/errors.test.ts packages/server/_test/server.test.ts`

Expected: PASS; dashboard config responses remain redacted and weighted routing documentation matches `ConfigSchema`.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/core/src/protocol/errors.ts packages/core/_test/protocol/errors.test.ts packages/server/src packages/server/_test/server.test.ts AGENTS.md
rtk git commit -m "fix: align protocol errors and architecture docs"
```

---

### Task 8: Final compatibility verification

**Files:**
- Modify only if verification exposes a regression.

- [ ] **Step 1: Run unit suites**

Run:

```bash
rtk bun run --filter @aio-proxy/core test:unit
rtk env AIO_PROXY_HOME=/tmp/aio-proxy-architecture-remediation bun run --filter @aio-proxy/server test:unit
```

Expected: zero failures.

- [ ] **Step 2: Run static checks and builds**

Run:

```bash
rtk bun run check
rtk bun run build
```

Expected: both exit 0; only pre-existing diagnostics are permitted.

- [ ] **Step 3: Inspect scope**

Run:

```bash
rtk git diff --check
rtk git status --short
```

Expected: no whitespace errors and no unrelated changes.

## Deferred by Design

- Authenticated remote mode: requires a separate product/security design covering API clients, Dashboard browser session, secret rotation and upgrade compatibility.
- Passthrough usage for payloads beyond the observation cap: requires request-log schema semantics for `usageUnavailableReason`; do not silently invent zero usage.
- Dashboard-wide coverage targets and all `*-from-model` round trips: handle as a dedicated testing plan, not mixed with production correctness fixes.
- Unknown variant rejection: keep current fallback semantics until compatibility expectations are specified.
