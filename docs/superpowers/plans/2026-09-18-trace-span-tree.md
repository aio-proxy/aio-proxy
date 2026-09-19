# Trace Span 树重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把每条请求的 trace 从「root + 若干平铺 attempt」两层结构，改成对齐 OTel 语义约定的多级 span 树，并让 dashboard 瀑布图能渲染它。

**Architecture:** 服务端在现有 `startPipelineSpan` / `BufferingSpanProcessor` 机制上新增 7 种 span，用显式 `Context` 传递父子关系（不依赖 ambient OTel context）；所有子 span 必须在 root `end()` 之前关闭，否则 `processor.take()` 会把它们丢掉。属性从 root 下沉到新的 GenAI CLIENT span，读路径投影 `mergeAttributes` 同步停止重建。dashboard 侧 `trace-layout.ts` 已经是深度无关的，主要改动是 TTFT 刻度与 `ambiguous` 说明。

**Tech Stack:** TypeScript / Bun / `@opentelemetry/api@1.9.1` / `@opentelemetry/sdk-trace-node@2.10.0` / Drizzle + SQLite（core trace-store）/ React + rstest（dashboard）。

**Spec:** `docs/superpowers/specs/2026-09-18-trace-timeline-design.md`。本计划中每一处「规范要求」都指向该 spec，冲突时以 spec 为准。

## Global Constraints

- 服务端测试：`cd packages/server && bun test <path>`（runner 是 bare `bun test`，没有 `_test/` 限定）。core 同理：`cd packages/core && bun test <path>`。
- dashboard 测试：`cd packages/dashboard && bun run test:unit <path>`（runner 是 **rstest**，不是 vitest、不是 `bun test`）。
- 收尾必须跑 `bun run preflight`（oxlint + oxfmt check + 全部单测）。
- 新增/修改的非测试实现文件 500 行硬上限，400 行就要评估拆分。测试文件无硬上限。
- 测试与源码同目录，`foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts` 三件套；`index.ts` 只放 export。
- **历史数据不迁移、不做兼容。** 旧 trace（2 行、无新 span）继续按单色柱渲染即可。
- **attempt span 上禁止出现 `gen_ai.request.model`、`gen_ai.response.model`、`llm.model_name`、裸 `model`。** 命中任一个，Langfuse Priority 10 兜底会把它判成 GENERATION。provider / model 一律走 `aio_proxy.attempt.*`。
- `gen_ai.response.time_to_first_chunk` 的字符串字面量直接写在 `semantic.ts` 里，**不要** import `@opentelemetry/semantic-conventions` 的 `ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK`（已标 deprecated，lint 会报）。
- 两个 TTFT 是**不同的量**，不是同一个数存两份：
  - `gen_ai.response.time_to_first_chunk` — GenAI span，**秒**（double），起点是 GenAI span 起点，**含**失败转移耗时，失败时**不写**。
  - `aio_proxy.attempt.ttft_ms` — 每个 attempt span，**毫秒**，起点是该 attempt span 起点，不含转移耗时，失败时**写**。
- 六种能力的 span 名一律 `{operation} {model}`；`gen_ai.operation.name` **只在** `language` → `chat`、`embedding` → `embeddings` 时写，image / speech / transcription / video **不写**。`aio_proxy.capability` 始终写。
- **结算所有权硬约束**：`request-trace-recorder.ts:142-143` 是 `root.end()` 紧接 `processor.take(traceId)`，`take` 把 buffer 抽干删除，此后任何子 span 的 `onEnd` 都被静默丢弃；`Span.js:80-82` 也会拒绝对已结束 span 写属性。所以**不能把 span 包在自己结算 root 的函数外面**。
- **不回填 `startTime`。** 任何 `tracer.startSpan(name, { startTime })` 都是错的：一旦传了 `startTime`，`span.end()` 不带时间戳会走 `Date.now()` 分支，起点是单调时钟、终点是墙钟，时钟校正直接算进 duration。顺序问题用重排顺序解决。
- changeset 必须同时带上产品包 `aio-proxy` 和内部包（`@aio-proxy/core` / `server` 视改动而定），bump 级别一致；正文一段、≤5 行、不带区域前缀。

## File Structure

**服务端（`packages/server/src/`）**

| 文件 | 责任 |
|---|---|
| `request-tracing/semantic.ts` → `request-tracing/semantic/` | 现有：span 名 / 属性名 / `ALLOWED_ATTRIBUTES` 常量。任务 3、5、7、9、10 逐步增删常量；任务 11 `git mv` 成 `semantic/semantic.ts` + `semantic/index.ts`，新增 `spanRegistry` 与 `semantic/semantic.test.ts`。 |
| `request-tracing/request-trace-recorder/completion.ts` | 现有：root 终态整形。任务 1 改 4xx 状态，任务 8 删掉 root 上的 `gen_ai.*`。 |
| `request-tracing/request-trace-recorder/types.ts` | 现有：`RequestTraceUsage`。任务 9 加 response id / model 字段。 |
| `response-observation/response-observation.ts` | 现有：`AttemptResponseObservation`。任务 2 新增首内容观测入口与 snapshot 字段。 |
| `usage-capture/shared.ts` | 现有：用量归一。任务 9 带出 response id / model。 |
| `request-logging/wire/wire.ts` | 现有：`createObservedFetch`。任务 7 在这里开上游 `POST` CLIENT span。 |
| `routes/pipeline/index.ts` | 现有：parse / session / route 插桩点与候选调用。任务 3 加三个请求级 span，任务 5 在 `routeSpan.end()` 之后开 GenAI span。 |
| `routes/pipeline/inference-span.ts` | **新建（任务 5）**：GenAI CLIENT span 的开启与经 session 包装的结算。任务 9 往它上面落 `gen_ai.*` 属性。 |
| `routes/pipeline/attempt/emit/emit.ts` | 现有：attempt span 的开/关。任务 2 把 TTFT 收口到 `endAttempt`，任务 9 带出 response model/id，任务 10 改属性名。 |
| `routes/pipeline/attempt/error.ts` | 现有：attempt 失败整形。任务 4 新增导出 `rejectRequestShape`。 |
| `routes/pipeline/attempt/model-prepare.ts` | 现有：`resolveInvocation` 的双重结算点。任务 4 改成返回 `'reject'` 分支。 |
| `routes/pipeline/attempt/image.ts` | 现有：与 model-prepare 同形的双重结算点。任务 4 一并改。 |
| `routes/pipeline/attempt/model.ts` | 现有：model 路径的 attempt 入口。任务 4 处理 `'reject'`，任务 6 插入 prepare span 并重排 attempt/prepare 顺序。 |
| `routes/pipeline/attempt/attempt.ts` | 现有：候选循环与上游调用。任务 7 把 attempt context 交给 `createObservedFetch`。 |
| `routes/token-count/shared.ts` | 现有：token-count 路由的状态码属性。任务 10 随 `http.response.status_code` 改名。 |
| `routes/pipeline/span-tree.test.ts` | **新建（任务 3）**：整棵树的形状断言，任务 4、5、6、7、8、9、10 持续往里加 test。 |

**core（`packages/core/src/db/trace-store/`）**

| 文件 | 责任 |
|---|---|
| `span-projection/span-projection.ts` | 现有：读回时重建 root 的 `gen_ai.*`。任务 8 停止重建并保留非 root 的原样属性，任务 9、10 同步 usage / 状态码新 key。 |
| `trace-filters.ts` | 现有：`SUCCEEDED` / `FAILED` 的唯一判定点。任务 1 追加：root 状态不再是 4xx 的唯一信号，`FAILED` 改成 `statusCode = 2 OR finalHttpStatus >= 400`。 |
| `trace-lifecycle/trace-lifecycle.ts` | 现有：列表页摘要列的投影。任务 8 让 `modelId` 改从 `aio_proxy.attempt.model_id` 取。 |

**dashboard（`packages/dashboard/src/modules/traces/`）**

| 文件 | 责任 |
|---|---|
| `lib/trace-attribute-names/trace-attribute-names.ts` | 现有：手抄的 key 表。任务 10 同步改名。 |
| `lib/span-metrics/span-metrics.ts` | 现有：面板指标提取。任务 10 改状态码 / TTFT 读取，任务 12 产出 TTFT 刻度比例与 `ambiguous`。 |
| `lib/trace-layout/trace-layout.ts` | 现有：深度与布局计算（已经深度无关）。任务 12 把 TTFT 比例带进行模型。 |
| `components/span-waterfall/trace-waterfall-row.tsx` | 现有：单色柱。任务 12 加 TTFT 刻度。 |
| `components/span-detail-panel/span-metric-grid.tsx` | 现有：指标网格。任务 12 在 TTFT 单元格加 `ambiguous` 说明。 |

**i18n（`packages/i18n/messages/`）**

`{en,zh-Hans,zh-Hant,ja,ko}.json`：任务 12 新增 TTFT 刻度与 `ambiguous` 文案。

**demo / 发布物**

`docs/superpowers/demos/traces-redesign/detail.html` 的 span fixture 与 `demo.css` 的 `.wf-*` 样式，任务 13 更新成新树形状，并补 `.changeset/*.md`。

---

### Task 1: root SERVER span 的 4xx 不再置 ERROR

> **执行期修订（人类裁定）：** root 的 4xx 从 ERROR 变 UNSET 会让 dashboard 把 4xx 拒绝
> 计成**成功** —— `trace-filters.ts:11` 的 `SUCCEEDED = 结束了 AND statusCode != 2` 是
> 分桶图、outcome 筛选、延迟分位共用的唯一判定。本任务一并把它改成
> `FAILED = statusCode = 2 OR finalHttpStatus >= 400`、`SUCCEEDED = endedAt 非空 AND NOT FAILED`。
> `finalHttpStatus` 可空，比较必须先 `isNotNull` 闸一道，否则 `NOT NULL` 让这些行从两个桶里
> 同时消失。

**Files:**
- Modify: `packages/server/src/request-tracing/request-trace-recorder/completion.ts:29-37`
- Test: `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`

**Interfaces:**
- Consumes: 无（第一个任务）
- Produces: 无新导出。`applyTerminalAttributes(root, finish, identity)` 签名不变，行为变化：`finish.outcome === 'failure'` 且 `finish.finalHttpStatus` 落在 `[400, 500)` 时不再调 `root.setStatus({ code: SpanStatusCode.ERROR })`。

**规范要求：** OTel HTTP 语义约定规定 SERVER span 的 4xx 属于客户端错误，不应置 span status ERROR（只有 5xx 与未捕获异常才是）。`rejectRequest()` 产出的 400 / 404 / 413 全归这一类。`cancelled` 保持 ERROR 不变 —— 规范只约束 4xx。DB summary 列（`terminationReason` / `errorType` / `errorCode`）**照旧全部写入**，那是记账投影，不是 OTel status。

- [ ] **Step 1: 写失败测试**

追加到 `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`。照抄文件里已有的 `collector()` / `request()` 辅助用法（见同文件 `'failure sets ERROR status and failure termination reason'` 那个 test 的写法）：

```typescript
  test('4xx failure keeps the root span status UNSET but still records failure metadata', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'failure', finalHttpStatus: 404, errorCode: 'model_not_found' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.UNSET);
    expect(root?.attributes['aio_proxy.termination.reason']).toBe('failure');
    expect(root?.attributes['aio_proxy.error.code']).toBe('model_not_found');
    expect(completions[0]?.summary.terminationReason).toBe('failure');
  });

  test('5xx failure still sets the root span status to ERROR', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'internal_error' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });

  test('failure without an http status sets the root span status to ERROR', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'failure', errorCode: 'internal_error' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`
Expected: 第一个 test FAIL（实际拿到 `SpanStatusCode.ERROR`，期望 `UNSET`）；后两个 PASS。

- [ ] **Step 3: 改实现**

`completion.ts` 现状（第 29-37 行）：

```typescript
  if (finish.outcome === 'failure') {
    root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'failure' as TraceTerminationReason);
    if (finish.errorType !== undefined) root.setAttribute(attributeName.errorType, finish.errorType);
    if (finish.errorCode !== undefined) root.setAttribute(attributeName.errorCode, finish.errorCode);
  } else if (finish.outcome === 'cancelled') {
    root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'cancelled' as TraceTerminationReason);
  }
```

改成：

```typescript
  if (finish.outcome === 'failure') {
    // HTTP 语义约定：SERVER span 的 4xx 是客户端错误，span status 保持 UNSET。
    // 只有 5xx 和拿不到状态码的内部失败才是服务端错误。DB summary 列照旧全写。
    if (!isClientError(finish.finalHttpStatus)) root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'failure' as TraceTerminationReason);
    if (finish.errorType !== undefined) root.setAttribute(attributeName.errorType, finish.errorType);
    if (finish.errorCode !== undefined) root.setAttribute(attributeName.errorCode, finish.errorCode);
  } else if (finish.outcome === 'cancelled') {
    root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'cancelled' as TraceTerminationReason);
  }
```

并在 `applyTerminalAttributes` 之后、`applyUsageAttributes` 之前加这个私有函数：

```typescript
function isClientError(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && bun test src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑整个 request-tracing 目录，确认没有别的测试断言 4xx 是 ERROR**

Run: `cd packages/server && bun test src/request-tracing`
Expected: PASS。若有旧测试断言「404 → ERROR」，那条断言本身就是被本任务修正的行为，改断言而不是改实现，并在提交信息里点名。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/request-tracing/request-trace-recorder/completion.ts packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts
git commit -m "fix(server): 4xx 请求的 root span 状态保持 UNSET"
```

---

### Task 2: TTFT 收口到 attempt span（失败的 attempt 也要有）

**Files:**
- Modify: `packages/server/src/response-observation/response-observation.ts:5-13`（snapshot 类型）、`:87-93`（`observeContent`）、`:95-108`（`snapshot`）
- Modify: `packages/server/src/routes/pipeline/attempt/emit.ts:62-86`（`endAttempt`）、`:93-104`（`settleSuccess`）
- Test: `packages/server/src/response-observation/response-observation.test.ts`
- Test: `packages/server/src/routes/pipeline/attempt/emit.test.ts`（新建）

**Interfaces:**
- Consumes: 无（不依赖任务 1）
- Produces:
  - `AttemptResponseSnapshot` 新增可选字段 `firstContentMs?: number`（毫秒整数，相对 `createAttemptResponseObservation({ startedAt })` 的 baseline）。
  - `endAttempt(span, observation, terminal)` 行为变化：`snapshot().firstContentMs !== undefined` 时写 `attributeName.ttftMs`。签名不变。
  - `settleSuccess(...)` 返回值不变（仍带 `ttftMs`，来自 completion，供 root / DB summary 用），但**不再**自己写 attempt span 属性。

**规范要求：** 今天 attempt span 的 TTFT（写的是 `attributeName.ttftMs`，值 `aio_proxy.response.ttft_ms`，与 root 共用同一个 key；任务 10 才把 attempt 那份改名成 `aio_proxy.attempt.ttft_ms`）只有 `settleSuccess` 会写，也就是**只有成功的 attempt 有 TTFT**，失败转移的那条（最有诊断价值的那条）没有。改成由 observation 观测首个内容、`snapshot()` 带出、`endAttempt` 统一落属性 —— `endAttempt` 是成功/失败/取消三条路的唯一出口（`error.ts:22`、`raw.ts:121`、`emit.ts:91` 都汇到它）。

两处语义后果，都是本任务有意接受的：

1. **baseline 变了。** 旧值 = `firstTokenAt - captureStartedAt`（usage-capture 建立时刻）；新值 = `firstContent - observation.startedAt`，而 `observation.startedAt` 就是 `attempt.ts:246` 候选循环顶部的 `performance.now()`。新 baseline 更早（含 request prepare / 建连），正是 spec 给 `aio_proxy.attempt.ttft_ms` 定的「起点是该 attempt span 起点」。
2. **`ambiguous` 不写。** `raw-retry.ts` 的 attempt 内隐藏重试会让 `observeResponse` 跑第二次、`transportObservation` 变 `ambiguous`，此时首内容属于哪一次响应已无法归因，`snapshot()` 直接不带 `firstContentMs`。注意**不能**复用同一个 snapshot 里 `upstreamHeadersMs` 那套 `raw`（`responseCount === 1`）闸门：没走 observed fetch 的 provider（`markTransportUnavailable()` 之后 `responseCount === 0`）内容照样在流，TTFT 必须照写。

- [ ] **Step 1: 改现有 snapshot 断言 + 加新断言（这一步会让测试变红）**

`response-observation.test.ts` 里有三处对 `snapshot()` 的**全等** `toEqual`，加字段必须同步改，否则它们会因为多出 `firstContentMs` 而失败：

1. `'records one controlled SSE response against the candidate baseline'`（第 28-36 行）：`startedAt: 1_000`，首个 `observeContent()` 发生在 `now = 1_030`，所以在 `contentGapP95Ms: 11,` 那行后面补一行 `firstContentMs: 30,`。
2. `'keeps meaningful zero timings and ignores empty reads'` 第二个断言（第 65-73 行）：`startedAt: 5`、`now` 恒为 `5`，在 `contentGapP95Ms: 0,` 后面补 `firstContentMs: 0,`。同一个 test 的第一个断言（第 55-59 行，还没有内容）**不改**。
3. `'keeps content gaps local to each response after two responses'`（第 87 行）：断言是 `toEqual({ transportObservation: 'ambiguous', contentGapP95Ms: 10 })`，**保持原样** —— 它正好是 `ambiguous` 抑制的回归守卫，改完实现必须仍然绿。

