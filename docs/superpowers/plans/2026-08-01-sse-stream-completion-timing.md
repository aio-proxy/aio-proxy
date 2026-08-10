# SSE 流完成检测与 trace 计时修正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让流式请求的 trace 完成时刻精确到"终止帧到达"而非"上游 socket 关闭",并加 idle 超时兜底,消除"永远运行中"与时间放大。

**Architecture:** 两层,独立生效。第 2 层:SSE observer / AI SDK 流检测到终止帧即提前 resolve completion(不断流,剩余字节继续透传);第 1 层:两条流消费路径各加 idle 计时器,超时 resolve failure 并 cancel 上游。改动落在 `passthrough-usage.ts`、`passthrough-capture.ts`、`stream-capture.ts`,不改 `ended_at` 写入、`complete()`、trace schema、dashboard。

**Tech Stack:** TypeScript,Bun test,`bun:test`,ReadableStream,eventsource-parser。

## Global Constraints

- 运行目录:worktree `/Users/bytedance/Documents/self/aio-proxy/.worktrees/sse-stream-completion`,分支 `fix/sse-stream-completion-timing`。
- 测试命令一律在 `packages/server` 目录下用 `bun run test:unit <path>`(等价 `bun test --preload=./__tests__/setup.ts <path>`)。直接 `bun test` 会因 workspace 解析失败。
- 手写非测试实现文件 300 行硬上限;240 行需评估拆分。测试文件无行数上限。
- colocated 测试:新测试与源文件同名目录同级;本包 `test:unit` 已扫描 `src/**/*.test.ts`,现有 `usage-capture/*.test.ts` 是平铺布局,沿用平铺(与既有同目录测试一致,勿单独重构布局)。
- `UsageCompletion` 判别联合类型(`shared.ts:8-11`):`success` 带可选 `usage`/`statusCode`/`ttftMs`;`failure` 带可选 `statusCode`/`errorCode`/`ttftMs`;`cancelled` 带可选 `statusCode`/`ttftMs`。
- `deferred<T>()`(`shared.ts:68-83`)内部 `settled` 卫兵已保证 `resolve` 幂等。
- idle 阈值默认 `STREAM_IDLE_TIMEOUT_MS = 300_000`(文字端点),经 options 注入以便测试用小值 + 未来图片端点放大。
- 协议枚举 `ProviderProtocol`:`OpenAIResponse | OpenAICompatible | Anthropic | Gemini`。
- 客户端可见字节流不变(不断流);usage/token/路由/转换/egress 不变。行为变化仅两点:(a) idle 超时主动 `reader.cancel()`;(b) 并发槽 `release` 与 responseId 提交在终止帧时刻(而非 EOF)触发——这是本设计的目的,非 bug。

---

### Task 1: observer 终止帧检测 + `onTerminal` 回调

**Files:**
- Modify: `packages/server/src/passthrough-usage/passthrough-usage.ts`
- Test: `packages/server/src/passthrough-usage/passthrough-usage.terminal.test.ts`(Create)

**Interfaces:**
- Consumes: 现有 `isRecord`、`assertNever`(来自 `./shared`),`protocolFailure`、`PassthroughObservation`、`observation()` helper。
- Produces:
  - `PassthroughSseCallbacks` 新增可选字段 `readonly onTerminal?: (observation: PassthroughObservation) => void;`
  - 新增内部函数 `isSuccessTerminal(protocol: ProviderProtocol, eventType: string | undefined, value: unknown): boolean`。
  - observer 在 `onEvent` 内检测到终止帧(成功或失败)时,以当前 `observation(observed, responseId, failed)` 调用 `onTerminal`。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/passthrough-usage/passthrough-usage.terminal.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createPassthroughSseUsageObserver, type PassthroughObservation } from './passthrough-usage';

function collectTerminal(protocol: ProviderProtocol, frames: string): PassthroughObservation[] {
  const seen: PassthroughObservation[] = [];
  const observer = createPassthroughSseUsageObserver(protocol, { onTerminal: (obs) => seen.push(obs) });
  observer.feed(frames);
  return seen;
}

describe('observer onTerminal detection', () => {
  test('OpenAIResponse response.completed fires success terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAIResponse,
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","id":"resp_1","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
    expect(seen[0]?.responseId).toBe('resp_1');
  });

  test('Anthropic message_stop fires success terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.Anthropic,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
  });

  test('OpenAICompatible finish_reason fires success terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAICompatible,
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
  });

  test('Gemini finishReason fires success terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.Gemini,
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}]}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBeUndefined();
  });

  test('OpenAIResponse response.failed fires failure terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAIResponse,
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.failed).toBe(true);
  });

  test('content delta does not fire terminal', () => {
    const seen = collectTerminal(
      ProviderProtocol.OpenAIResponse,
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    );
    expect(seen).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && bun run test:unit src/passthrough-usage/passthrough-usage.terminal.test.ts`
Expected: FAIL(`onTerminal` 未触发,`seen` 为空)。

- [ ] **Step 3: 实现**

在 `passthrough-usage.ts` 的 `PassthroughSseCallbacks`(当前 `:35-38`)增加字段:

```ts
export type PassthroughSseCallbacks = {
  readonly onEvent?: () => void;
  readonly onContent?: () => void;
  readonly onTerminal?: (observation: PassthroughObservation) => void;
};
```

在 `protocolFailure`(当前 `:177-196`)之后新增(注意 `import` 里已有 `isRecord`;需补 `assertNever` 到 `./shared` 的 import 行):

```ts
function isSuccessTerminal(protocol: ProviderProtocol, eventType: string | undefined, value: unknown): boolean {
  switch (protocol) {
    case ProviderProtocol.OpenAIResponse: {
      const type = eventType ?? (isRecord(value) ? value['type'] : undefined);
      if (type === 'response.completed' || type === 'response.done') return true;
      const response = isRecord(value) && isRecord(value['response']) ? value['response'] : value;
      return isRecord(response) && response['status'] === 'completed';
    }
    case ProviderProtocol.Anthropic: {
      const type = eventType ?? (isRecord(value) ? value['type'] : undefined);
      return type === 'message_stop';
    }
    case ProviderProtocol.OpenAICompatible: {
      if (!isRecord(value) || !Array.isArray(value['choices'])) return false;
      return value['choices'].some((choice) => isRecord(choice) && typeof choice['finish_reason'] === 'string');
    }
    case ProviderProtocol.Gemini: {
      const entries = Array.isArray(value) ? value : [value];
      return entries.some(
        (entry) =>
          isRecord(entry) &&
          Array.isArray(entry['candidates']) &&
          entry['candidates'].some(
            (candidate) =>
              isRecord(candidate) && typeof candidate['finishReason'] === 'string' && candidate['finishReason'] !== '',
          ),
      );
    }
    default:
      return assertNever(protocol);
  }
}
```

修改 `createPassthroughSseUsageObserver` 的 `onEvent`(当前 `:106-124`)为:

```ts
    onEvent(event) {
      safely(callbacks.onEvent);
      const failEvent = protocolFailure(protocol, event.event, undefined);
      failed ||= failEvent;
      if (!active || event.data.length > MAX_SSE_BUFFER_CHARS) {
        active = false;
        if (failEvent) safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed)));
        return;
      }
      const parsed = parseJson(event.data);
      const failParsed = protocolFailure(protocol, undefined, parsed);
      failed ||= failParsed;
      if (parsed === undefined) {
        if (failEvent || failParsed) safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed)));
        return;
      }
      observed = mergeObservedUsage(protocol, observed, usageFromJson(protocol, parsed));
      responseId = completedResponseId(protocol, parsed) ?? responseId;
      if (hasContentDelta(protocol, event.event, parsed)) {
        sawContent = true;
        safely(callbacks.onContent);
      }
      if (failEvent || failParsed || isSuccessTerminal(protocol, event.event, parsed)) {
        safely(() => callbacks.onTerminal?.(observation(observed, responseId, failed)));
      }
    },