再追加两个新 test：

```typescript
test('records the first content timestamp against the candidate baseline', () => {
  const observation = createAttemptResponseObservation({ startedAt: 100, now: () => 100 });
  observation.observeFetchStart();
  observation.observeResponse(new Response('body'), { controlledStream: false });
  observation.observeContent(180);
  observation.observeContent(240);

  expect(observation.snapshot().firstContentMs).toBe(80);
});

test('records the first content timestamp even when no response was observed', () => {
  const observation = createAttemptResponseObservation({ startedAt: 100, now: () => 100 });
  observation.markTransportUnavailable();
  observation.observeContent(150);

  expect(observation.snapshot().firstContentMs).toBe(50);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/response-observation/response-observation.test.ts`
Expected: 5 个 FAIL —— 两个新 test 拿到 `undefined`，两个改过的全等断言少了 `firstContentMs`，`'returns the sampled absolute content timestamp'` 那个只读 `.contentGapP95Ms`，不受影响（应该仍然 PASS）。

- [ ] **Step 3: 改 `response-observation.ts`**

类型（第 5-13 行）里 `firstSseEventMs` 之后加一行：

```typescript
  readonly firstContentMs?: number;
```

`createAttemptResponseObservation` 的局部状态里，`lastContentAt` 声明之前加：

```typescript
  let firstContentMs: number | undefined;
```

`observeContent`（第 87 行起）在函数体最前面加一行赋值 —— 放在 gap 统计之前，保证第一次调用就记下：

```typescript
    observeContent(at = now()) {
      firstContentMs ??= elapsed(at);
      if (lastContentAt !== undefined) {
```

`snapshot()` 的返回对象里，`firstSseEventMs` 那行之后插入：

```typescript
        ...(transportObservation === 'ambiguous' || firstContentMs === undefined ? {} : { firstContentMs }),
```

注意这一行**不带** `raw &&`，与相邻几行不同 —— 理由见上面「规范要求」第 2 点，实现时在这行上方留一句注释：

```typescript
        // 不走 observed fetch 的 provider 也有内容流，所以这里不能用 raw 闸门；
        // 只有 attempt 内隐藏重试（ambiguous）才让首内容无法归因。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && bun test src/response-observation/response-observation.test.ts`
Expected: PASS（含 `ambiguous` 那条保持原断言不变）。

- [ ] **Step 5: 写 `emit.test.ts`（新文件，先红）**

新建 `packages/server/src/routes/pipeline/attempt/emit.test.ts`。它验证的是本任务的真实产品行为：**失败的 attempt span 也带 TTFT**。

```typescript
import { expect, test } from 'bun:test';

import type { TraceCompletion } from '@aio-proxy/core/db';
import { ProviderKind } from '@aio-proxy/types';

import { attributeName, createRequestTraceRecorder } from '../../../request-tracing';
import { createAttemptResponseObservation } from '../../../response-observation';
import type { AttemptInfo } from '../attempt-base';
import { failureTerminal } from '../failure';
import { createAttemptEmitter } from './emit';

const base: AttemptInfo = {
  routingContractVersion: 2,
  providerWeight: 1,
  effectivePriority: 0,
  effectiveWeight: 1,
  prioritySource: 'provider',
  weightSource: 'provider',
  selectionSource: 'weighted_random',
  sourceProtocol: 'openai-chat',
  selectionReason: 'weight',
  providerId: 'p1',
  modelId: 'gpt-4o',
  providerKind: ProviderKind.Api,
  durationMs: 7,
};

test('a failed attempt span carries the observed time to first content', () => {
  const completions: TraceCompletion[] = [];
  const recorder = createRequestTraceRecorder({
    store: {
      startRoot: () => {},
      complete: (input: TraceCompletion) => (completions.push(input), true),
      prune: () => {},
      recover: () => {},
    },
  });
  const session = recorder.begin({
    inboundRequest: new Request('http://localhost'),
    inboundProtocol: 'openai-chat',
  });
  const emitter = createAttemptEmitter(session, true);
  const observation = createAttemptResponseObservation({ startedAt: 100, now: () => 100 });
  observation.observeFetchStart();
  observation.observeResponse(new Response('body'), { controlledStream: false });
  observation.observeContent(160);

  emitter.emitAttempt(base, 0, observation, failureTerminal(502, 'upstream_error'));
  session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'upstream_error' });

  const attempt = completions[0]?.spans.find((span) => span.spanId !== session.rootSpanId);
  expect(attempt?.attributes[attributeName.ttftMs]).toBe(60);
});
```

用 `attributeName.ttftMs` 而不是写死字符串：这个 key 现在还是 `aio_proxy.response.ttft_ms`，任务 10 会把 attempt 那份换成 `attributeName.attemptTtftMs`，那一步顺手改这里的常量名即可，值不用管。

- [ ] **Step 6: 跑测试确认失败**

Run: `cd packages/server && bun test src/routes/pipeline/attempt/emit.test.ts`
Expected: FAIL（`undefined`，因为今天只有 `settleSuccess` 写这个属性）。

- [ ] **Step 7: 改 `emit.ts`**

`endAttempt` 里，在 `contentEncoding` 那段之后、`attemptSpan.end(terminal)` 之前插入：

```typescript
    if (snapshot.firstContentMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.ttftMs, snapshot.firstContentMs);
    }
```

`settleSuccess` 删掉自己那次写入（第 96 行），其余原样 —— 返回值里的 `ttftMs` 仍然来自 completion，root / DB summary 不受影响：

```typescript
    settleSuccess(attemptSpan, observation, completion, ids, clientResponse, getResponseId) {
      return completion.then((value) => {
        // attempt span 的 TTFT 由 endAttempt 从 observation 统一落，这里只负责 root/DB 的那份。
        const ttftMs = 'ttftMs' in value ? value.ttftMs : undefined;
        endAttempt(attemptSpan, observation, completionTerminal(value));
        return {
          ...completionFinish(value, ids, getResponseId?.()),
          ...(ttftMs === undefined ? {} : { ttftMs }),
          clientResponse,
        };
      });
    },
```

- [ ] **Step 8: 跑测试确认通过**

Run: `cd packages/server && bun test src/routes/pipeline/attempt/emit.test.ts src/response-observation`
Expected: PASS。

- [ ] **Step 9: 跑全量服务端测试，确认没有旧断言依赖「失败 attempt 没有 TTFT」或依赖旧 baseline 数值**

Run: `cd packages/server && bun test`
Expected: PASS。两个已知的相关消费方只是把属性投影出来、不断言具体值（`__tests__/pipeline-helpers/recording.ts:94` 读 `attributeName.ttftMs` 填 `ttftMs`，`__tests__/pipeline-helpers/types.ts:63` 声明它是可选），所以不需要改。若真有测试断言某个 attempt 的 `ttftMs` 等于某个精确毫秒数，那个数现在包含建连时间了 —— 改断言成 `expect.any(Number)` 或区间，并在提交信息里点名。

- [ ] **Step 10: 提交**

```bash
git add packages/server/src/response-observation packages/server/src/routes/pipeline/attempt/emit.ts packages/server/src/routes/pipeline/attempt/emit.test.ts
git commit -m "feat(server): 失败的 provider attempt 也记录 TTFT"
```

---

### Task 3: 三个请求级 span（parse / session.resolve / route.resolve）

**Files:**
- Modify: `packages/server/src/routes/pipeline/index.ts:89`（`parseProtocolRequest` 调用点不动，改它内部）、`:180-184`（`adapter.parse`）、`:97-102`（`logicalSessionStore.begin`）、`:259-266`（`router.resolve` + `filterCandidatesByCapability`）
- Modify: `packages/server/src/request-tracing/semantic.ts:43`（新增一个属性名）
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`（新建，后续任务继续往里加）

**Interfaces:**
- Consumes: 无
- Produces:
  - `attributeName.routeCandidateCount = 'aio_proxy.route.candidate_count'`（本任务的 test 读它做断言）。
  - 三个 span 名**已经在 `semantic.ts` 里声明好了**、只是从来没被创建过：`spanName.parse`（`aio_proxy.request.parse`）、`spanName.session`（`aio_proxy.session.resolve`）、`spanName.route`（`aio_proxy.route.resolve`）。不要新增常量，直接用。

**规范要求：** 这三段今天完全不可见 —— root 的 duration 里混着解析、会话解析、路由三段，dashboard 只能看到「root 开始到第一个 attempt 之间有一段空白」。三个都是 root 的直接子 span，`SpanKind` 用默认的 `INTERNAL`（`startPipelineSpan` 不传 `kind` 就是 INTERNAL，不需要显式写）。

**结算顺序**是这个任务唯一的坑：三段里每一段都可能直接走到 `rejectRequest()` → `session.finish()` → `processor.take()`，所以每条路径上 span 必须**先 end 再让结算发生**。下面的实现全部把 `end()` 放在 `return`/`throw` 之前，不要用 `try { } finally { }` 之外的写法偷懒 —— `finally` 在 `return` 表达式求值之后才跑，而 `rejectRequest()` 是在 `return` 表达式里调用的，那样就晚了。

- [ ] **Step 1: 写失败测试**

新建 `packages/server/src/routes/pipeline/span-tree.test.ts`。后面的任务 4、5 会继续往这个文件里加 test，所以顶部的 `tree()` 辅助要一次写好：

```typescript
import { expect, test } from 'bun:test';

import type { StoredSpan } from '@aio-proxy/core/db';

import { jsonRequest, rawProvider, REQUESTED_MODEL, settleRecording } from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import { pipeline } from './test-support';

// 把一次录制里的 span 按名字索引，并给出「谁是谁的爹」的可读投影。
function tree(spans: readonly StoredSpan[]) {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  return {
    find: (name: string) => spans.find((span) => span.name === name),
    parentNameOf: (name: string) => {
      const span = spans.find((candidate) => candidate.name === name);
      const parentId = span?.parentSpanId;
      return parentId === undefined ? undefined : byId.get(parentId)?.name;
    },
  };
}

async function runOnce() {
  const harness = pipeline([rawProvider({ id: 'raw', invoke: async () => Response.json({ ok: true }) })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await response.json();
  await settleRecording(harness.recording);
  return { response, spans: harness.recording.spans };
}

test('parse, session and route spans hang directly under the root span', async () => {
  const { spans } = await runOnce();
  const spanTree = tree(spans);

  expect(spanTree.parentNameOf(spanName.parse)).toBe(spanName.request);
  expect(spanTree.parentNameOf(spanName.session)).toBe(spanName.request);
  expect(spanTree.parentNameOf(spanName.route)).toBe(spanName.request);
});

test('the route span records how many candidates survived capability filtering', async () => {
  const { spans } = await runOnce();

  expect(tree(spans).find(spanName.route)?.attributes[attributeName.routeCandidateCount]).toBe(1);
});

test('a parse failure ends the parse span before the root settles', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  const response = await harness.run(jsonRequest({ prompt: 'missing model' }));
  await settleRecording(harness.recording);

  expect(response.status).toBe(400);
  // take() 在 root.end() 之后立刻抽干 buffer：parse span 没赶在前面就会整条消失。
  expect(tree(harness.recording.spans).find(spanName.parse)).toBeDefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: 全 FAIL —— 前两个拿到 `undefined`（span 根本没被创建过），第三个 `toBeDefined()` 失败。

- [ ] **Step 3: 加属性名常量**

`semantic.ts` 的 `attributeName` 里，`finalProviderId` 那行后面插入：

```typescript
  routeCandidateCount: 'aio_proxy.route.candidate_count',
```

`ALLOWED_ATTRIBUTES`（第 84 行）是 `Object.values(attributeName)` 算出来的，不用另外登记。

- [ ] **Step 4: 改 `index.ts` 的三个插桩点**

先补 import：`../../request-tracing` 那行改成 `import { attributeName, requestAsksFastMode, type RequestTraceSession, spanName } from '../../request-tracing';`，并新增 `import { startPipelineSpan } from './tracing';`。

**(a) parse。** `parseProtocolRequest` 函数体（第 178-182 行）：

```typescript
  const { adapter, context, rawRequest, session } = options;
  const span = startPipelineSpan(session.rootContext, spanName.parse);
  try {
    const request = await span.run(() => adapter.parse(rawRequest, context));
    span.end();
    return { request };
  } catch (error) {
    // 下面每条分支都会走到 rejectParsedRequest -> session.finish -> processor.take()，
    // 所以 span 必须在进入它们之前就 end。
    span.end({ outcome: 'failure' });
    await cancelRetainedRequestBody(rawRequest, error);
```

`catch` 剩下的部分（`RequestBodyTooLargeError` / `UnsupportedContentEncodingError` / `requestError` 三条分支）一行不动。

**(b) session。** `handleProtocolRequestInContext` 第 97-102 行：

```typescript
    const sessionSpan = startPipelineSpan(session.rootContext, spanName.session);
    const resolution = sessionSpan.run(() =>
      source.logicalSessionStore.begin({
        requestedModelId: requestedModel,
        requestId: session.requestId,
        hints: adapter.session?.(request, context) ?? { candidates: [], transcript: request },
        headers: rawRequest.headers,
      }),
    );
    sessionSpan.end();
```

紧随其后的 `session.identify(...)` 与 `responseStatus === 'ambiguous'` 拒绝分支都不动 —— span 已经关了，`ambiguous` 的 409 结算发生在它之后，安全。

**(c) route。** `attemptResolvedRequest` 的 `try` 块（第 259-278 行）改成：

```typescript
    const routeSpan = startPipelineSpan(session.rootContext, spanName.route);
    let eligible;
    try {
      const candidates = routeSpan.run(() =>
        lease.snapshot.router.resolve(requestedModel, adapter.dimensions(request, context), {
          session: resolution.context.session,
        }),
      );
      eligible = filterCandidatesByCapability(candidates, adapter.capability, {
        requestedModelId: requestedModel,
        routerModels: lease.snapshot.config?.router.models,
      });
    } catch (error) {
      // RouterModelNotFoundError 会被外层 catch 变成 404；span 得先关。
      routeSpan.end({
        outcome: 'failure',
        ...(error instanceof RouterModelNotFoundError ? { errorCode: 'model_not_found' } : {}),
      });
      throw error;
    }
    routeSpan.span.setAttribute(attributeName.routeCandidateCount, eligible.length);
    if (eligible.length === 0) {
      routeSpan.end({ outcome: 'failure', errorCode: 'not_implemented' });
      const error = new Error('No eligible provider candidates for inbound capability');
      return rejectRequest({
        source,
        session,
        rawRequest,
        inboundProtocol,
        requestedModelId: requestedModel,
        response: adapter.errors.unsupported(noCandidateFeature(adapter.capability)),
        errorCode: 'not_implemented',
        error,
      });
    }
    routeSpan.end();
    return await attemptCandidates({
```

`attemptCandidates({...})` 的参数表原样保留（`candidates: eligible` 那行本来就是这么写的）。

注意这三个内部 span 失败时**照样置 ERROR**，哪怕对应的 HTTP 状态是 4xx —— 任务 1 的「4xx 不置 ERROR」只约束 root 的 SERVER span（HTTP 语义约定的对象是 SERVER/CLIENT span），内部操作确实失败了就该是 ERROR。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: PASS。

- [ ] **Step 6: 跑整个 pipeline 目录 + 全量，确认没有测试按「一条 trace 恰好 N 个 span」断言**

Run: `cd packages/server && bun test`
Expected: PASS。若某个测试断言了 span 数量或 `spans.map(name)` 的完整数组，那是被本任务正当改变的形状 —— 更新断言，不要为了迁就它少开 span。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/request-tracing/semantic.ts packages/server/src/routes/pipeline/index.ts packages/server/src/routes/pipeline/span-tree.test.ts
git commit -m "feat(server): 记录解析、会话解析与路由三个请求级 span"
```

---

### Task 4: 结算所有权归位（准备阶段返回拒绝信息，不再自己发射 + 结算）

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/error.ts:1-26`（新增导出 `rejectRequestShape`）
- Modify: `packages/server/src/routes/pipeline/attempt/model-prepare.ts:18-24,76-116`
- Modify: `packages/server/src/routes/pipeline/attempt/model.ts:1-26`
- Modify: `packages/server/src/routes/pipeline/attempt/image.ts:1-77`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`（任务 3 建的文件，往里加一个 test）

**Interfaces:**
- Consumes: 任务 3 在 `span-tree.test.ts` 顶部写好的 `tree()` 辅助与 `settleRecording`。
- Produces:
  - `rejectRequestShape(ctx, slot, rejection)` → `AttemptStep`，`rejection` 是 `RequestShapeRejection = { response: Response; errorCode: string; error: unknown }`。
  - `PreparedInvocation` 新增第三个分支 `{ kind: 'reject'; response; errorCode; error }`。**任务 6 会在 model.ts 处理这个分支之前插入 `prepareSpan.end()`** —— 这正是本任务存在的理由。

**这是纯重构：现有 trace 形状、终态、状态码、日志逐字段不变。** 不新增任何 span。

**为什么必须先做。** `model-prepare.ts:97-99` 和 `image.ts:64-66` 在 `adapter.modelInvocation` / `adapter.imageInvocation` 抛错时，自己 `emitAttempt()`（开+关合成一个 attempt span）再 `session.finish()`。`session.finish()` → `root.end()` → `processor.take(traceId)` 把 buffer 抽干删除。任务 6 把 prepare 挪进 attempt span 之后，这两条路会变成：①已经打开的 attempt span 永不关闭、连同它的 prepare 子 span 一起在 `take()` 时被丢弃，②`emitAttempt` 再合成第二个 attempt —— 一次失败出两行 attempt。

改法是让准备阶段**把拒绝信息沿返回值往上走**，由候选循环统一发射与结算。顺带修掉一个今天就存在的重复：这两处把 `emitAttempt` 的开关逻辑抄了一遍，而 `error.ts:13` 的 `endAttemptSpan()` 已经有「有开着的 span 就复用，没有就合成一个」的正确实现。

- [ ] **Step 1: 写特征测试（characterization test）**

这一步的测试**现在就应该通过** —— 它不是红灯，是重构的安全网。它锁住「`modelInvocation` 抛错时恰好一个 attempt span」，任务 6 一旦踩到上面那个坑，这条会立刻变红。

往 `packages/server/src/routes/pipeline/span-tree.test.ts` 末尾追加：

```typescript
test('a model invocation failure produces exactly one attempt span', async () => {
  const harness = pipeline([rawProvider({ id: 'primary' }), rawProvider({ id: 'backup' })], {
    adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      modelInvocationError: new SyntaxError('invalid invocation'),
    }),
  });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);

  expect(response.status).toBe(400);
  expect(harness.recording.spans.filter((span) => span.name === spanName.attempt)).toHaveLength(1);
  // 请求整形失败不是候选特有的，所以**不**转移到 backup —— 断言这一点，
  // 免得后人误以为「只有一个 attempt」是因为 hasNext 为 false。
  expect(harness.recording.finals).toEqual([
    expect.objectContaining({ errorCode: 'invalid_request', finalProviderId: 'primary', outcome: 'failure' }),
  ]);
});
```

顶部 import 补 `defineProtocolAdapter`（来自 `../../../__tests__/pipeline-helpers`）与 `ProviderProtocol`（来自 `@aio-proxy/types`）。

`modelInvocationError` 这个开关是 `__tests__/pipeline-helpers/adapter.ts:13` 现成的，不要新造 fixture。终态字段的完整断言在 `src/routes/pipeline/selection.test.ts:152` 已经有了（`records the selected candidate when model invocation rejects the request`），这里只补它缺的 span 维度。

- [ ] **Step 2: 跑测试确认它现在就是绿的**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: PASS。**如果这里是红的，停下来先搞清楚为什么** —— 说明当前行为跟你以为的不一样，重构的基线不成立。

- [ ] **Step 3: 在 `error.ts` 里加 `rejectRequestShape`**

`packages/server/src/routes/pipeline/attempt/error.ts`：import 区补一行 `import { logRequestRejected } from '../logging';`（放在 `import { failureTerminal, finalFailure } from '../failure';` 之后，`import type { SpanTerminal } ...` 之前，保持字母序）。

然后在 `emitReject`（第 44 行结尾）之后插入：

```typescript
// A rejection produced while materializing the request: the protocol adapter
// could not convert this request at all. Not candidate-specific, so it never
// falls back to the next candidate.
export type RequestShapeRejection = {
  readonly response: Response;
  readonly errorCode: string;
  readonly error: unknown;
};