```

补 import(当前 `:3` 行):`import { hasContentDelta } from './content';` 不变;将 `./shared` 的 import 行加入 `assertNever`——确认现有行是否已含。若未含,改为包含 `assertNever` 的具名导入。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/server && bun run test:unit src/passthrough-usage/passthrough-usage.terminal.test.ts`
Expected: PASS(6 tests)。

- [ ] **Step 5: 回归 observer 相邻测试**

Run: `cd packages/server && bun run test:unit src/passthrough-usage`
Expected: 全绿(含既有 `passthrough-usage.test.ts`、`usage.test.ts`)。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/passthrough-usage/passthrough-usage.ts packages/server/src/passthrough-usage/passthrough-usage.terminal.test.ts
git commit -m "feat(passthrough): detect SSE terminal frames and fire onTerminal"
```

---

### Task 2: passthrough-capture 终止帧提前 resolve(不断流)

**Files:**
- Modify: `packages/server/src/usage-capture/passthrough-capture.ts`
- Test: `packages/server/src/usage-capture/usage-capture.passthrough.terminal.test.ts`(Create)

**Interfaces:**
- Consumes: Task 1 的 `onTerminal(observation)` 回调、`PassthroughObservation`。
- Produces: `passthroughCapture` 在收到 `onTerminal` 时通过统一的 `complete(observation)` 提前 resolve;`complete` 由 `completed` 卫兵保证只执行一次(finalize + onResponseId + resolve),EOF 路径复用同一 `complete`。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/usage-capture/usage-capture.passthrough.terminal.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

// 终止帧后附带一段"延迟才关闭"的尾部:断言 completion 在终止帧即 resolve,
// 且尾部字节仍完整透传给客户端(不断流)。
function framedStream(frames: readonly string[], tail: () => Promise<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  let tailSent = false;
  return new ReadableStream({
    async pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(frames[index]!));
        index += 1;
        return;
      }
      if (!tailSent) {
        tailSent = true;
        controller.enqueue(encoder.encode(await tail()));
        return;
      }
      controller.close();
    },
  });
}

describe('passthrough terminal early completion', () => {
  test('resolves at response.completed while trailing bytes still stream', async () => {
    let releaseTail: (() => void) | undefined;
    const tailGate = new Promise<void>((r) => (releaseTail = r));
    const completedFrame =
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","id":"resp_1","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n';
    const captured = createUsageCapture().passthrough({
      response: new Response(
        framedStream([completedFrame], async () => {
          await tailGate;
          return 'data: [DONE]\n\n';
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
    });

    // completion resolves from the terminal frame, before the gated tail is released.
    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    expect('usage' in completion ? completion.usage : undefined).toMatchObject({ inputTokens: 2, outputTokens: 3 });

    // client still receives the full byte stream, including the gated tail.
    releaseTail?.();
    expect(await captured.value.text()).toBe(completedFrame + 'data: [DONE]\n\n');
  });

  test('resolves failure at response.failed terminal', async () => {
    const failedFrame = 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n';
    const captured = createUsageCapture().passthrough({
      response: new Response(failedFrame, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
    });
    await expect(captured.completion).resolves.toEqual({ outcome: 'failure', statusCode: 200 });
    expect(await captured.value.text()).toBe(failedFrame);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.passthrough.terminal.test.ts`
Expected: FAIL(第一例会挂起/超时,因为 completion 目前只在 EOF 才 resolve,而 EOF 被 `tailGate` 阻塞)。

- [ ] **Step 3: 实现 — 提取 `complete()` 并接线 `onTerminal`**

在 `passthrough-capture.ts`,把 EOF 分支(当前 `:82-110` 的成功/失败判定 + finalize + resolve)重构为统一 `complete(observation)`,并在 `createSseUsageObserver` 传入 `onTerminal`。

3a. 修改 observer 构造(当前 `:46-48`)为携带 `onTerminal`:

```ts
  const sseObserver = isSse
    ? createSseUsageObserver(protocol, observation, {
        onContent: (contentAt) => (firstTokenAt ??= contentAt),
        onTerminal: (obs) => void complete(obs),
      })
    : undefined;
```

3b. 在 `reader`/`released` 声明之后、`returnedBody` 之前,新增 `completed` 卫兵与 `complete`:

```ts
  let completed = false;
  const complete = async (obs: PassthroughObservation): Promise<void> => {
    if (completed) return;
    completed = true;
    if (obs.failed === true) {
      terminal.resolve({ outcome: 'failure', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
      return;
    }
    const usage = await finalizeUsage({
      usage:
        obs.usage === undefined && obs.issues === undefined ? undefined : { ...obs.usage, providerId, modelId },
      accounting: { source: 'passthrough', protocol },
      ...(requestedModelId === undefined ? {} : { requestedModelId }),
      ...(logger === undefined ? {} : { logger }),
      ...(obs.issues === undefined ? {} : { issues: obs.issues }),
    });
    if (obs.responseId !== undefined) onResponseId?.(obs.responseId);
    terminal.resolve({
      outcome: 'success',
      statusCode,
      ...usageProperty(usage),
      ...ttftProperty(startedAt, firstTokenAt),
    });
  };
```

3c. 把 EOF 分支(当前 `:82-110`)替换为构建 observation 后调用 `complete`:

```ts
        done = true;
        controller.close();
        const finalObservation =
          sseObserver !== undefined && decoder !== undefined
            ? finishSseObservation(sseObserver, decoder)
            : captureJson
              ? extractPassthroughObservation(protocol, decodeChunks(chunks, byteLength))
              : {};
        await complete(finalObservation);
```

> 注意:`complete` 内 `obs.usage` 分支须与原 EOF 逻辑一致——原逻辑 `observation.usage === undefined && observation.issues === undefined ? undefined : {...}`。已在 3b 保留。

- [ ] **Step 4: 调整 `createSseUsageObserver` 签名以传 `onTerminal`**

`passthrough-capture.ts` 现有 `createSseUsageObserver(protocol, observation, onContent)`(当前 `:148-158`)第三参是 `onContent` 回调函数。改为接收一个 callbacks 对象,内部转接到 observer 的 `onContent`/`onTerminal`。读取当前实现后按其形态改造:第三参变为 `{ onContent, onTerminal }`,在内部构造 `createPassthroughSseUsageObserver(protocol, { onContent: () => ..., onTerminal })`。`onContent` 里对 firstTokenAt 的赋值逻辑保持不变(通过 `observeContentAt(observation)`)。

Run to inspect exact current shape first:
`cd packages/server && bun run test:unit src/usage-capture/usage-capture.passthrough.test.ts`(先确认改造前该测试基线绿)。

- [ ] **Step 5: 运行新测试确认通过**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.passthrough.terminal.test.ts`
Expected: PASS(2 tests)。

- [ ] **Step 6: 回归整个 usage-capture**

Run: `cd packages/server && bun run test:unit src/usage-capture`
Expected: 全绿。特别确认 `usage-capture.passthrough.completion.test.ts` 的失败态用例仍 resolve `failure`(时间提前但值不变)。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/usage-capture/passthrough-capture.ts packages/server/src/usage-capture/usage-capture.passthrough.terminal.test.ts
git commit -m "feat(passthrough): resolve completion at terminal frame without ending the stream"
```

---

### Task 3: passthrough-capture idle 超时

**Files:**
- Modify: `packages/server/src/usage-capture/shared.ts`(加常量 + options 字段)
- Modify: `packages/server/src/usage-capture/passthrough-capture.ts`
- Test: `packages/server/src/usage-capture/usage-capture.passthrough.idle.test.ts`(Create)