// Terminates the whole request on a materialization failure. Goes through
// endAttemptSpan so an already-open attempt span is reused instead of being
// abandoned and a second one synthesized.
export function rejectRequestShape<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  rejection: RequestShapeRejection,
): AttemptStep {
  const { adapter, rawRequest, session, source, requestedModelId } = ctx;
  const { response, errorCode, error } = rejection;
  const base = attemptBase(slot.candidate.provider, slot.candidate.modelId, slot.startedAt, slot.trace);
  endAttemptSpan(ctx, slot, base, failureTerminal(response.status, errorCode));
  session.finish({ ...finalFailure(base, response.status, errorCode), clientResponse: response });
  logRequestRejected({
    source,
    requestId: session.requestId,
    rawRequest,
    inboundProtocol: adapter.protocol,
    requestedModelId,
    statusCode: response.status,
    errorCode,
    error,
  });
  return { kind: 'return', response };
}
```

副作用顺序（span → finish → log）跟被替换的两处逐字相同，不要调整。

- [ ] **Step 4: `model-prepare.ts` 改成返回拒绝信息**

`packages/server/src/routes/pipeline/attempt/model-prepare.ts`。

4a. 类型加分支（第 18-24 行）：

```typescript
export type PreparedInvocation =
  | {
      readonly kind: 'ok';
      readonly candidateInvocation: ModelInvocation;
      readonly targetProtocol: ProviderProtocol | undefined;
    }
  | ({ readonly kind: 'reject' } & RequestShapeRejection)
  | { readonly kind: 'step'; readonly step: AttemptStep };
```

4b. `resolveInvocation` 的 catch 分支（第 93-111 行），整段替换成：

```typescript
      } else {
        const mapped = adapter.errors.requestError(error);
        if (mapped === undefined) throw error;
        return {
          kind: 'reject',
          response: mapped,
          errorCode: mapped.status === 501 ? 'unsupported_feature' : 'invalid_request',
          error,
        };
      }
```

4c. 函数头的解构（第 83-84 行）缩成：

```typescript
  const { adapter, request, context } = ctx;
```

第 84 行 `const { index, candidate, startedAt } = slot;` 整行删掉 —— 三个都只被刚删掉的那段用。

4d. import 清理：`attemptBase`（第 5 行）、`failureTerminal, finalFailure`（第 6 行）、`logRequestRejected`（第 7 行）三行全删，它们在本文件里只服务于刚删掉的那段。第 16 行改成 `import { emitReject, type RequestShapeRejection } from './error';`。

- [ ] **Step 5: 两个调用点接上**

`packages/server/src/routes/pipeline/attempt/model.ts`：第 10 行的 import 后面补 `import { rejectRequestShape } from './error';`（在 `import { assertCandidateSupported, prepareModelInvocation } from './model-prepare';` 之前）。第 24-25 行改成：

```typescript
  const prepared = await prepareModelInvocation(ctx, slot, model, holder);
  if (prepared.kind === 'reject') return rejectRequestShape(ctx, slot, prepared);
  if (prepared.kind !== 'ok') return prepared.step;
```

`packages/server/src/routes/pipeline/attempt/image.ts`：第 5-6 行两个 import 删掉（`failureTerminal, finalFailure` 与 `logRequestRejected` 在本文件里只服务于要替换的那段；`attemptBase` 第 79 行还在用，留着）。第 10 行改成 `import { rejectRequestShape, unsupportedDispatch } from './error';`。第 59-77 行的 catch 整段替换成：

```typescript
  } catch (error) {
    const mapped = adapter.errors.requestError(error);
    if (mapped === undefined) throw error;
    return rejectRequestShape(ctx, slot, {
      response: mapped,
      errorCode: mapped.status === 501 ? 'unsupported_feature' : 'invalid_request',
      error,
    });
  }
```

替换后 `ctx.source` / `ctx.requestedModelId` / `index` 在这个 catch 里都不再出现；`session` 与 `index` 在函数后半段还有用，解构行不动。

- [ ] **Step 6: 跑测试确认纯重构成立**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts src/routes/pipeline/selection.test.ts src/routes/pipeline/rejection-lifecycle.test.ts`
Expected: PASS，`selection.test.ts:152` 那条（终态 + 日志逐字段）必须原样通过 —— 它就是「逐字段一致」的验收。

Run: `cd packages/server && bun test`
Expected: PASS。图像路径的拒绝测试（`bun test src/routes/pipeline` 里凡是断言 image 400/501 的）也必须原样通过。如果需要改任何断言，说明这一步不是纯重构了 —— 回到 Step 3 查差异，不要改断言迁就实现。

- [ ] **Step 7: 提交**

```bash
git add packages/server/src/routes/pipeline/attempt/error.ts \
  packages/server/src/routes/pipeline/attempt/model-prepare.ts \
  packages/server/src/routes/pipeline/attempt/model.ts \
  packages/server/src/routes/pipeline/attempt/image.ts \
  packages/server/src/routes/pipeline/span-tree.test.ts
git commit -m "refactor(server): 请求整形失败改为返回拒绝信息由候选循环结算"
```

---

### Task 5: GenAI CLIENT span，attempt 改挂到它下面

**Files:**
- Create: `packages/server/src/routes/pipeline/inference-span.ts`
- Modify: `packages/server/src/request-tracing/semantic.ts:3-15`（删 `spanName.inference`）、`:26-72`（新增两个属性名）
- Modify: `packages/server/src/routes/pipeline/index.ts:266-295`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`

**Interfaces:**
- Consumes: `startPipelineSpan` / `SpanTerminal`（`./tracing`）、`RequestTraceSession` / `RequestTraceFinishInput`（`../../request-tracing`）。
- Produces:
  - `startInferenceSpan(session, capability, requestedModelId): InferenceSpan`，`InferenceSpan = { session: RequestTraceSession; end: (terminal?: SpanTerminal) => void }`。
  - `attributeName.capability = 'aio_proxy.capability'`、`attributeName.genAiOperationName = 'gen_ai.operation.name'`。
  - **attempt span 的父亲从此是 GenAI span**，`emit.ts` 一行都不用改（它读 `session.rootContext`，我们换掉的正是这个字段）。任务 6、7 的 prepare / POST span 挂在 attempt 下，不受影响。

**这是整个 PR 的关键一层。** 不做这一层，前面三个任务只是给平树多加了三行；GenAI span 是唯一带 `gen_ai.*` 的 span，Langfuse 靠它识别 GENERATION，任务 8、9 的属性下沉也全指着它。

**两个坑，都在 spec 里被点名：**

1. **不能包在 `attemptResolvedRequest` 外面。** 路由解析在这个函数**内部**（`index.ts:259-265`），而 `route.resolve` span 是 GenAI span 的**兄弟**。所以 GenAI span 只能在函数内、`routeSpan.end()` 之后开。
2. **终点必须取终态结算，不是函数返回。** 流式路径在 completion 结算之前就 `return` 掉 `Response` 了（`raw.ts:169` / `image.ts:108` 的 `session.finishFrom`）。所以**绝不能**写 `finally { inference.end() }` —— 那会在流还在跑的时候就把 span 关掉，`gen_ai.*` 用量属性（任务 9）就永远写不进去。

结算的钩子挂在 session 上而不是靠 `finally`：包一层 `RequestTraceSession`，`finish` 先关 GenAI span 再委托，`finishFrom` 则**先挂自己的 `.then` 再交给原 session**。后者成立的依据是 `request-trace-recorder.ts` 的 `finishFrom` 实现是 `void completion.then(...)` —— 同一个 promise 上先注册的回调先跑，所以 GenAI span 一定关在 `root.end()` → `processor.take()` 之前。

只有「异常穿透出去」这一条路不经过 session 结算，用 `catch` 补，不用 `finally`。

- [ ] **Step 1: 写失败测试**

往 `packages/server/src/routes/pipeline/span-tree.test.ts` 末尾追加。顶部 import 补 `SpanKind`、`SpanStatusCode`（来自 `@opentelemetry/api`）与 `emptyStream, modelProvider, textStream`（来自 `../../../__tests__/pipeline-helpers`）：

```typescript
async function runFailover() {
  const primary = modelProvider({ id: 'primary', invoke: emptyStream });
  const backup = modelProvider({ id: 'backup', invoke: () => textStream('backup') });
  const harness = pipeline([primary, backup]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  return harness.recording.spans;
}

test('every attempt hangs under the inference span, which hangs under the root', async () => {
  const spans = await runFailover();
  const inference = spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);

  expect(inference).toBeDefined();
  expect(inference?.kind).toBe(SpanKind.CLIENT);
  expect(tree(spans).parentNameOf(inference?.name ?? '')).toBe(spanName.request);
  const attempts = spans.filter((span) => span.name === spanName.attempt);
  expect(attempts).toHaveLength(2);
  expect(attempts.map((span) => span.parentSpanId)).toEqual([inference?.spanId, inference?.spanId]);
});

test('the inference span carries the requested model and the gen_ai operation', async () => {
  const spans = await runFailover();
  const inference = spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);

  expect(inference?.attributes[attributeName.genAiRequestModel]).toBe(REQUESTED_MODEL);
  expect(inference?.attributes[attributeName.genAiOperationName]).toBe('chat');
  expect(inference?.attributes[attributeName.capability]).toBe('language');
});

test('a failover that eventually succeeds leaves the inference span OK', async () => {
  const spans = await runFailover();
  const inference = spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);
  const attempts = spans.filter((span) => span.name === spanName.attempt);

  // ERROR 的判据是这次逻辑操作怎么结算的，不是「有没有 attempt 失败过」。
  expect(inference?.statusCode).not.toBe(SpanStatusCode.ERROR);
  expect(attempts[0]?.statusCode).toBe(SpanStatusCode.ERROR);
});