**Interfaces:**
- Produces:
  - `shared.ts` 新增 `export const STREAM_IDLE_TIMEOUT_MS = 300_000;`
  - `PassthroughUsageOptions` 与 `StreamUsageOptions` 各新增 `readonly idleTimeoutMs?: number;`
  - `passthroughCapture` 每次成功 `reader.read()` 后重置 idle 计时器;超时 → `terminal.resolve({ outcome: 'failure', statusCode, errorCode: 'stream_idle_timeout' })` + `reader.cancel()`,并置 `completed`。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/usage-capture/usage-capture.passthrough.idle.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

describe('passthrough idle timeout', () => {
  test('stalled stream resolves failure with stream_idle_timeout and cancels upstream', async () => {
    let cancelled = false;
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n'),
        );
      },
      pull() {
        return new Promise<void>(() => {}); // never resolves — simulates a hung-open upstream
      },
      cancel() {
        cancelled = true;
      },
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(stalling, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
      idleTimeoutMs: 40,
    });

    // consume the first delivered chunk, then stop reading — upstream hangs.
    const reader = captured.value.body!.getReader();
    await reader.read();

    await expect(captured.completion).resolves.toEqual({
      outcome: 'failure',
      statusCode: 200,
      errorCode: 'stream_idle_timeout',
    });
    expect(cancelled).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.passthrough.idle.test.ts`
Expected: FAIL(测试超时,completion 永不 resolve;无 idle 逻辑)。

- [ ] **Step 3: 实现 — 常量 + options 字段**

在 `shared.ts` 顶部常量区(`MAX_PASSTHROUGH_JSON_BYTES` 附近,当前 `:6`)新增:

```ts
export const STREAM_IDLE_TIMEOUT_MS = 300_000;
```

`PassthroughUsageOptions`(当前 `:31-41`)与 `StreamUsageOptions`(当前 `:18-29`)各加一行:

```ts
  // Upstream idle timeout in ms; when the stream produces no bytes for this
  // long, completion resolves failure and the upstream is cancelled. Defaults
  // to STREAM_IDLE_TIMEOUT_MS; image endpoints should pass a larger value.
  readonly idleTimeoutMs?: number;
```

- [ ] **Step 4: 实现 — passthrough-capture idle 计时器**

在 `passthrough-capture.ts` 解构参数加入 `idleTimeoutMs`(当前 `:22-31`),并 import 常量:

```ts
import {
  type Captured,
  deferred,
  MAX_PASSTHROUGH_JSON_BYTES,
  observeContentAt,
  type PassthroughUsageOptions,
  STREAM_IDLE_TIMEOUT_MS,
  ttftProperty,
  type UsageCompletion,
  usageProperty,
} from './shared';
```

在 `complete`/`releaseReader` 附近新增 idle 计时器,并在 `complete` 内 `clearIdle()`:

```ts
  const idleMs = idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = (): void => {
    clearIdle();
    if (idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      if (completed) return;
      completed = true;
      terminal.resolve({
        outcome: 'failure',
        statusCode,
        errorCode: 'stream_idle_timeout',
        ...ttftProperty(startedAt, firstTokenAt),
      });
      void reader.cancel(new Error('stream_idle_timeout')).catch(() => {});
      releaseReader();
    }, idleMs);
  };
```

在 `complete` 开头(设置 `completed = true` 之后)加 `clearIdle();`。

`armIdle()` 首次调用:在 `getReader()` 之后、返回 `returnedBody` 之前调用一次。
在 `pull` 内每次成功读到 chunk 后重置:即 `if (!next.done) { ...; controller.enqueue(next.value); armIdle(); return; }`——在 `controller.enqueue(next.value)` 之后、`return` 之前插入 `armIdle();`。
在 `cancel(reason)` 分支(当前 `:123-130`)开头加 `clearIdle();`。

- [ ] **Step 5: 运行新测试确认通过**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.passthrough.idle.test.ts`
Expected: PASS(1 test)。

- [ ] **Step 6: 回归 usage-capture 全量**

Run: `cd packages/server && bun run test:unit src/usage-capture`
Expected: 全绿(现有测试无 `idleTimeoutMs`,走 300s 默认,不受影响;正常流在 EOF/终止帧早已完成)。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/usage-capture/shared.ts packages/server/src/usage-capture/passthrough-capture.ts packages/server/src/usage-capture/usage-capture.passthrough.idle.test.ts
git commit -m "feat(passthrough): add upstream idle timeout with configurable threshold"
```

---

### Task 4: stream-capture(AI SDK)finish part 提前 resolve

**Files:**
- Modify: `packages/server/src/usage-capture/stream-capture.ts`
- Test: `packages/server/src/usage-capture/usage-capture.stream.terminal.test.ts`(Create)

**Interfaces:**
- Consumes: 现有 `finished`/`finishUsage`/`normalizeAiSdkUsage`、`finalizeUsage`、`deferred`。
- Produces: `streamCapture` 在读到 `type === 'finish'` part 时,记录后经统一 `complete()` 提前 resolve success(带 usage),不等 `next.done`;`abort` part 仍走 cancelled;剩余 part 继续 enqueue。`completed` 卫兵保证只 resolve 一次。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/usage-capture/usage-capture.stream.terminal.test.ts`:

```ts
import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import { describe, expect, test } from 'bun:test';

import { createUsageCapture } from './index';

function partsStream(parts: readonly TextStreamPart<ToolSet>[], gate: Promise<void>): ReadableStream<TextStreamPart<ToolSet>> {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < parts.length) {
        // Gate everything AFTER the finish part so the terminal-resolve path is
        // exercised while the stream is still open.
        const part = parts[index]!;
        if (index > 0) await gate;
        controller.enqueue(part);
        index += 1;
        return;
      }
      controller.close();
    },
  });
}

const finishPart: TextStreamPart<ToolSet> = {
  type: 'finish',
  finishReason: 'stop',
  rawFinishReason: 'stop',
  totalUsage: {
    inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 4 },
    inputTokens: 4,
    outputTokens: 2,
    totalTokens: 6,
    reasoningTokens: undefined,
    cachedInputTokens: undefined,
  },
} as unknown as TextStreamPart<ToolSet>;

const trailingPart = { type: 'text-delta', id: 'text-1', text: 'trailing' } as TextStreamPart<ToolSet>;

describe('stream capture terminal early completion', () => {
  test('resolves success at finish part before the trailing part is released', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: partsStream([finishPart, trailingPart], gate),
    });

    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');

    // trailing part still reaches the consumer.
    release?.();
    const reader = captured.value.getReader();
    const collected: TextStreamPart<ToolSet>[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      collected.push(next.value);
    }
    expect(collected.map((p) => p.type)).toEqual(['finish', 'text-delta']);
  });
});
```

> 注:`finishPart` 的 usage 形状以现有 `packages/server/src/usage-capture/test-support.ts` 的 `finishPart()` 为准——实现前先读 `test-support.ts`,直接复用其导出的 `finishPart` 工厂而非硬编码,避免字段漂移。若已导出,则 import 复用:`import { finishPart } from './test-support';`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.stream.terminal.test.ts`
Expected: FAIL(completion 挂起,因当前只在 `next.done` resolve,而 trailing part 的 gate 阻塞了 EOF)。

- [ ] **Step 3: 实现 — 提取 `complete()` 并在 finish part 触发**

在 `stream-capture.ts`,把 EOF 成功分支(当前 `:44-61`)的 finalize+resolve 提成 `complete()`,加 `completed` 卫兵,并在读到 `finish` part 时调用。

3a. 在 `released`/`releaseReader` 之后新增:

```ts
  let completed = false;
  const complete = async (): Promise<void> => {
    if (completed) return;
    completed = true;
    terminal.resolve({
      outcome: 'success',
      ...usageProperty(
        await finalizeUsage({
          usage: finishUsage,
          accounting: { source: 'ai-sdk' },
          ...(requestedModelId === undefined ? {} : { requestedModelId }),
          ...(logger === undefined ? {} : { logger }),
        }),
      ),
      ...ttftProperty(startedAt, firstTokenAt),
    });
  };