test('the inference span ends on terminal settlement, not when the stream Response returns', async () => {
  const spans = await runFailover();
  const inference = spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);
  const attempts = spans.filter((span) => span.name === spanName.attempt);
  const lastAttempt = attempts.at(-1);

  // 流式请求先 return Response、后结算 completion。若 GenAI span 在函数返回时关，
  // 它会早于最后一个 attempt 结束。
  expect(inference?.endedAt.getTime()).toBeGreaterThanOrEqual(lastAttempt?.endedAt.getTime() ?? 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: FAIL —— `inference` 是 `undefined`（今天没人创建这个 span），四条全红。

- [ ] **Step 3: 加两个属性名，删一个死 span 名**

`packages/server/src/request-tracing/semantic.ts`：

- `spanName` 里第 10 行 `inference: 'gen_ai.client.inference',` **删掉**。span 名是 `{operation} {model}` 这种动态串，不存在一个固定常量；留着它只会让下一个人以为有。
- `attributeName` 里 `operation: 'aio_proxy.operation',`（第 27 行）之后插入：

```typescript
  capability: 'aio_proxy.capability',
  genAiOperationName: 'gen_ai.operation.name',
```

`ALLOWED_ATTRIBUTES`（第 84 行）是 `new Set(Object.values(attributeName))`，自动跟上，不用改。

- [ ] **Step 4: 新建 `inference-span.ts`**

Create `packages/server/src/routes/pipeline/inference-span.ts`：

```typescript
import type { InboundCapability } from '@aio-proxy/core';
import { SpanKind } from '@opentelemetry/api';

import {
  attributeName,
  type RequestTraceFinishInput,
  type RequestTraceSession,
} from '../../request-tracing';
import { type SpanTerminal, startPipelineSpan } from './tracing';

// Span-name verb per capability. Only `chat` and `embeddings` are registered
// gen_ai.operation.name values, so the other four name the span without
// claiming an attribute value the semantic conventions do not define.
const OPERATION_VERB: Record<InboundCapability, string> = {
  language: 'chat',
  embedding: 'embeddings',
  image: 'image',
  speech: 'speech',
  transcription: 'transcription',
  video: 'video',
};

const GEN_AI_OPERATION: Partial<Record<InboundCapability, string>> = {
  language: 'chat',
  embedding: 'embeddings',
};

function inferenceTerminal(input: RequestTraceFinishInput): SpanTerminal {
  return {
    outcome: input.outcome,
    ...(input.outcome === 'failure' && input.errorType !== undefined ? { errorType: input.errorType } : {}),
    ...(input.outcome === 'failure' && input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.finalHttpStatus === undefined ? {} : { httpStatus: input.finalHttpStatus }),
  };
}

export type InferenceSpan = {
  // Same session with rootContext swapped for the inference span's context, so
  // everything the candidate loop opens hangs under it instead of under root.
  readonly session: RequestTraceSession;
  readonly end: (terminal?: SpanTerminal) => void;
};
```

同一个文件接着写：

```typescript
// The one GENERATION span: exactly one per logical operation, the only span
// allowed to carry gen_ai.* attributes. Failure is decided by how the operation
// settles, NOT by whether candidates ran out.
export function startInferenceSpan(
  session: RequestTraceSession,
  capability: InboundCapability,
  requestedModelId: string,
): InferenceSpan {
  const genAiOperation = GEN_AI_OPERATION[capability];
  const open = startPipelineSpan(session.rootContext, `${OPERATION_VERB[capability]} ${requestedModelId}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      [attributeName.capability]: capability,
      [attributeName.genAiRequestModel]: requestedModelId,
      ...(genAiOperation === undefined ? {} : { [attributeName.genAiOperationName]: genAiOperation }),
    },
  });
  return {
    end: open.end,
    session: {
      ...session,
      rootContext: open.context,
      finish: (input) => {
        open.end(inferenceTerminal(input));
        return session.finish(input);
      },
      // Attaching our callback to the completion BEFORE handing it to the
      // recorder is what keeps this span alive across a streaming response and
      // still closes it before root.end() runs processor.take(), which drops
      // every span still open.
      finishFrom: (completion) => {
        session.finishFrom(
          completion.then(
            (input) => {
              open.end(inferenceTerminal(input));
              return input;
            },
            (error: unknown) => {
              open.end({ outcome: 'failure' });
              throw error;
            },
          ),
        );
      },
    },
  };
}
```

`end: open.end` 是安全的：`startPipelineSpan` 返回的 `end` 是闭包方法，不依赖 `this`。

- [ ] **Step 5: 在 `index.ts` 里接线**

`packages/server/src/routes/pipeline/index.ts`。import 区补 `import { startInferenceSpan } from './inference-span';`。

任务 3 已经把 `routeSpan.end();` 放在了 `return await attemptCandidates({` 之前。把从 `routeSpan.end();` 到 `attemptCandidates({...})` 那一段改成：

```typescript
    routeSpan.end();
    const inference = startInferenceSpan(session, adapter.capability, requestedModel);
    try {
      return await attemptCandidates({
        adapter,
        candidates: eligible,
        config: lease.snapshot.config,
        context,
        deferRelease,
        rawRequest,
        release: lease.release,
        request,
        requestedModelId: requestedModel,
        resolution,
        session: inference.session,
        source,
        streamRequested,
        ...(options.onSuccessfulAttempt === undefined ? {} : { onSuccessfulAttempt: options.onSuccessfulAttempt }),
      });
    } catch (error) {
      // 唯一不经过 session 结算的出口。**不要**改成 finally：流式路径在 completion
      // 结算之前就 return 了 Response，finally 会把 span 提前关掉。
      inference.end({ outcome: 'failure' });
      throw error;
    }
```

唯一的实质改动是 `session: inference.session`（原来是 `session`）—— attempt span 由此改挂到 GenAI span 下。外层那个 `catch (error) { if (!(error instanceof RouterModelNotFoundError)) throw error; ... }` 不动：`RouterModelNotFoundError` 来自 `router.resolve()`，发生在 GenAI span 存在之前。

- [ ] **Step 6: 跑测试确认通过**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: PASS。

- [ ] **Step 7: 全量，修被正当改变形状的断言**

Run: `cd packages/server && bun test`
Expected: PASS。会红的是断言「attempt 的父亲是 root」或「一条 trace 恰好 N 个 span」的测试 —— 那正是本任务要改的事实，更新断言。**不要**为了让它们过而少开 span 或退回 `session`。

Run: `cd packages/dashboard && bun run test:unit`
Expected: PASS（本任务不碰 dashboard；这一跑是确认瀑布投影没有对「深度 ≤ 2」的隐含假设）。

- [ ] **Step 8: 提交**

```bash
git add packages/server/src/routes/pipeline/inference-span.ts \
  packages/server/src/routes/pipeline/index.ts \
  packages/server/src/request-tracing/semantic.ts \
  packages/server/src/routes/pipeline/span-tree.test.ts
git commit -m "feat(server): 新增 GenAI CLIENT span 并把 attempt 挂到它下面"
```

---

### Task 6: prepare span + attempt/prepare 顺序重排

**Files:**
- Modify: `packages/server/src/routes/pipeline/attempt/model.ts:24-41`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`

**Interfaces:**
- Consumes: 任务 4 的 `rejectRequestShape` 与 `PreparedInvocation` 的 `'reject'` 分支；任务 5 的 attempt 父 context。
- Produces: `spanName.prepare`（`aio_proxy.request.prepare`，已存在的死常量，本任务让它活过来）挂在 attempt span 下，带 `attributeName.prepareMode`（同样是已存在的死常量）取值 `'materialize' | 'reuse'`。

**这个任务修的是 δ。** `model.ts:24-41` 今天先跑 `prepareModelInvocation()`（里面有一次 `await resolveSupportedEffortsForDimensions` 的目录读取）、`assertCandidateSupported()`、诊断日志，**最后**才 `startAttempt()`。候选循环记的 `startedAt` 与 attempt span 的真实起点之间因此有一段查不到的偏移。上一版方案想用 `tracer.startSpan(name, { startTime })` 回填 —— 那是错的（见 Global Constraints）。**顺序问题用重排顺序解决**：先建 attempt span，prepare 变成它下面一段真实测量的子 span。

`prepareMode` 解释了为什么第二个候选的 prepare 是一条头发丝：invocation 由 `holder` 跨候选记忆化，候选 0 `materialize`，之后全是 `reuse`。

**只有 model 路径开 prepare span。** image / audio / embedding 的 materialize 是一次同步调用（`adapter.imageInvocation(...)` 等），没有 await、没有目录读取，δ 本身就不存在 —— spec 的表里也只给了 `model.ts:24` 这一个代码边界。不要为了「六种能力形状一致」造一个宽度恒为 0 的 span。

**`AttemptInfo` 不加 `startedAt`。** spec 提过一句，但那是回填方案的遗留需求：重排之后 attempt span 的起点就是真起点，span 自带 `startedAt`，再从 `AttemptInfo` 带一份出来没有消费者。

- [ ] **Step 1: 写失败测试**

往 `span-tree.test.ts` 末尾追加（`runFailover` 是任务 5 写的）：

```typescript
test('prepare runs inside the attempt span, not before it', async () => {
  const spans = await runFailover();
  const attempts = spans.filter((span) => span.name === spanName.attempt);
  const prepares = spans.filter((span) => span.name === spanName.prepare);

  expect(prepares).toHaveLength(2);
  expect(prepares.map((span) => span.parentSpanId)).toEqual(attempts.map((span) => span.spanId));
  for (const [index, prepare] of prepares.entries()) {
    const attempt = attempts[index];
    expect(prepare.startedAt.getTime()).toBeGreaterThanOrEqual(attempt?.startedAt.getTime() ?? 0);
    expect(prepare.endedAt.getTime()).toBeLessThanOrEqual(attempt?.endedAt.getTime() ?? 0);
  }
});

test('only the first candidate materializes the invocation', async () => {
  const prepares = (await runFailover()).filter((span) => span.name === spanName.prepare);

  expect(prepares.map((span) => span.attributes[attributeName.prepareMode])).toEqual(['materialize', 'reuse']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: FAIL —— `prepares` 长度是 0。

- [ ] **Step 3: 重排 `model.ts`**

`packages/server/src/routes/pipeline/attempt/model.ts`。import 区补：

```typescript
import { attributeName, spanName } from '../../../request-tracing';
import { startPipelineSpan } from '../tracing';
```

把第 24-41 行（从 `const prepared = await prepareModelInvocation(...)` 到 `slot.spanRef.current = attemptSpan;`）整段替换成：

```typescript
  // The attempt span opens FIRST: prepare is a measured child of it, not an
  // untracked offset between the candidate's startedAt and the span.
  const attemptSpan = ctx.emitter.startAttempt(attemptBase(provider, candidate.modelId, startedAt, slot.trace), index);
  slot.spanRef.current = attemptSpan;

  const prepareSpan = startPipelineSpan(attemptSpan.context, spanName.prepare, {
    attributes: { [attributeName.prepareMode]: holder.invocation === undefined ? 'materialize' : 'reuse' },
  });
  const prepared = await prepareModelInvocation(ctx, slot, model, holder).then(
    (value) => {
      prepareSpan.end(value.kind === 'ok' ? undefined : { outcome: 'failure' });
      return value;
    },
    (error: unknown) => {
      prepareSpan.end({ outcome: 'failure' });
      throw error;
    },
  );
  if (prepared.kind === 'reject') return rejectRequestShape(ctx, slot, prepared);
  if (prepared.kind !== 'ok') return prepared.step;
  const { candidateInvocation, targetProtocol } = prepared;
  // Resolved by prepare, so it cannot be an attribute at span creation.
  if (targetProtocol !== undefined) attemptSpan.span.setAttribute(attributeName.targetProtocol, targetProtocol);

  const unsupported = assertCandidateSupported(ctx, slot, model, candidateInvocation, targetProtocol);
  if (unsupported !== undefined) return unsupported;

  logModelInvocationDiagnostics({
    source,
    requestId: session.requestId,
    rawRequest,
    inboundProtocol: adapter.protocol,
    diagnostics: candidateInvocation.diagnostics ?? [],
    providerId: provider.id,
    attemptIndex: index,
  });
```

要点：

- `const base = ...` 那行没了 —— `base` 原本只喂 `startAttempt`。所有错误路径上的 `attemptBase(...)` 都是各自现算的（`error.ts:37` / `:64`），不受影响。
- prepare 抛错（`requestError` 映射不出来时的 rethrow、`assertImageInputSupported` 的 rethrow）走 `.then` 的第二个回调关 span，再让异常继续往上走。**这条路上不能用 `finally`** 之外的写法偷懒：异常会一路走到候选循环的 catch → `handleAttemptError` → `session.finish()` → `processor.take()`，prepare span 没在那之前关掉就整段消失。
- `assertCandidateSupported` 与诊断日志留在 prepare span**外面**：它们是能力校验与日志，不是 materialize。
- 现在 `rejectRequestShape` 拿到的 `slot.spanRef.current` 是**开着的** attempt span，`error.ts:19` 的 `endAttemptSpan` 会复用它 —— 任务 4 的那条「恰好一个 attempt span」的测试从这一刻起才真正在防事。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: PASS，含任务 4 那条 `a model invocation failure produces exactly one attempt span`。

- [ ] **Step 5: 全量**

Run: `cd packages/server && bun test`
Expected: PASS。重点看 `src/routes/pipeline/selection.test.ts` 与所有断言 `attempts` 数组的测试：顺序重排**不应该**改变任何一条 attempt 记录的字段。若 `targetProtocol` 在某条断言里丢了，说明 Step 3 的 `setAttribute` 补漏了分支。

- [ ] **Step 6: 提交**

```bash
git add packages/server/src/routes/pipeline/attempt/model.ts packages/server/src/routes/pipeline/span-tree.test.ts
git commit -m "feat(server): attempt span 先于 prepare 打开并记录 prepare 子 span"
```

---

### Task 7: 上游 HTTP 的 POST 子 span

attempt span 里最大的一段黑箱是「请求发出去到响应头回来」。这一步给它一个
`SpanKind.CLIENT` 的子 span，名字就是 HTTP 方法（spec:263）。

同时补一个前提：现在 `slot.inAttempt` 只套了响应观测和日志上下文，**没有进入 attempt
span 的 OTel context**，所以 `createObservedFetch` 里 `context.active()` 拿不到 attempt
span，新 span 会变成第二个根。这一步把 `spanRef` 提到 slot 字面量外面，让 `inAttempt`
在 span 已经打开时用 `open.run(...)` 包一层。

**Files:**
- Modify: `packages/server/src/request-tracing/semantic.ts`（新增三个属性名）
- Modify: `packages/server/src/request-logging/wire/wire.ts:41-83`
- Modify: `packages/server/src/routes/pipeline/attempt/attempt.ts:248-278`
- Test: `packages/server/src/request-logging/wire/wire.test.ts`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`

**Interfaces:**
- Consumes: 任务 6 之后 attempt span 在候选调用发生时已经打开（`slot.spanRef.current`）。
- Produces: `attributeName.httpRequestMethod` / `.serverAddress` / `.urlPath`；
  attempt 期间 `context.active()` 里有 attempt span，后续任何 span 默认挂到它下面。

- [ ] **Step 1: 写失败的测试（wire）**

追加到 `packages/server/src/request-logging/wire/wire.test.ts` 末尾：

```ts
test('upstream fetch opens a CLIENT span under the active span', async () => {
  const { processor, tracer } = getTraceRuntime();
  const parent = tracer.startSpan('test.attempt');
  const traceId = parent.spanContext().traceId;
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response(null, { status: 503 }));

  await context.with(trace.setSpan(context.active(), parent), () =>
    withAttemptResponseObservation(observation, () => fetcher('https://upstream.test/v1/chat?key=secret')),
  );
  parent.end();

  const spans = processor.take(traceId);
  const post = spans.find((span) => span.name === 'GET');
  expect(post?.kind).toBe(SpanKind.CLIENT);
  expect(post?.parentSpanId).toBe(parent.spanContext().spanId);
  expect(post?.attributes).toMatchObject({
    'http.request.method': 'GET',
    'server.address': 'upstream.test',
    'url.path': '/v1/chat',
    'http.status_code': 503,
  });
  expect(JSON.stringify(post?.attributes)).not.toContain('secret');
});
```

补两行 import：

```ts
import { context, SpanKind, trace } from '@opentelemetry/api';

import { getTraceRuntime } from '../../request-tracing';
```

测试里 `parent` 是手搓的，不是真 attempt span —— 这条只验「有活跃 span 时挂上去、属性
对、query 不落盘」。「attempt span 是那个活跃 span」由 Step 2 的另一条测试管。

- [ ] **Step 2: 写失败的测试（attempt context）**

追加到 `packages/server/src/routes/pipeline/span-tree.test.ts`：

```ts
test('candidate invocation runs inside the attempt span context', async () => {
  let activeSpanId: string | undefined;
  const primary = modelProvider({
    id: 'primary',
    invoke: () => {
      activeSpanId = trace.getSpan(context.active())?.spanContext().spanId;
      return textStream('ok');
    },
  });
  const route = defineProviderRouteSource([primary]);

  const response = await handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    request: jsonRequest({ model: REQUESTED_MODEL, input: 'ping' }),
    source: route.source,
    sessions: new LogicalSessionStore(),
  });
  await response.text();
  await settleRecording(route.recording);

  const attempt = route.recording.spans.find((span) => span.name === spanName.attempt);
  expect(activeSpanId).toBe(attempt?.spanId);
});
```

import 补 `context`、`trace`（`@opentelemetry/api`）与 `spanName`
（`../../request-tracing`）—— 前几个任务已经引了 `spanName`，按实际情况补差值即可。

这条测试在改 `attempt.ts` 之前失败：`activeSpanId` 会是 request span 的 id（或
`undefined`），不是 attempt span 的。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/server && bun test src/request-logging/wire/wire.test.ts src/routes/pipeline/span-tree.test.ts`
Expected: 两条新测试 FAIL。wire 那条报 `post` 是 `undefined`；span-tree 那条报 id 不等。

- [ ] **Step 4: 加属性名**

`packages/server/src/request-tracing/semantic.ts`，在 `attributeName` 里 `errorType`
一行之前插入：

```ts
  httpRequestMethod: 'http.request.method',
  serverAddress: 'server.address',
  urlPath: 'url.path',
```

`ALLOWED_ATTRIBUTES` 是 `Object.values(attributeName)` 算出来的，不用另外登记。

- [ ] **Step 5: wire.ts 开 span**

`packages/server/src/request-logging/wire/wire.ts`，import 补：

```ts
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';

import { attributeName, getTraceRuntime } from '../../request-tracing';
```

不要 import `routes/pipeline/tracing.ts` 的 `startPipelineSpan`：那是 `routes/pipeline/`
的私有模块，`request-logging/` 不许跨目录进去（CLAUDE.md「File Splitting」）。直接用
tracer 十来行就够。

在文件末尾（`createObservedFetch` 之后、其它 helper 旁边）加：

```ts
// 上游 HTTP 作为 attempt 的 CLIENT 子 span。只在已经有活跃 span 时开：没有父的话
// 它会被当成第二个根 span 落库。span 到响应头为止，body 的时间线由 attempt 上的
// first_upstream_byte_ms / ttft_ms 表达。
async function fetchWithSpan(
  fetcher: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> {
  const parent = context.active();
  if (trace.getSpan(parent) === undefined) return fetcher(input, init);
  const request = typeof input === 'object' && 'url' in input ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const span = getTraceRuntime().tracer.startSpan(
    method,
    {
      kind: SpanKind.CLIENT,
      attributes: { [attributeName.httpRequestMethod]: method, ...targetAttributes(request?.url ?? String(input)) },
    },
    parent,
  );
  try {
    const response = await fetcher(input, init);
    span.setAttribute(attributeName.httpStatusCode, response.status);
    return response;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute(attributeName.errorType, serverErrorType(error));
    throw error;
  } finally {
    span.end();
  }
}

// spec 写的是 url.full，这里只落 host + path：不少供应商把 key 放在 query 里
// （`?key=`），而 span 属性是默认落库并直接渲染到 dashboard 的。
function targetAttributes(href: string): Record<string, string> {
  try {
    const url = new URL(href);
    return { [attributeName.serverAddress]: url.host, [attributeName.urlPath]: url.pathname };
  } catch {
    return {};
  }
}
```

`serverErrorType` 文件里已经引了（`wire.ts:7`）。

然后把早退之后的两个 `fetcher(...)` 调用换掉，**早退那行（`wire.ts:58`）不动** —— 那
条路上既没有 observation 也没有 debug scope，本来就不是一次候选尝试：

```ts
    // wire.ts:62
    const response = await fetchWithSpan(fetcher, input, init);
```

```ts
    // wire.ts:83
    const response = await fetchWithSpan(fetcher, delegated, decompress === undefined ? undefined : { decompress });
```

- [ ] **Step 6: attempt.ts 让 inAttempt 进 span context**

`packages/server/src/routes/pipeline/attempt/attempt.ts`。把 `spanRef` 从 slot 字面量里
（`:277`）提到 `const slot: CandidateSlot = {` **之前**，再让 `inAttempt` 用它：

```ts
    const spanRef: CandidateSlot['spanRef'] = { current: undefined };
    const slot: CandidateSlot = {
      index,
      candidate,
      startedAt,
      observation,
      hasNext: index < live.length - 1,
      trace: {
        ...candidateRoutingTrace(candidate, candidateSelectionSource(candidate, resolution)),
        sourceProtocol: adapter.protocol,
        selectionReason,
      },
      inAttempt: <T>(targetProtocol: CandidateSlot['trace']['targetProtocol'], operation: () => T): T => {
        const open = spanRef.current;
        return withAttemptResponseObservation(observation, () =>
          withAttemptLogContext(
            {
              attemptIndex: index,
              providerId: provider.id,
              modelId: candidate.modelId,
              requestedModelId: options.requestedModelId,
              sourceProtocol: adapter.protocol,
              ...(targetProtocol === undefined ? {} : { targetProtocol }),
            },
            open === undefined ? operation : () => open.run(operation),
          ),
        );
      },
      spanRef,
    };
```

要点：

- `const open = spanRef.current` 读在 `inAttempt` **被调用时**，不是 slot 构造时 ——
  构造时 span 还没开。
- `open === undefined` 的分支保留：任务 6 只让 model 路径先开 span，raw 路径与
  image/audio/embedding 路径里 `inAttempt` 可能先于 span 被调用，那时行为和现在完全一致。
- 顺序是「观测 → 日志 → OTel context」，最内层是 `operation`。三者互不相干，这个嵌套
  顺序只是让 diff 最小。

raw / image / audio / embedding 四条路已经是「先开 span 再调 provider」
（`raw.ts:55`、`image.ts:81`、`audio.ts:102`、`embedding.ts:75`），加上任务 6 的 model
路，`inAttempt` 被调用时 span 基本都已经开着 —— 真正的上游 HTTP 都发生在这之后。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd packages/server && bun test src/request-logging/wire/wire.test.ts src/routes/pipeline/span-tree.test.ts`
Expected: PASS。

- [ ] **Step 8: 全量**

Run: `cd packages/server && bun test`
Expected: PASS。重点看 `src/request-logging/wire/`、`src/provider-runtime/` 下的
observed-fetch 测试：第一条 `non-debug fetch preserves the original input and init`
必须继续过 —— 它走的是早退分支，`fetchWithSpan` 不该碰它。

- [ ] **Step 9: 提交**

```bash
git add packages/server/src/request-tracing/semantic.ts packages/server/src/request-logging/wire/wire.ts packages/server/src/request-logging/wire/wire.test.ts packages/server/src/routes/pipeline/attempt/attempt.ts packages/server/src/routes/pipeline/span-tree.test.ts
git commit -m "feat(server): 上游 HTTP 记为 attempt 下的 CLIENT span"
```

---

### Task 8: root 卸货 —— `gen_ai.*` 不再挂在 root 上

spec「属性 / root」那节：root 发射时只剩纯 HTTP。今天 `completion.ts:24-56` 把
`gen_ai.request.model` / `gen_ai.response.model` / 整套 `gen_ai.usage.*` 写在 root 上。

先把事实理清楚，不然会改错地方：

- 这些属性写到 root 后**并不会**留在 root 的 attributes JSON 里。
  `span-projection.ts:83-160` 的 `projectAttributes` 把它们抽进 typed column，
  只有 `remaining` 入库。
- 读回时 `mergeAttributes`（`:195-232`）再按同名 key 挂回去 —— dashboard 上 root 行
  带着 `gen_ai.*`，是这一步造出来的。
- root 行的 usage / finalModelId 列**本来就**来自 summary
  （`trace-lifecycle.ts:112-135` 的 `terminalColumns`），不靠属性。
  唯一靠属性喂的是 `requestedModelId`（`span-projection.ts:153`）。

所以这一步要动三处：删 setter、把 `requestedModelId` 改成从 summary 取、读回时别再挂。
**只删 setter 会让首页列表和筛选丢掉 requested model。**

**Files:**
- Modify: `packages/server/src/request-tracing/request-trace-recorder/completion.ts:24,40,46-57`
- Modify: `packages/core/src/db/trace-store/trace-lifecycle/trace-lifecycle.ts:111-135`
- Modify: `packages/core/src/db/trace-store/span-projection/span-projection.ts:150-155,195-232`
- Test: `packages/core/src/db/trace-store/trace-store.test.ts`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`

**Interfaces:**
- Consumes: 任务 5 的 GenAI span（`gen_ai.request.model` 从这一步起只在它身上）。
- Produces: root span 读回后不含任何 `gen_ai.*`；`DashboardTraceSummary.requestedModelId`
  改由 `completion.session.requestedModelId` 供给，字段与类型不变。

- [ ] **Step 1: 写失败的测试（core 读回）**

追加到 `packages/core/src/db/trace-store/trace-store.test.ts`（放在
`'projects root stream intent and TTFT into trace summaries'` 那条旁边）：

```ts
test('keeps gen_ai attributes off the root span while summaries stay intact', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    store.startRoot(rootStart());
    store.complete(
      completion({
        spans: [rootSpan()],
        session: {
          identity: { source: 'body-session', id: 'session-a' },
          requestedModelId: 'my-alias',
          resolvedBy: 'body-session',
        },
        summary: {
          finalProviderId: 'provider-b',
          finalModelId: 'upstream-model',
          usage: { providerId: 'provider-b', modelId: 'upstream-model', inputTokens: 11, totalTokens: 12 },
        },
      }),
    );

    const found = store.find(TRACE_ID);
    const root = found?.spans.find((span) => span.spanId === ROOT_SPAN_ID);
    expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
    expect(found?.trace).toMatchObject({
      requestedModelId: 'my-alias',
      finalModelId: 'upstream-model',
      usage: expect.objectContaining({ inputTokens: 11 }),
    });
  } finally {
    handle.close();
  }
});
```

故意用默认的 `rootSpan()`：它的默认 attributes 里就有
`'gen_ai.response.model': 'model-b'`（`trace-store.test-support.ts:44`）。写入时它会被
`projectAttributes` 抽进 `finalModelId` 列、不留在 JSON 里，所以这条断言测的正是
「读回时不再凭列挂回去」——而不是「输入里本来就没有」。`rootSpan` 的默认值不要改，
别的测试依赖它。summary 里的 `finalModelId: 'upstream-model'` 会盖掉列里的 `model-b`
（`terminalColumns` 的展开顺序），断言按 summary 的值写。

- [ ] **Step 2: 写失败的测试（server 发射侧）**

追加到 `packages/server/src/routes/pipeline/span-tree.test.ts`：

```ts
test('the root span carries no gen_ai attributes', async () => {
  const { spans } = await runOnce();

  const root = spans.find((span) => span.name === spanName.request);
  expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
  const inference = spans.find((span) => span.name !== spanName.request && span.parentSpanId === root?.spanId);
  expect(inference?.attributes[attributeName.genAiRequestModel]).toBe(REQUESTED_MODEL);
});
```

第二条断言是防「把属性删干净了但没留在 GenAI span 上」。GenAI span 的名字是
`{operation} {model}` 动态拼的，所以按父子关系找，不按名字找。

- [ ] **Step 3: 跑测试确认失败**

Run: `cd packages/core && bun test src/db/trace-store/trace-store.test.ts` 与
`cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: 两条新测试 FAIL —— core 那条报 root 上有 `gen_ai.response.model` 与
`gen_ai.usage.*`；server 那条报 root 上有 `gen_ai.request.model`。

- [ ] **Step 4: 删 root 上的 setter**

`packages/server/src/request-tracing/request-trace-recorder/completion.ts`：

- 删掉 `:24` 的 `if (finalModelId !== undefined) root.setAttribute(attributeName.genAiResponseModel, finalModelId);`
- 删掉 `:27` 的 `if (finish.outcome === 'success' && finish.usage !== undefined) applyUsageAttributes(root, finish.usage);`
  以及整个 `applyUsageAttributes` 函数（`:46-58`）和 `UsageRow` import。
- `:40` 的 `root.setAttribute(attributeName.genAiRequestModel, identity.requestedModelId);` 删掉，
  **同一个 if 里的三行 session 属性保留**。

`finalModelId` 这个局部变量删了之后 `applyTerminalAttributes` 里就没人用了（`:23` 的
`finalProviderId` 还在用），把它一起删掉；`buildCompletion` 里那份同名计算是独立的，不要动。

- [ ] **Step 5: `requestedModelId` 改由 summary 喂列**

`packages/core/src/db/trace-store/trace-lifecycle/trace-lifecycle.ts`，`terminalColumns`
里（`:113` 的 `terminationReason` 那行之前）插一行：

```ts
      ...(input.session?.requestedModelId !== undefined ? { requestedModelId: input.session.requestedModelId } : {}),
```

条件和原来 recorder 里那个 setter 等价：`completion.session` 只在
`identity.resolution !== undefined && identity.requestedModelId !== undefined` 时才存在
（`completion.ts:88-97`）。这一步严格更正确 —— 列的语义是「用户请求的模型」，
summary 就是它的源头，绕道 span 属性只是历史。

- [ ] **Step 6: 读回不再挂 `gen_ai.*`**

`packages/core/src/db/trace-store/span-projection/span-projection.ts`。

`projectAttributes` 里 `gen_ai.request.model` 那条（`:150-155` 附近）改成只在 root 投列：
非 root 时留在 `remaining` 里。GenAI span 需要这个 key 原样出现在自己的属性上，
而 root 已经不发它了。

```ts
      case ATTR.genAiRequestModel:
        // 只有 root 需要它入列（喂 requestedModelId，旧数据兼容）。GenAI span 上
        // 这个 key 就是它自己的属性，原样留在 JSON 里。
        if (isRoot) {
          setStr('requestedModelId', value);
        } else {
          remaining[key] = value;
        }
        break;
```

这是 `for...of` 里的一个 `case`，所以「不投列」的写法是显式 `remaining[key] = value`，
不是 `return` —— `default` 分支够不着它。

`mergeAttributes` 里把六个 usage / model 的 `set(...)` 用 root 判断包起来：

```ts
  // root 的 usage / model 列来自 summary，不是它自己的属性。挂回去会让 root 变成
  // 第二个「带 gen_ai.* 的 span」，Langfuse 那边一条 trace 就出现两个 GENERATION。
  if (!isRoot) {
    set(ATTR.genAiRequestModel, columns.modelId);
    set(ATTR.genAiResponseModel, columns.finalModelId);
    set(ATTR.genAiUsageInputTokens, columns.inputTokens);
    set(ATTR.genAiUsageOutputTokens, columns.outputTokens);
    set(ATTR.genAiUsageTotalTokens, columns.totalTokens);
    set(ATTR.genAiUsageCacheReadTokens, columns.cacheReadTokens);
    set(ATTR.genAiUsageCacheWriteTokens, columns.cacheWriteTokens);
    set(ATTR.genAiUsageReasoningTokens, columns.reasoningTokens);
  }
```

原来那行 `set(ATTR.genAiRequestModel, isRoot ? columns.requestedModelId : columns.modelId);`
的 root 分支就此消失 —— 三元没了，`isRoot` 只剩这一个用途。

- [ ] **Step 7: 跑测试**

Run: `cd packages/core && bun test src/db/trace-store/` 然后
`cd packages/server && bun test src/request-tracing/ src/routes/pipeline/`
Expected: PASS。会红的老测试与改法：

- `span-projection` 自己的单测里若有「root 读回带 `gen_ai.usage.*`」的断言，
  改成断言它**不**带，并在同一条里断言 attempt/GenAI span 仍然带。
- `request-trace-recorder.test.ts` 里断言 root attributes 的用例（`:291-305` 一带）
  若列了 `gen_ai.*`，删掉那几个 key，其余断言不动。
- dashboard 不用改：`span-metrics.ts:56-68` 对 root 早就有
  `?? trace.finalModelId` / `?? trace.usage?.inputTokens` 的兜底，属性没了就走 summary。

- [ ] **Step 8: 全量**

Run: `bun run preflight`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add packages/server/src/request-tracing/request-trace-recorder/completion.ts packages/core/src/db/trace-store packages/server/src/routes/pipeline/span-tree.test.ts
git commit -m "refactor(core): gen_ai 属性不再挂在 root span 上"
```

---

### Task 9: GenAI span 落属性 —— 标准 usage 名、response model / id、TTFT（秒）

**Files:**
- Modify: `packages/server/src/request-tracing/semantic.ts:64-71`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/types.ts:13-20`
- Modify: `packages/server/src/usage-capture/shared.ts:10-13,89-95`
- Modify: `packages/server/src/routes/pipeline/attempt/emit/emit.ts` 的 `settleSuccess`（任务 2 把 `emit.ts` 拆成了同名目录，行号已变，按函数名定位）
- Modify: `packages/server/src/routes/pipeline/inference-span.ts`（任务 5 建的文件）
- Modify: `packages/core/src/db/trace-store/span-projection/span-projection.ts:33-35`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`

**Interfaces:**
- Consumes: 任务 5 的 `startInferenceSpan` / `InferenceSpan`；任务 8 之后 root 上已经没有
  `gen_ai.*`，这一层是它们唯一的落点。
- Produces:
  - `attributeName.genAiResponseId = 'gen_ai.response.id'`、
    `attributeName.genAiTimeToFirstChunk = 'gen_ai.response.time_to_first_chunk'`。
  - 三个 usage key 改值（常量名不变，任务 10、11 继续用这些常量名）：
    `genAiUsageCacheReadTokens = 'gen_ai.usage.cache_read.input_tokens'`、
    `genAiUsageCacheWriteTokens = 'gen_ai.usage.cache_write.input_tokens'`、
    `genAiUsageReasoningTokens = 'gen_ai.usage.reasoning.output_tokens'`。
  - `RequestTraceFinishInput` 基类新增 `readonly firstChunkAt?: number`（`performance.now()`
    时间戳，不是时长）。任务 10 不读它。

**这个任务干两件事：** 把 spec 里 GenAI span 那张表上还没人写的属性写上；把四个自造的
`gen_ai.usage.*` 换成 1.43.0 的标准名。语义约定里 cache / reasoning 是**带模态后缀**的
（`cache_read.input_tokens` 而不是 `cache_read_tokens`），今天这四个名字是照着直觉编的，
任何按标准名聚合的后端都读不到。

**`gen_ai.response.time_to_first_chunk` 要的是「从本 span 起点算」，不是 attempt 那个数。**
（spec 那张对照表：两个 TTFT 不是同一个量。）今天全链路只有 `ttftMs` 这个**时长**在传，
起点是那次 attempt 的 dispatch 时刻 —— 直接除以 1000 写上去等于把失败转移的耗时抹掉，
还把同一个数用两个标准名存了两份。所以这里加一个 `firstChunkAt` 绝对时间戳：
`ttftProperty()` 是**全部** 13 个结算点唯一的 ttft 来源（都是 `...ttftProperty(...)` 展开），
改它一个函数就够，不用碰任何一个结算点。

**不做的三个（记进「与 spec 的偏差」）：** `gen_ai.provider.name`（语义约定给的是
`openai`/`anthropic` 这种固定枚举，我们手上只有 provider id 和 protocol，映射不干净）、
`gen_ai.request.stream`（不是约定里的属性，root 上的 `aio_proxy.request.stream` 已经覆盖）、
`gen_ai.response.finish_reasons`（全链路没有任何地方捕获 finish reason，属于新采集，不在本 PR）。

- [ ] **Step 1: 写失败测试**

`packages/server/src/routes/pipeline/span-tree.test.ts`。顶部 import 补
`import type { TextStreamPart, ToolSet } from '@aio-proxy/core';`，然后追加：

```typescript
// 自带非零 usage 的流。pipeline-helpers 的 textStream() 报的是全 0 usage，
// 断不出「哪个 key 拿到了哪个数」。
function usageStream(): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream<TextStreamPart<ToolSet>>({
    start(controller) {
      controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'ok' });
      controller.enqueue({
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: {
          inputTokenDetails: { cacheReadTokens: 7, cacheWriteTokens: 3, noCacheTokens: 11 },
          inputTokens: 21,
          outputTokenDetails: { reasoningTokens: 5, textTokens: 9 },
          outputTokens: 14,
          totalTokens: 35,
        },
      });
      controller.close();
    },
  });
}