```

3b. `finish` part 分支(当前 `:64-66`)改为记录后立即 complete:

```ts
        if (next.value.type === 'finish') {
          finished = true;
          finishUsage = normalizeAiSdkUsage(next.value, providerId, modelId);
          controller.enqueue(next.value);
          void complete();
          return;
        }
```

> 注意:此处提前 `enqueue` 并 `return`,故下方通用 `controller.enqueue(next.value)` 不再对 finish part 执行。abort/delta 分支保持走到末尾的 `controller.enqueue`。

3c. EOF 分支(当前 `:40-62`)的成功子句改为复用 `complete()`;cancelled/failure 子句保持:

```ts
        if (next.done) {
          releaseReader();
          if (cancelled) return;
          controller.close();
          if (aborted) {
            terminal.resolve({ outcome: 'cancelled', ...ttftProperty(startedAt, firstTokenAt) });
          } else if (finished) {
            await complete();
          } else {
            terminal.resolve({ outcome: 'failure', ...ttftProperty(startedAt, firstTokenAt) });
          }
          return;
        }
```

- [ ] **Step 4: 运行新测试确认通过**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.stream.terminal.test.ts`
Expected: PASS(1 test)。

- [ ] **Step 5: 回归 stream 相关测试**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.stream.lifecycle.test.ts src/usage-capture/usage-capture.stream.test.ts src/usage-capture/usage-capture.pricing.test.ts`
Expected: 全绿(finish part 提前 resolve 与 EOF resolve 的 value 一致)。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/usage-capture/stream-capture.ts packages/server/src/usage-capture/usage-capture.stream.terminal.test.ts
git commit -m "feat(stream): resolve completion at AI SDK finish part without ending the stream"
```

---

### Task 5: stream-capture idle 超时

**Files:**
- Modify: `packages/server/src/usage-capture/stream-capture.ts`
- Test: `packages/server/src/usage-capture/usage-capture.stream.idle.test.ts`(Create)

**Interfaces:**
- Consumes: Task 3 的 `STREAM_IDLE_TIMEOUT_MS`、`StreamUsageOptions.idleTimeoutMs`、Task 4 的 `completed` 卫兵。
- Produces: `streamCapture` 每次成功读 part 后重置 idle 计时器;超时 → `terminal.resolve({ outcome: 'failure', errorCode: 'stream_idle_timeout' })` + `reader.cancel()`。

- [ ] **Step 1: 写失败测试**

Create `packages/server/src/usage-capture/usage-capture.stream.idle.test.ts`:

```ts
import { type TextStreamPart, type ToolSet } from '@aio-proxy/core';
import { describe, expect, test } from 'bun:test';

import { createUsageCapture } from './index';

describe('stream capture idle timeout', () => {
  test('stalled AI SDK stream resolves failure with stream_idle_timeout and cancels upstream', async () => {
    let cancelled = false;
    const stalling = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hi' } as TextStreamPart<ToolSet>);
      },
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: stalling,
      idleTimeoutMs: 40,
    });

    const reader = captured.value.getReader();
    await reader.read();

    await expect(captured.completion).resolves.toEqual({ outcome: 'failure', errorCode: 'stream_idle_timeout' });
    expect(cancelled).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.stream.idle.test.ts`
Expected: FAIL(超时,无 idle 逻辑)。

- [ ] **Step 3: 实现**

在 `stream-capture.ts` 解构参数加入 `idleTimeoutMs`(当前 `:19`),import `STREAM_IDLE_TIMEOUT_MS`(加入 `./shared` 具名导入)。新增计时器(与 Task 3 同构):

```ts
  const idleMs = idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const armIdle = (): void => {
    clearIdle();
    if (idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      if (completed) return;
      completed = true;
      terminal.resolve({ outcome: 'failure', errorCode: 'stream_idle_timeout', ...ttftProperty(startedAt, firstTokenAt) });
      void reader.cancel(new Error('stream_idle_timeout')).catch(() => {});
      releaseReader();
    }, idleMs);
  };
```

- 在 `complete` 开头(`completed = true` 之后)加 `clearIdle();`。
- 首次 `armIdle()`:`getReader()` 之后、返回 `value` 之前。
- 每次成功读 part 后重置:在通用 `controller.enqueue(next.value)`(末尾)之后加 `armIdle();`;finish 分支提前 return 前也加 `armIdle();`(finish 之后仍可能有 trailing part)。
- `cancel(reason)` 分支开头加 `clearIdle();`。
- catch 分支(当前 `:74-84`)开头加 `clearIdle();`。

- [ ] **Step 4: 运行新测试确认通过**

Run: `cd packages/server && bun run test:unit src/usage-capture/usage-capture.stream.idle.test.ts`
Expected: PASS(1 test)。

- [ ] **Step 5: 回归 usage-capture 全量**

Run: `cd packages/server && bun run test:unit src/usage-capture`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/usage-capture/stream-capture.ts packages/server/src/usage-capture/usage-capture.stream.idle.test.ts
git commit -m "feat(stream): add upstream idle timeout for AI SDK path"
```

---

### Task 6: 全量校验

**Files:** 无新增。

- [ ] **Step 1: server 包单测全量**

Run: `cd packages/server && bun run test:unit`
Expected: 全绿。

- [ ] **Step 2: lint + fmt(仅本次改动文件)**

Run: `cd /Users/bytedance/Documents/self/aio-proxy/.worktrees/sse-stream-completion && bun run check`
Expected: oxlint + oxfmt 通过。若 fmt 有差异,运行 `bun run format` 后重跑并纳入提交。

- [ ] **Step 3: 冒烟 — 复现原始场景的单测已覆盖**

确认 `usage-capture.passthrough.terminal.test.ts` 的 `response.completed` 用例即 `108e6571` 场景的最小复现(终止帧后连接延迟关闭 → completion 提前 resolve)。无需额外脚本。

- [ ] **Step 4: 若 fmt/lint 产生改动则提交**

```bash
git add -A && git commit -m "chore: lint and format for SSE completion changes"
```

---

## Self-Review

**1. Spec coverage:**
- 第 1 层 idle(协议无关,两路径):Task 3(passthrough)+ Task 5(stream)。✓
- 第 2 层终止帧(4 协议 passthrough):Task 1(检测)+ Task 2(提前 resolve)。✓
- 第 2 层 AI SDK finish part:Task 4。✓
- 终止帧失败态归 failure:Task 1(`onTerminal` 传 `failed` observation)+ Task 2(`complete` 处理 `failed`)。✓
- idle 阈值 300s 常量 + 可注入 + 图片端点放大预留:Task 3(`STREAM_IDLE_TIMEOUT_MS` + `idleTimeoutMs` option)。✓
- 不断流、不改 ended_at/schema/dashboard:Task 2/4 均保留 enqueue 到 EOF;无 trace 层改动。✓
- 幂等:`completed` 卫兵(Task 2/4)+ `deferred.settled`。✓

**2. Placeholder scan:** 每个 code step 均含完整代码;无 TBD/TODO/“类似 Task N”。Task 2 Step 4 与 Task 4 Step 1 各要求"实现前先读现有形态"——这是精确接线要求,非占位(现有 `createSseUsageObserver` 第三参形态、`test-support.finishPart` 导出需现读确认,避免签名漂移)。

**3. Type consistency:**
- `onTerminal: (observation: PassthroughObservation) => void` — Task 1 定义,Task 2 消费。✓
- `complete(obs)` (passthrough) vs `complete()` (stream) — 命名同为 `complete` 但签名不同,分属两个文件,无跨文件冲突。✓
- `STREAM_IDLE_TIMEOUT_MS` / `idleTimeoutMs` — Task 3 定义于 shared.ts,Task 3/5 消费。✓
- `errorCode: 'stream_idle_timeout'` — Task 3/5 一致。✓
- `completed` 卫兵 — Task 2 引入(passthrough),Task 4 引入(stream),各自文件内一致;Task 3/5 的 idle 复用同一 `completed`。✓