async function runWithUsage() {
  const harness = pipeline([modelProvider({ id: 'primary', invoke: usageStream })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  const spans = harness.recording.spans;
  const root = spans.find((span) => span.name === spanName.request);
  return spans.find((span) => span.name !== spanName.request && span.parentSpanId === root?.spanId);
}
```

同一个文件接着追加三条 test：

```typescript
test('the GenAI span carries usage under the standard gen_ai names', async () => {
  const inference = await runWithUsage();

  expect(inference?.attributes[attributeName.genAiUsageInputTokens]).toBe(21);
  expect(inference?.attributes[attributeName.genAiUsageOutputTokens]).toBe(14);
  expect(inference?.attributes[attributeName.genAiUsageTotalTokens]).toBe(35);
  expect(inference?.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(7);
  expect(inference?.attributes['gen_ai.usage.cache_write.input_tokens']).toBe(3);
  expect(inference?.attributes['gen_ai.usage.reasoning.output_tokens']).toBe(5);
  // 旧的自造名一个都不许剩下。
  expect(inference?.attributes['gen_ai.usage.cache_read_tokens']).toBeUndefined();
});

test('the GenAI span carries the model the upstream actually answered with', async () => {
  const inference = await runWithUsage();

  expect(inference?.attributes[attributeName.genAiRequestModel]).toBe(REQUESTED_MODEL);
  expect(inference?.attributes[attributeName.genAiResponseModel]).toBe('primary-model');
});

test('time_to_first_chunk is measured in seconds from the GenAI span start', async () => {
  const inference = await runWithUsage();
  const chunk = inference?.attributes['gen_ai.response.time_to_first_chunk'];

  expect(typeof chunk).toBe('number');
  // 秒。同一段时间写成毫秒会是这个数的 1000 倍，一个单测里的请求不可能跑满 1 秒。
  expect(chunk as number).toBeLessThan(1);
  expect(chunk as number).toBeGreaterThan(0);
});
```

两处写死的字面量要注意：

- `'primary-model'` 是 `modelProvider({ id: 'primary' })` 的默认上游 model id
  （`providers.ts:87` 的 `options.modelId ?? \`${options.id}-model\``）。
- 六个 usage 数字走的是**真实**的 `createUsageCapture().stream()`（fake source 只在
  `immediateStreamCompletion` 给了的时候才短路，这里没给），所以万一定价/校验那层对
  `inputTokens` 做了归一，以第一次跑出来的实际值为准改断言 —— 这三条测的是
  **key 名对不对、数落没落到 GenAI span 上**，不是算术。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: 三条全 FAIL —— GenAI span 上现在一个 usage 属性都没有（任务 8 刚把它们从 root
删掉，还没人在这层写回来），`gen_ai.response.model` 和 `time_to_first_chunk` 同样是
`undefined`。

- [ ] **Step 3: 改属性名、加两个常量**

`packages/server/src/request-tracing/semantic.ts`，`attributeName` 里第 69-71 行三行换值，
后面补两行：

```typescript
  genAiUsageCacheReadTokens: 'gen_ai.usage.cache_read.input_tokens',
  genAiUsageCacheWriteTokens: 'gen_ai.usage.cache_write.input_tokens',
  genAiUsageReasoningTokens: 'gen_ai.usage.reasoning.output_tokens',
  genAiResponseId: 'gen_ai.response.id',
  // double，单位秒。约定里只有 gen_ai.inference.client 这个 group 引用它，
  // 没有共享常量可 import，所以和这张表里其它标准 key 一样写死。
  genAiTimeToFirstChunk: 'gen_ai.response.time_to_first_chunk',
```

常量**名**一个都不动（`genAiUsageCacheReadTokens` 还是这个名），只换字符串值，
所以引用处不用跟着改。`ALLOWED_ATTRIBUTES` 自动跟上。

`packages/core/src/db/trace-store/span-projection/span-projection.ts` 的 `ATTR`
第 33-35 行换成一样的三个值。这个 map 的注释（`:5-7`）明写了「要和 recorder 的
`attributeName` 逐字一致」—— 只改一边，落库时 usage 就投不进列，dashboard 的 token 数直接消失。

- [ ] **Step 4: 让结算带上「第一个 chunk 的时刻」**

`packages/server/src/usage-capture/shared.ts`。三个 union 分支（`:10-13`）各加一个字段：

```typescript
export type UsageCompletion =
  | {
      readonly outcome: 'success';
      readonly usage?: UsageRow;
      readonly statusCode?: number;
      readonly ttftMs?: number;
      readonly firstChunkAt?: number;
    }
  | {
      readonly outcome: 'failure';
      readonly statusCode?: number;
      readonly errorCode?: string;
      readonly ttftMs?: number;
      readonly firstChunkAt?: number;
    }
  | { readonly outcome: 'cancelled'; readonly statusCode?: number; readonly ttftMs?: number; readonly firstChunkAt?: number };
```

同文件 `ttftProperty`（`:89-95`）改成同时给出时刻：

```typescript
export function ttftProperty(
  startedAt: number | undefined,
  firstTokenAt: number | undefined,
): { readonly ttftMs?: number; readonly firstChunkAt?: number } {
  if (startedAt === undefined || firstTokenAt === undefined) return {};
  // ttftMs 的起点是这次 attempt 的 dispatch；firstChunkAt 是 performance.now() 的
  // 绝对时刻，给起点不同的上层（GenAI span 从自己的起点算）自己去减。
  return { firstChunkAt: firstTokenAt, ttftMs: Math.max(0, Math.round(firstTokenAt - startedAt)) };
}
```

13 个结算点全部是 `...ttftProperty(startedAt, firstTokenAt)` 展开的，一个都不用碰。

`packages/server/src/request-tracing/request-trace-recorder/types.ts`，
`RequestTraceFinishBase`（`:13-20`）里 `ttftMs` 那行之后加：

```typescript
  /** performance.now() at the first chunk, not a duration; spans subtract their own start. */
  readonly firstChunkAt?: number;
```

`packages/server/src/routes/pipeline/attempt/emit/emit.ts` 的 `settleSuccess`，
在 `...(ttftMs === undefined ? {} : { ttftMs }),` 下面加一行：

```typescript
          ...(value.firstChunkAt === undefined ? {} : { firstChunkAt: value.firstChunkAt }),
```

三个分支都声明了这个字段，所以不需要 `'firstChunkAt' in value` 那种守卫。

- [ ] **Step 5: GenAI span 写属性**

`packages/server/src/routes/pipeline/inference-span.ts`。import 区补
`import type { UsageRow } from '@aio-proxy/types';`，并把 `SpanKind` 那行改成
`import { type Attributes, SpanKind } from '@opentelemetry/api';`。

`inferenceTerminal` 下面加两个纯函数：

```typescript
// 本 span 自己的 TTFT：从**本 span 起点**到第一个 chunk，单位秒。因此它把「失败转移
// 烧掉的时间」算在内 —— 和 attempt span 上那个以本次 attempt 起点为原点的毫秒数
// 不是同一个量，别互相代入。
function inferenceAttributes(input: RequestTraceFinishInput, startedAt: number): Attributes {
  const usage = input.outcome === 'success' ? input.usage : undefined;
  return {
    ...(input.finalModelId === undefined ? {} : { [attributeName.genAiResponseModel]: input.finalModelId }),
    ...(input.outcome === 'success' && input.responseId !== undefined
      ? { [attributeName.genAiResponseId]: input.responseId }
      : {}),
    ...(input.firstChunkAt === undefined
      ? {}
      : { [attributeName.genAiTimeToFirstChunk]: Math.max(0, input.firstChunkAt - startedAt) / 1000 }),
    ...(usage === undefined ? {} : usageAttributes(usage)),
  };
}

function usageAttributes(usage: UsageRow): Attributes {
  const pairs: ReadonlyArray<readonly [string, number | undefined]> = [
    [attributeName.genAiUsageInputTokens, usage.inputTokens],
    [attributeName.genAiUsageOutputTokens, usage.outputTokens],
    [attributeName.genAiUsageTotalTokens, usage.totalTokens],
    [attributeName.genAiUsageCacheReadTokens, usage.cacheReadTokens],
    [attributeName.genAiUsageCacheWriteTokens, usage.cacheWriteTokens],
    [attributeName.genAiUsageReasoningTokens, usage.reasoningTokens],
  ];
  return Object.fromEntries(pairs.filter(([, value]) => value !== undefined));
}
```

`startInferenceSpan` 里：函数体第一行（`const genAiOperation = ...` 之前）加
`const startedAt = performance.now();`，然后在 `return {` 之前加一个结算辅助：

```typescript
  // 属性必须在 end 之前落：span 结束后 setAttributes 会被丢弃，而 buffering
  // processor 在 onEnd 就把记录拷走了。
  const settle = (input: RequestTraceFinishInput): void => {
    open.span.setAttributes(inferenceAttributes(input, startedAt));
    open.end(inferenceTerminal(input));
  };
```

把任务 5 写下的两处 `open.end(inferenceTerminal(input));`（`finish` 里一处、`finishFrom`
的成功回调里一处）都换成 `settle(input);`。失败回调那处 `open.end({ outcome: 'failure' })`
不动 —— 异常穿透时没有 finish input，什么属性都写不出来。

- [ ] **Step 6: 跑测试**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts src/usage-capture/` 然后
`cd packages/core && bun test src/db/trace-store/`
Expected: PASS。

`gen_ai.response.id` 这条没有测试覆盖：pipeline 的 fake passthrough
（`providers.ts:135-140`）从不回 response id，model 路径也没有，造一个够真的 fixture
比这一行本身贵得多。它读的是 `finish.responseId` —— 和 `completion.ts:105` 喂
`sessionState.responseId` 的是同一个字段，那条路径已有测试。

- [ ] **Step 7: 全量**

Run: `bun run preflight`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add packages/server/src/request-tracing/semantic.ts packages/server/src/request-tracing/request-trace-recorder/types.ts packages/server/src/usage-capture/shared.ts packages/server/src/routes/pipeline/attempt/emit packages/server/src/routes/pipeline/inference-span.ts packages/server/src/routes/pipeline/span-tree.test.ts packages/core/src/db/trace-store/span-projection/span-projection.ts
git commit -m "feat(server): GenAI span 落标准 gen_ai 属性"
```

---

### Task 10: attempt 的命名禁区 + `http.response.status_code`

**Files:**
- Modify: `packages/server/src/request-tracing/semantic.ts:44,73`
- Modify: `packages/server/src/routes/pipeline/attempt/emit/emit.ts` 的 `startAttempt` 与 `endAttempt`（任务 2 把 `emit.ts` 拆成了同名目录，行号已变，按函数名定位）
- Modify: `packages/server/src/routes/token-count/shared.ts:34-40`
- Modify: `packages/core/src/db/trace-store/span-projection/span-projection.ts`
- Modify: `packages/dashboard/src/modules/traces/lib/trace-attribute-names/trace-attribute-names.ts`
- Modify: `packages/dashboard/src/modules/traces/lib/span-metrics/span-metrics.ts:51-62`
- Modify: `packages/server/__tests__/trace-recording.test-support.ts:78`
- Test: `packages/server/src/routes/pipeline/span-tree.test.ts`
- Test: `packages/dashboard/src/modules/traces/lib/span-metrics/span-metrics.test.ts`

**Interfaces:**
- Consumes: 任务 9 之后 GenAI span 已经是 `gen_ai.*` 的唯一落点。
- Produces:
  - `attributeName.attemptModelId = 'aio_proxy.attempt.model_id'`（投进 `modelId` 列）、
    `attributeName.attemptTtftMs = 'aio_proxy.attempt.ttft_ms'`。
  - `attributeName.httpStatusCode` 值改为 `'http.response.status_code'`（常量名不变）。
  - dashboard `traceAttribute` 新增 `attemptModelId` / `attemptTtftMs` /
    `legacyHttpStatusCode` / `legacyTtftMs`，任务 12 的瀑布图读它们。

**禁区的意思是：attempt span 上不许出现任何 `gen_ai.*`。** 今天 attempt 带
`gen_ai.response.model`（`emit.ts:52`、`token-count/shared.ts:37`），于是一条 trace 里
有 1 个 root + N 个 attempt 都长得像 GenAI span —— Langfuse 的 Priority 3 分类会把每个
attempt 都算成一次 GENERATION，token 数按 N 倍算。attempt 不是 GenAI span，它是 aio-proxy
自己的转移机制，属性该用自己的命名空间。

**TTFT 也在这次分家。** attempt 上今天写的是 `attributeName.ttftMs`
（`'aio_proxy.response.ttft_ms'`），和 root 上那个请求级的数共用一个 key。root 那份要留着
—— `rowToSummary` 靠它喂列表页的 TTFT 列；attempt 那份换成 `aio_proxy.attempt.ttft_ms`，
和任务 9 的 `gen_ai.response.time_to_first_chunk` 各算各的原点。

**`http.status_code` 是 2023 年就废弃的名字**，现行约定是 `http.response.status_code`。
旧数据落库时用的是老 key，所以 dashboard 那边保留一条 `??` 兜底，不做数据迁移。
- [ ] **Step 1: 写失败测试（server）**

往 `packages/server/src/routes/pipeline/span-tree.test.ts` 末尾追加（`usageStream` 是任务 9
写在这个文件里的辅助）：

```typescript
test('the attempt span stays out of the gen_ai namespace', async () => {
  const harness = pipeline([modelProvider({ id: 'primary', invoke: usageStream })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  const attempt = harness.recording.spans.find((span) => span.name === spanName.attempt);

  // 一条 trace 里只许有一个 span 长得像 GenAI span，否则 token 数按 attempt 数翻倍。
  expect(Object.keys(attempt?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
  expect(attempt?.attributes[attributeName.attemptModelId]).toBe('primary-model');
  expect(typeof attempt?.attributes[attributeName.attemptTtftMs]).toBe('number');
});
```

`'primary-model'` 是 `modelProvider({ id: 'primary' })` 的默认 modelId
（`__tests__/pipeline-helpers/providers.ts:96` 的 `${options.id}-model`），不是上游回的
response model —— 后者是任务 9 那三条 test 断言 GenAI span 用的。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/server && bun test src/routes/pipeline/span-tree.test.ts`
Expected: FAIL —— 先是 `attributeName.attemptModelId` 不存在（TS 报错），之后是
attempt 上还有 `gen_ai.response.model`。

- [ ] **Step 3: 三个常量**

`packages/server/src/request-tracing/semantic.ts`。`attemptIndex` 那一族里加两个：

```ts
  attemptModelId: 'aio_proxy.attempt.model_id',
  attemptTtftMs: 'aio_proxy.attempt.ttft_ms',
```

`:73` 那行改值（常量名不动，所有引用点都是通过常量拿的）：

```ts
  httpStatusCode: 'http.response.status_code',
```

`ttftMs: 'aio_proxy.response.ttft_ms'` **留着别删** —— root 上那份是请求级 TTFT，
`packages/core/src/db/trace-store/trace-queries.ts:83` 的 `rowToSummary` 按字面量从 root 行
读它，喂列表页的 TTFT 列。改名会让整列变空。

- [ ] **Step 4: 两个发射点改名**

`packages/server/src/routes/pipeline/attempt/emit/emit.ts`，`startAttempt` 的属性对象里：

```ts
        [attributeName.attemptModelId]: base.modelId,
```

（原来是 `[attributeName.genAiResponseModel]: base.modelId` —— 名字本来就是错的：
`base.modelId` 是候选配置里的模型，不是上游回的 response model。）

同一个文件 `endAttempt` 里任务 2 加的那行换常量：

```ts
    if (snapshot.firstContentMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.attemptTtftMs, snapshot.firstContentMs);
    }
```

`emit.test.ts`（任务 2 建的）那条断言跟着换：
`expect(attempt?.attributes[attributeName.attemptTtftMs]).toBe(60);`。

`packages/server/src/routes/token-count/shared.ts` 的 `countIdentityAttributes` 里同一处改名：

```ts
      [attributeName.attemptModelId]: attempt.modelId,
```

token-count 的 attempt span 不是 GenAI span（它不生成 token，只数 token），禁区同样适用。

- [ ] **Step 5: `modelId` 列换喂养源**

`packages/core/src/db/trace-store/span-projection/span-projection.ts`。`ATTR` 里
`attemptIndex` 那行后面加：

```ts
  attemptModelId: 'aio_proxy.attempt.model_id',
```

`projectAttributes` 的 switch 里，`case ATTR.attemptIndex` 之后加：

```ts
      case ATTR.attemptModelId:
        setStr('modelId', value);
        break;
```

`mergeAttributes` 里任务 8 那个 `if (!isRoot) { ... }` 块的第一行改成：

```ts
    set(ATTR.attemptModelId, columns.modelId);
```

任务 8 之后 `gen_ai.request.model` 在非 root 上已经原样留在 `remaining` 里，所以
`modelId` 列和 GenAI span 的 `gen_ai.request.model` 从此互不相干：列是 attempt 的
候选模型，属性是 GenAI span 自己的请求模型。

**旧数据的代价说清楚：** 库里已有的 attempt 行，`modelId` 列早就填好了（旧的
`gen_ai.response.model` 投的），读回时会按新 key 挂回去 —— dashboard 读
`attemptModelId` 就能看到。没写过 `aio_proxy.attempt.model_id` 的旧 span 不需要迁移。

- [ ] **Step 6: 两处写死的字面量**

`packages/server/__tests__/trace-recording.test-support.ts` 的 `toAttempt`（`:76-80`）：

```ts
  const statusCode = num(attrs, 'http.response.status_code');
  ...
    modelId: str(attrs, 'aio_proxy.attempt.model_id') ?? '',
```

这个文件故意用字面量（它是「从 dashboard 视角读回」的模拟，走常量就测不出改名事故），
所以这里必须手动同步。

- [ ] **Step 7: 写失败测试（dashboard）**

`packages/dashboard/src/modules/traces/lib/span-metrics/span-metrics.test.ts`。

第一条 test（`'reads provider, model, and latency straight off an attempt span'`）的
attributes 换成新 key —— 它现在代表「新版 attempt span」：

```ts
    attributes: {
      'http.response.status_code': 429,
      'aio_proxy.provider.id': 'anthropic-primary',
      'aio_proxy.attempt.model_id': 'claude-sonnet-4-6-20260101',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 34,
      'aio_proxy.attempt.ttft_ms': 900,
      'aio_proxy.response.upstream_headers_ms': 640,
    },
```

`toEqual` 里的期望值一个都不用改。再追加一条兜底 test：

```ts
test('still reads the legacy attempt keys recorded before the rename', () => {
  const span = createSpan({
    parentSpanId: trace.rootSpanId,
    attributes: {
      'http.status_code': 503,
      'gen_ai.response.model': 'claude-sonnet-4-6-20260101',
      'aio_proxy.response.ttft_ms': 700,
    },
  });
  const metrics = readSpanMetrics({ span, spans: [span], trace });

  expect(metrics.httpStatus).toBe(503);
  expect(metrics.modelId).toBe('claude-sonnet-4-6-20260101');
  expect(metrics.ttftMs).toBe(700);
});
```

库里现存的 trace 全是老 key 写的，不迁移数据 —— 兜底就是迁移。

- [ ] **Step 8: 跑测试确认失败**

Run: `cd packages/dashboard && bun run test:unit src/modules/traces/lib/span-metrics`
Expected: 第一条 FAIL（`httpStatus` / `modelId` / `ttftMs` 变 `undefined`），第二条 PASS
（它读的全是今天的 key）。

- [ ] **Step 9: 加 key + 兜底链**

`packages/dashboard/src/modules/traces/lib/trace-attribute-names/trace-attribute-names.ts`：

```ts
  attemptModelId: 'aio_proxy.attempt.model_id',
  attemptTtftMs: 'aio_proxy.attempt.ttft_ms',
  ttftMs: 'aio_proxy.response.ttft_ms',
  upstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
  httpStatusCode: 'http.response.status_code',
  legacyHttpStatusCode: 'http.status_code',
```

`ttftMs` 保留不是为了兜底而已 —— root span 上那份请求级 TTFT 今天仍然用这个 key。

`span-metrics.ts` 三处兜底：

```ts
    httpStatus:
      numberAttribute(attributes, traceAttribute.httpStatusCode) ??
      numberAttribute(attributes, traceAttribute.legacyHttpStatusCode),
    ...
    modelId:
      stringAttribute(attributes, traceAttribute.attemptModelId) ??
      stringAttribute(attributes, traceAttribute.responseModel) ??
      stringAttribute(attributes, traceAttribute.requestModel) ??
      trace.finalModelId ??
      trace.requestedModelId,
    ...
    ttftMs:
      numberAttribute(attributes, traceAttribute.attemptTtftMs) ??
      numberAttribute(attributes, traceAttribute.ttftMs) ??
      (isRoot ? trace.ttftMs : undefined),
```

`attemptModelId` 排在 `responseModel` 前面：新版 attempt span 只有前者，新版 GenAI span
只有后者，两个都没有的老 span 走后面的链。

`span-attribute-rows.ts` 的 `rootOnlyFilterBuilders`（`:35-39`）里，把
`[traceAttribute.httpStatusCode]` 那条整体复制一份给 `[traceAttribute.legacyHttpStatusCode]`
（同一个正则、同一个 `finalHttpStatus` patch），否则老 root span 的状态码在属性表里
点不出「按最终状态码过滤」。

- [ ] **Step 10: 跑测试确认通过**

Run: `cd packages/dashboard && bun run test:unit`
Expected: PASS。

- [ ] **Step 11: 全量**

Run: `bun run preflight`
Expected: PASS。会红的老测试与改法：

- `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`
  若有 `'http.status_code'` 的期望值，它是通过 `attributeName.httpStatusCode` 拿的，
  自动跟着改；只有写死字面量的地方要手改。
- `packages/core` 的 `span-projection` / `trace-store` 单测里若有断言 attempt 行读回带
  `gen_ai.request.model`，改成 `aio_proxy.attempt.model_id`。
- `packages/server/__tests__` 里走 `recording.ts` 投影的端到端断言（`modelId`、`statusCode`）
  不用改 —— 它们读的是 `RecordedAttempt` 字段，Step 6 已经把字面量对齐了。

- [ ] **Step 12: 提交**

```bash
git add packages/server/src/request-tracing/semantic.ts \
  packages/server/src/routes/pipeline/attempt/emit \
  packages/server/src/routes/token-count/shared.ts \
  packages/server/src/routes/pipeline/span-tree.test.ts \
  packages/server/__tests__/trace-recording.test-support.ts \
  packages/core/src/db/trace-store/span-projection \
  packages/dashboard/src/modules/traces/lib
git commit -m "refactor: attempt span 用 aio_proxy.attempt.* 属性，状态码落标准 key"
```

---

### Task 11: span 注册表（杀死「有常量没创建点」）

**Files:**
- Move: `packages/server/src/request-tracing/semantic.ts` → `packages/server/src/request-tracing/semantic/semantic.ts`
- Create: `packages/server/src/request-tracing/semantic/index.ts`
- Create: `packages/server/src/request-tracing/semantic/semantic.test.ts`

**Interfaces:**
- Consumes: 任务 3、5、6、7 之后所有 span 的创建点都已存在（这是校验的前提，也是本任务排在末尾的唯一理由）。
- Produces: `spanRegistry` —— 每个 span 一条 `{ name?, nameShape?, kind, parent, createdBy }`；
  `spanName` 保持原样导出（值从 registry 里引用），所有现有调用点不动。

**这个任务是为了让本次的病因不再复发。** 开工时 `spanName` 里 11 个常量有 7 个没有创建点
（`parse` / `session` / `route` / `prepare` / `inference` / `egress` / `usage`），dashboard
照着常量写了渲染分支，等了两年的 span 永远不会来。任务 3-7 让其中五个活了过来，
`egress` 和 `usage` 是 spec 明确不做的（spec:304、见文末「与 spec 的偏差」），本任务删掉它们，
并且让「声明了却没人创建」变成一条红测试。

**目录搬家是 CLAUDE.md 的硬要求**：「When a module has a colocated test, group the public
entry point, implementation, and test in a same-name directory」。`semantic.ts` 今天是平铺
文件，要加 colocated test 就得先变成 `semantic/`。所有 import 串
（`'./semantic'`、`'../semantic'`、`'../../request-tracing/semantic'`）在目录形式下原样解析，
一行都不用改。

- [ ] **Step 1: 搬家**

```bash
mkdir packages/server/src/request-tracing/semantic
git mv packages/server/src/request-tracing/semantic.ts packages/server/src/request-tracing/semantic/semantic.ts
```

目录 `semantic` 和文件 `semantic.ts` 不重名，可以直接建再搬。

新建 `packages/server/src/request-tracing/semantic/index.ts`（只有导出，业务代码不许进来）：

```typescript
export * from './semantic';
```

- [ ] **Step 2: 跑测试确认搬家没碰坏解析**

Run: `cd packages/server && bun test src/request-tracing/` 然后回仓库根跑 `bun run check`
Expected: PASS。`dashboard-routes/traces/traces.ts:15` 那条深路径 import 是重点观察对象。

- [ ] **Step 3: 提交搬家（与内容变更分开，diff 才读得懂）**

```bash
git add packages/server/src/request-tracing/semantic
git commit -m "refactor(server): semantic 改为目录形式以容纳 colocated 测试"
```

- [ ] **Step 4: 写失败测试**

新建 `packages/server/src/request-tracing/semantic/semantic.test.ts`：

```typescript
import { Glob } from 'bun';
import { expect, test } from 'bun:test';

import { spanName, spanRegistry } from './semantic';

const SRC = new URL('../../', import.meta.url).pathname;

async function sourceFiles(): Promise<readonly string[]> {
  const paths = await Array.fromAsync(new Glob('**/*.ts').scan({ cwd: SRC, absolute: true }));
  return paths.filter((path) => !path.includes('/request-tracing/semantic/') && !path.includes('.test.'));
}

test('every declared span has a creation site that goes through the registry', async () => {
  for (const [key, declaration] of Object.entries(spanRegistry)) {
    const file = Bun.file(`${SRC}${declaration.createdBy}`);
    expect(await file.exists(), `${key}: createdBy 指向的文件不存在`).toBe(true);
    const source = await file.text();
    // 固定名的 span 必须用常量创建；动态名的 span（GenAI、上游 HTTP）只能校验创建点存在。
    if (declaration.name !== undefined) {
      expect(source, `${key}: 创建点没有引用 spanName.${key}`).toContain(`spanName.${key}`);
    }
    for (const parent of declaration.parent) {
      expect(Object.keys(spanRegistry)).toContain(parent);
    }
  }
});

test('no aio_proxy name is minted outside the semantic module', async () => {
  const offenders: string[] = [];
  for (const path of await sourceFiles()) {
    if ((await Bun.file(path).text()).includes("'aio_proxy.")) offenders.push(path.slice(SRC.length));
  }

  expect(offenders).toEqual([]);
});

test('spanName and the registry describe the same set of spans', () => {
  expect(Object.keys(spanName).sort()).toEqual(
    Object.entries(spanRegistry)
      .filter(([, declaration]) => declaration.name !== undefined)
      .map(([key]) => key)
      .sort(),
  );
});
```

第二条 test 是「常量别再绕过 semantic」的闸门：今天非测试源码里一个 `'aio_proxy.` 字面量
都没有，所以它开箱即绿，价值在于以后谁手写一个名字就会红。

- [ ] **Step 5: 跑测试确认失败**

Run: `cd packages/server && bun test src/request-tracing/semantic`
Expected: FAIL —— `spanRegistry` 还不存在。

- [ ] **Step 6: 写注册表**

`packages/server/src/request-tracing/semantic/semantic.ts`。`spanName` 里删掉两行：

```ts
  egress: 'aio_proxy.response.egress',
  usage: 'aio_proxy.usage.resolve',
```

（`inference` 那行任务 5 已经删过。）然后在 `spanName` 之后加：

```typescript
import { SpanKind } from '@opentelemetry/api';

type SpanDeclaration = {
  /** 固定 span 名；动态名的 span 不给这个字段，只给 nameShape。 */
  readonly name?: string;
  readonly nameShape?: string;
  readonly kind: SpanKind;
  /** 允许的父 span（registry 的 key）。root 为空。 */
  readonly parent: readonly string[];
  /** 创建点，相对 packages/server/src。colocated 测试按它校验「声明即存在」。 */
  readonly createdBy: string;
};

// 一个 span 的完整声明只有这一处。加 span 先加声明，测试会逼着你把创建点补上；
// 删创建点不删声明，测试同样会红 —— 本次重构起因的七个死常量再也长不出来。
export const spanRegistry = {
  request: {
    name: spanName.request,
    kind: SpanKind.SERVER,
    parent: [],
    createdBy: 'request-tracing/request-trace-recorder/request-trace-recorder.ts',
  },
  parse: { name: spanName.parse, kind: SpanKind.INTERNAL, parent: ['request'], createdBy: 'routes/pipeline/index.ts' },
  session: {
    name: spanName.session,
    kind: SpanKind.INTERNAL,
    parent: ['request'],
    createdBy: 'routes/pipeline/index.ts',
  },
  route: { name: spanName.route, kind: SpanKind.INTERNAL, parent: ['request'], createdBy: 'routes/pipeline/index.ts' },
  inference: {
    nameShape: '{operation} {model}',
    kind: SpanKind.CLIENT,
    parent: ['request'],
    createdBy: 'routes/pipeline/inference-span.ts',
  },
  attempt: {
    name: spanName.attempt,
    kind: SpanKind.INTERNAL,
    // token-count 没有 GenAI span（它不生成 token，只数 token），那条路上 attempt 直接挂 root。
    parent: ['inference', 'request'],
    createdBy: 'routes/pipeline/attempt/emit/emit.ts',
  },
  prepare: {
    name: spanName.prepare,
    kind: SpanKind.INTERNAL,
    parent: ['attempt'],
    createdBy: 'routes/pipeline/attempt/model.ts',
  },
  upstream: {
    nameShape: '{http.request.method}',
    kind: SpanKind.CLIENT,
    parent: ['attempt'],
    createdBy: 'request-logging/wire/wire.ts',
  },
  tokenCount: {
    name: spanName.tokenCount,
    kind: SpanKind.INTERNAL,
    parent: ['request'],
    createdBy: 'routes/token-count/shared.ts',
  },
  candidateSkipped: {
    name: spanName.candidateSkipped,
    kind: SpanKind.INTERNAL,
    parent: ['request'],
    createdBy: 'routes/token-count/shared.ts',
  },
} as const satisfies Record<string, SpanDeclaration>;
```

`kind` / `parent` 是**文档字段**，没有运行时消费者。不要再写一条「跑一遍 pipeline 校验
kind 与 parent」的测试 —— 任务 3、5、6、7 的 `span-tree.test.ts` 已经逐条断言过真实父子
关系，再断言一次只是把静态配置抄进测试（CLAUDE.md 明令禁止）。

`attempt` 的 `createdBy` 指 `emit.ts` 而不是 `token-count/shared.ts`：一个 span 只登记
主创建点，测试要的是「至少有人创建」。

- [ ] **Step 7: 跑测试确认通过**

Run: `cd packages/server && bun test src/request-tracing/`
Expected: PASS。第一条 test 会把任务 3-7 的创建点全部点名一遍，任何一条对不上就是
声明与实现脱钩 —— 改声明还是改实现按实际情况定，不要为了让测试绿而把 `createdBy`
指向一个「大概在那儿」的文件。

- [ ] **Step 8: 全量**

Run: `bun run preflight`
Expected: PASS。`spanName.egress` / `spanName.usage` 删掉后若有测试引用它们，那些测试本身
就是在断言死常量的存在，直接删掉对应断言。

- [ ] **Step 9: 提交**

```bash
git add packages/server/src/request-tracing/semantic
git commit -m "feat(server): span 注册表，声明与创建点由测试绑定"
```

---

### Task 12: 瀑布图读新树 —— TTFT 刻度与 `ambiguous` 说明

**Files:**
- Modify: `packages/dashboard/src/modules/traces/lib/trace-layout/trace-layout.ts`
- Modify: `packages/dashboard/src/modules/traces/components/span-waterfall/trace-waterfall-row.tsx:22-30,52-58`
- Modify: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-metric-grid.tsx:19-25`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Test: `packages/dashboard/src/modules/traces/lib/trace-layout/trace-layout.test.ts`
- Test: `packages/dashboard/src/modules/traces/components/span-waterfall/span-waterfall.test.tsx`

**Interfaces:**
- Consumes: 任务 10 的 `traceAttribute.attemptTtftMs`；`attributeName.transportObservation`
  （`aio_proxy.response.transport_observation`）—— 这个 key 今天已经在 attempt span 上。
- Produces: `TraceSpanLayout` 新增 `ttftRatio?: number`（相对整条 trace 跨度的绝对位置，
  和 `offsetRatio` 同一个坐标系）。

**先说清楚两件本任务不做的事，省下的就是省下的：**

1. **不做 DFS 重排。** spec 说「`trace-layout.ts` 现在只管深度与柱宽，要支持真实多级嵌套」——
   读完代码发现深度早就是顺着 `parentSpanId` 链一路数上去的，层数没有上限，多级嵌套本来就成立。
   行序也不用动：API 按 `startedAt asc` 出（`trace-queries.ts:245`），而新树里父 span 总是
   早于子 span 开始、兄弟 span 依次发生，时间序与 DFS 序重合。`trace-layout.test.ts` 那条
   `'keeps API order while laying out nested and overlapping Spans'` 因此保持原契约不变。
2. **旧数据不特殊处理。** 老 trace 只有 root + attempt 两行、没有 `aio_proxy.attempt.ttft_ms`，
   `ttftRatio` 就是 `undefined`，柱子还是今天那根单色柱 —— `trace-waterfall-row.tsx` 的现有
   分支就是退路，不需要为它加判断。

**刻度不画成子行**，因为 TTFT 不是一段时间，是一个时刻：画成行会多出一根宽度等于「从 attempt
起点到首字」的柱子，读者会以为那是一个独立阶段。

**`ambiguous` 时不画刻度**：attempt 内隐藏重试（`raw-retry.ts`）让首字无法归因到哪一次响应，
任务 2 已经让 `firstContentMs` 在这种情况下压根不写。于是 dashboard 的 TTFT 格子会是 `—`，
和「这条 trace 没测到」长得一样 —— 这一步给它一句解释，不然用户只会以为数据丢了。

- [ ] **Step 1: 写失败测试（layout）**

`trace-layout.test.ts` 的 `describe` 里追加：

```ts
test('places a TTFT tick inside the attempt bar', () => {
  const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
  const attempt = span('attempt', '2026-07-12T08:00:00.020Z', '2026-07-12T08:00:00.090Z', 'root');
  const rows = layoutTraceSpans(
    [root, { ...attempt, attributes: { 'aio_proxy.attempt.ttft_ms': 30 } }],
    new Date('2026-07-12T08:00:01.000Z'),
  );

  // attempt 起点 20ms + TTFT 30ms = 整条 trace 的 50ms 处，100ms 跨度 → 0.5。
  expect(rows[1]?.ttftRatio).toBe(0.5);
  expect(rows[0]?.ttftRatio).toBeUndefined();
});

test('drops the TTFT tick when the attempt saw more than one response', () => {
  const root = span('root', '2026-07-12T08:00:00.000Z', '2026-07-12T08:00:00.100Z');
  const attempt = span('attempt', '2026-07-12T08:00:00.020Z', '2026-07-12T08:00:00.090Z', 'root');
  const rows = layoutTraceSpans(
    [
      root,
      {
        ...attempt,
        attributes: {
          'aio_proxy.attempt.ttft_ms': 30,
          'aio_proxy.response.transport_observation': 'ambiguous',
        },
      },
    ],
    new Date('2026-07-12T08:00:01.000Z'),
  );

  expect(rows[1]?.ttftRatio).toBeUndefined();
});
```

第二条是防御性的：服务端在 `ambiguous` 时本来就不写这个属性（任务 2），但旧数据里写过，
渲染层不能指望发射端的历史。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/dashboard && bun run test:unit src/modules/traces/lib/trace-layout`
Expected: FAIL —— `ttftRatio` 不存在。

- [ ] **Step 3: 算刻度位置**

`trace-attribute-names.ts` 补一个 key（任务 10 已经在这个文件里加过三个）：

```ts
  transportObservation: 'aio_proxy.response.transport_observation',
```

`trace-layout.ts`：import 区加 `import { traceAttribute } from '../trace-attribute-names';`，
`TraceSpanLayout` 里 `scaleDurationMs` 之后加字段：

```ts
  /** 首字时刻在整条 trace 坐标系里的位置，与 offsetRatio 同一个基准。测不到就没有这个字段。 */
  readonly ttftRatio?: number;
```

`minimumBarRatio` 之后加：

```ts
// 首字是一个时刻，不是一段时间：只给位置，不给宽度。
const ttftRatioOf = (
  span: DashboardTraceSpan,
  startedAt: number,
  traceStart: number,
  scaleDurationMs: number,
): number | undefined => {
  const ttftMs = span.attributes[traceAttribute.attemptTtftMs];
  // 同一个 attempt 内观测到多次响应时首字无法归因到哪一次，宁可不画。
  if (span.attributes[traceAttribute.transportObservation] === 'ambiguous') return undefined;
  if (typeof ttftMs !== 'number' || !Number.isFinite(ttftMs) || ttftMs < 0) return undefined;
  const ratio = (startedAt - traceStart + ttftMs) / scaleDurationMs;
  return ratio < 0 || ratio > 1 ? undefined : ratio;
};
```

`spans.map` 的 return 改成：

```ts
    const ttftRatio = ttftRatioOf(span, startedAt, traceStart, scaleDurationMs);

    return {
      ...span,
      depth,
      offsetRatio,
      widthRatio,
      durationMs,
      scaleDurationMs,
      ...(ttftRatio === undefined ? {} : { ttftRatio }),
    };
```

用可选属性 + 条件展开而不是 `ttftRatio: undefined`：`TraceSpanLayout` 是
`exactOptionalPropertyTypes` 下的可选字段，显式 `undefined` 通不过类型检查。

- [ ] **Step 4: 画刻度**

`trace-waterfall-row.tsx` 的柱子容器（`<span className="relative h-2.5">`）里，柱子之后加：

```tsx
        {row.ttftRatio === undefined ? null : (
          /* 首字刻度。装饰性重复：同一个数在详情面板的 TTFT 格子里有文字版，
             所以这里 aria-hidden，不往行的读屏文案里再塞一个数。 */
          <span
            className="absolute inset-y-[-3px] w-px bg-foreground/70"
            style={{ left: `${row.ttftRatio * 100}%` }}
            data-testid="waterfall-ttft-tick"
            aria-hidden="true"
          />
        )}
```

刻度比柱子高一点（`inset-y-[-3px]`）才看得见：压在柱子里面会被柱子的圆角和填充色吃掉。

- [ ] **Step 5: `ambiguous` 在详情面板里有话说**

`span-metrics.ts` 的 `SpanMetrics` 加一个字段并在返回对象里填：

```ts
  readonly transportObservation: string | undefined;
```

```ts
    transportObservation: stringAttribute(attributes, traceAttribute.transportObservation),
```

`span-metric-grid.tsx` 里 `cells` 之前加：

```tsx
  // 测不到 TTFT 且 attempt 内观测到多次响应时，`—` 会被读成「没记到」。说清楚是归因不了。
  const ttft =
    metrics.ttftMs === undefined && metrics.transportObservation === 'ambiguous'
      ? m['dashboard.traces.span_metric_ttft_ambiguous']()
      : duration(metrics.ttftMs);
```

`cells` 里那行换成 `[m['dashboard.traces.span_metric_ttft'](), ttft],`。

五个语言包在 `span_metric_ttft` 那行后面各加一条 `span_metric_ttft_ambiguous`：

- `en.json`: `"span_metric_ttft_ambiguous": "Not attributable (retried within this attempt)"`
- `zh-Hans.json`: `"span_metric_ttft_ambiguous": "无法归因（该 attempt 内发生了重试）"`
- `zh-Hant.json`: `"span_metric_ttft_ambiguous": "無法歸因（該 attempt 內發生了重試）"`
- `ja.json`: `"span_metric_ttft_ambiguous": "帰属不能（この試行内で再試行が発生）"`
- `ko.json`: `"span_metric_ttft_ambiguous": "귀속 불가(이 시도 내 재시도 발생)"`

- [ ] **Step 6: 渲染测试**

`span-waterfall.test.tsx` 末尾追加：

```tsx
test('draws the TTFT tick on an attempt bar that measured first content', () => {
  render(
    <SpanWaterfall
      spans={[
        rootSpan,
        { ...attemptSpan, attributes: { 'aio_proxy.attempt.ttft_ms': 30 } },
      ]}
      selectedSpanId={undefined}
      now={new Date('2026-07-12T08:00:01.000Z')}
      onSelect={() => {}}
    />,
  );

  expect(screen.getAllByTestId('waterfall-ttft-tick')).toHaveLength(1);
});
```

`rootSpan` / `attemptSpan` 用这个文件里已有的 fixture（名字按实际的来，别新造一套）。

- [ ] **Step 7: 跑测试**

Run: `cd packages/dashboard && bun run test:unit`
Expected: PASS。`span-metrics.test.ts` 里那两个穷举 `toEqual` 不用加
`transportObservation` —— 值是 `undefined` 时 `toEqual` 不比较该键；哪天 fixture 真写了这个
属性再补。

- [ ] **Step 8: 全量 + 提交**

Run: `bun run preflight`

```bash
git add packages/dashboard/src/modules/traces packages/i18n/messages
git commit -m "feat(dashboard): 瀑布图画 TTFT 刻度，归因不了时给出说明"
```

---

### Task 13: demo 跟上真实的树 + changeset

**Files:**
- Modify: `docs/superpowers/demos/traces-redesign/detail.html:90-122,123-137`
- Modify: `docs/superpowers/demos/traces-redesign/demo.css:190-197`
- Create: `.changeset/<随机名>.md`

**Interfaces:**
- Consumes: 任务 3-12 的最终 span 名、属性名与 TTFT 刻度。
- Produces: 无代码接口。demo 是静态 HTML，只给人看。

**demo 今天是编的。** `detail.html:90-99` 那份 span 列表里 `stream.ttft` / `stream.body` /
`usage.record` 三个 span 从来不存在（`stream.ttft` 甚至被画成一段 2ms 的柱子 —— 明确不做的
「把时刻画成行」的反面教材），`route.resolve` 之外的请求级 span 一个没有，`http.request`
这个名字在真实实现里是 HTTP 方法 `POST`。这一步让 demo 与实现对齐，不然下一个人照 demo
写渲染。

- [ ] **Step 1: 换 span 列表**

`detail.html` 第 90-99 行整段替换（缩进跟着周围走）：

```js
      // 一条失败转移的 trace：anthropic-primary 429，anthropic-backup 接手。
      // 名字与层级完全对齐服务端 spanRegistry：GenAI span 名是「{operation} {model}」，
      // 上游 HTTP span 名就是方法名。`ttft` 只在成功的 attempt 上有，画成刻度不画成行。
      const spans = [
        { name: 'aio_proxy.request', start: 0, dur: 3420, depth: 0, status: 'success' },
        { name: 'aio_proxy.request.parse', start: 2, dur: 3, depth: 1, status: 'success' },
        { name: 'aio_proxy.session.resolve', start: 5, dur: 4, depth: 1, status: 'success' },
        { name: 'aio_proxy.route.resolve', start: 9, dur: 6, depth: 1, status: 'success' },
        { name: 'chat claude-sonnet-4-6', start: 16, dur: 3390, depth: 1, status: 'success' },
        { name: 'aio_proxy.provider.attempt', start: 18, dur: 1186, depth: 2, status: 'failure' },
        { name: 'aio_proxy.request.prepare', start: 19, dur: 4, depth: 3, status: 'success' },
        { name: 'POST', start: 24, dur: 1174, depth: 3, status: 'failure' },
        { name: 'aio_proxy.provider.attempt', start: 1210, dur: 2196, depth: 2, status: 'success', ttft: 612 },
        { name: 'aio_proxy.request.prepare', start: 1211, dur: 1, depth: 3, status: 'success' },
        { name: 'POST', start: 1216, dur: 590, depth: 3, status: 'success' },
      ];
```

`total = 3420` 不变。两个 attempt 的 `prepare` 宽度差了 4 倍（`materialize` vs `reuse`），
这是任务 6 的 `prepareMode` 在 demo 里的样子。

- [ ] **Step 2: 画刻度**

`detail.html` 的 `wf-track` 那行里，柱子之后拼上刻度：

```js
            <div class="wf-track"><div class="wf-bar" data-status="${s.status}" style="left:${(s.start / total) * 100}%;width:${Math.max((s.dur / total) * 100, 0.6)}%"></div>${s.ttft === undefined ? '' : `<div class="wf-tick" style="left:${((s.start + s.ttft) / total) * 100}%" title="首字 ${fmt(s.ttft)}"></div>`}</div>
```

`demo.css` 第 197 行（`.wf-dur` 之前）加：

```css
.wf-tick { position: absolute; top: 0; width: 1px; height: 16px; background: color-mix(in oklab, var(--foreground) 70%, transparent); }
```

高度取满 `.wf-track`（16px，柱子是 10px + top 3px），刻度两头各露出 3px 才看得见。

- [ ] **Step 3: 属性名对齐**

`detail.html:123-137` 的 `attributes` 换成真实 key（`aio.` 前缀从来不存在，真实前缀是
`aio_proxy.`）：

```js
      const attributes = [
        ['aio_proxy.request.id', 'req_01JQ8Z3M7YK2'],
        ['aio_proxy.session.source', 'claude-code'],
        ['aio_proxy.session.id', 'ses_7c5e0e2d41f9'],
        ['aio_proxy.protocol.inbound', 'anthropic-messages'],
        ['aio_proxy.route.final_provider_id', 'anthropic-backup'],
        ['aio_proxy.attempt.index', '1'],
        ['aio_proxy.attempt.model_id', 'claude-sonnet-4-6'],
        ['aio_proxy.attempt.ttft_ms', '612'],
        ['http.response.status_code', '200'],
        ['http.request.method', 'POST'],
        ['aio_proxy.request.stream', 'true'],
      ];
```

这是**选中 attempt 行**时的属性表，所以列的是 attempt 的属性：`gen_ai.usage.*` 归 GenAI
span（任务 9），root 上一个 `gen_ai.*` 都没有（任务 8）—— 旧 demo 把三者混在一张表里，
正是这次要拆掉的那个心智模型。

- [ ] **Step 4: 看一眼**

Run: `bun docs/superpowers/demos/traces-redesign/serve.ts`
打开 `/detail.html`：11 行、四级缩进、成功那条 attempt 的柱子上有一道竖线。深浅两个主题
各看一次（页面右上角切换），刻度在两个主题下都要看得见。

- [ ] **Step 5: changeset**

`bun changeset`，选 `aio-proxy` + `@aio-proxy/core` + `server` + `@aio-proxy/dashboard`
（CLAUDE.md：必须带上产品包 `aio-proxy`，否则 Release notes 会是空的），bump 级别
`minor`。正文（不带 `type(scope):` 前缀、不超过 5 行）：

```md
追踪详情页现在展示完整的调用链：请求解析、会话解析、路由、每次 provider 尝试及其上游 HTTP
请求各自成为一条 span，首字时延画在尝试的时间条上。token 用量与响应模型收敛到单独的推理
span，符合 OpenTelemetry GenAI 语义约定，接入 Langfuse 等平台时不再把每次重试都算成一次
生成。
```

- [ ] **Step 6: 提交**

```bash
git add docs/superpowers/demos/traces-redesign .changeset
git commit -m "docs(demo): 静态 demo 对齐真实 span 树"
```

---

## 与 spec 的偏差

以下 12 处是本计划**有意**不照 spec 做的地方。实施时按本计划执行；复核时不要把这些当成遗漏。

1. **不实现 `aio_proxy.usage.resolve` span**（spec 的用量结算子 span）。`finalizeUsage()` 的 6 个调用点全部在 async 边界之后（流结束回调、`completion.then`），拿不到 pipeline 的 `Context`，要么回填 `startTime`（Global Constraints 明令禁止），要么把 context 一路穿进 6 个签名。收益是一个恒定几毫秒的叶子 span，不值这个改动面。

2. **root 上用 `server.address` + `url.path` 代替 spec 的 `url.full`。** query string 会带 API key、签名、`?token=`。写入 trace 就写进了 SQLite 和任何下游导出。两个分量拼起来足够定位路由，缺的只有参数。

3. **`upstream.headers_ms` 留在 attempt span 上，不搬到 POST span。** 它由 `response-observation` 产出，挂在 attempt 的生命周期里；POST span 的 duration 本身就已经是「到响应头」的时长，搬过去是同一个数换个地方存。

4. **不做 attempt 侧 `aio_proxy.provider.id` / `aio_proxy.response.*` → `aio_proxy.attempt.*` / `aio_proxy.upstream.*` 的整体改名。** 4 个文件的连锁改动、dashboard 的 key 表要跟着动，而用户看到的字段名在详情面板里本来就是翻译过的。只有任务 10 里那两个有实际语义冲突的（Langfuse 误判、OTel 已弃用名）才改。

5. **root 继续保留 `aio_proxy.response.ttft_ms`。** 列表页的 `rowToSummary` 把它当字面量读，去掉就要动列表投影和历史行的读回。它与 attempt 的 `aio_proxy.attempt.ttft_ms`、GenAI span 的 `gen_ai.response.time_to_first_chunk` 是三个不同起点的量，共存不矛盾（见 Global Constraints）。

6. **`AttemptInfo` 不新增 `startedAt`。** TTFT 改由 observation 观测、`snapshot()` 带出（任务 2），attempt span 自己的起点就是 span 的 `startTime`，不需要再传一份时间戳出来。

7. **prepare span 只在 model 路径上开**（`attempt/model.ts`）。raw / image / audio / embedding 四条路径没有 `resolveInvocation` 那段可观测的准备工作，给它们加一个近乎零耗时的 span 只是噪声。`open === undefined` 的分支因此保留。

8. **GenAI span 的结算走 session 包装，不改 13 个结算点。** spec 描述的是「在终态结算处关闭 GenAI span」；13 处 `session.finish` / `finishFrom` 调用点逐个改动风险远大于包一层 `RequestTraceSession`。依据是 `finishFrom` 的实现是 `void completion.then(...)`，同 promise 上先注册的回调先跑，GenAI span 一定关在 `root.end()` 之前。

9. **不实现 spec 列出的三个 GenAI 属性**：`gen_ai.provider.name`（我们的 provider id 是用户自定义的 key，映射不到语义约定的枚举值）、`gen_ai.request.stream`（非标准，且 root 上已有等价信息）、`gen_ai.response.finish_reasons`（AI SDK 与 raw 两条路径的终止原因形状不同，归一本身就是一个独立课题）。

10. **`aio_proxy.response.egress` span 不实现，常量删除。** spec:304 自己已经放弃了这个 span（egress 转换是同步的、微秒级）。任务 11 的注册表校验会逼出这个常量，直接删掉它而不是补一个创建点。

11. **`trace-layout.ts` 不做 DFS 重排。** spec 要求「真实多级嵌套」，而 depth 的计算已经沿父链上溯、没有深度上限；`trace-queries.ts:245` 按 `startedAt asc` 排序，对这棵树而言时间序恰好等于 DFS 序。现有 test `'keeps API order while laying out nested and overlapping Spans'` 锁的就是「保持 API 顺序」这个契约，重排会直接违约。

12. **不加「六种能力各一」的矩阵测试。** spec 测试表里这一条要求断言 image / speech / transcription / video 不写 `gen_ai.operation.name`。`__tests__/pipeline-helpers` 今天只有 language/raw 的 provider fixture，为四种能力各造一套 adapter fixture 的成本远大于收益；gating 本身是 `inference-span.ts` 里两张表的差集，语言路径那条 test（`genAiOperationName === 'chat'`）已经锁住了写入侧。spec 测试表的其余条目分布如下：墙钟前跳/后跳由「不回填 `startTime`」的硬约束从根上消除（任务 5 之后不存在传 `startTime` 的调用点）；延迟 EOF、取消、出口流报错由现有 `model-stream.*.test.ts` / `response-observation.test.ts` 覆盖，本 PR 不改这些行为。「不可重试状态但仍有候选」不另造场景 —— 判据由任务 5 那条「失败转移后成功则 GenAI span 不是 ERROR」从反面锁住，它测的是同一个东西：状态取自结算，不取自候选是否耗尽。
