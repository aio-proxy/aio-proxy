import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelEventStream, TextStreamPart, ToolSet } from '@aio-proxy/core';
import { createTraceStore, openDb, projectAttributes, type StoredSpan } from '@aio-proxy/core/db';
import { ProviderProtocol } from '@aio-proxy/types';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import {
  defineProtocolAdapter,
  emptyStream,
  jsonRequest,
  modelProvider,
  rawProvider,
  REQUESTED_MODEL,
  settleRecording,
  slowTextStream,
  textStream,
  textThenErrorStream,
} from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import { pipeline } from './test-support';

// Long enough that the settlement of a streamed completion is unambiguously
// later than the moment the Response was handed back. Also the TTFT fixture's
// stream tail.
const STREAM_TAIL_MS = 240;

// The TTFT fixture's three intervals. They are deliberately unequal: the bounds
// admit a ~160ms window, so equal intervals would let a wrong implementation
// summing the wrong two of them land inside it. See the table on the test.
const FAILOVER_BURN_MS = 80;
const FIRST_CHUNK_DELAY_MS = 340;

// Floor for the TTFT fixture's self-check. Deliberately a fixed number rather
// than a fraction of the three constants above, so shrinking one of them to
// zero fails the self-check instead of moving the floor down with it. Each of
// the three constants is well clear of it; an interval that did not happen
// measures single digits.
const MIN_FIXTURE_INTERVAL_MS = 40;

// Indexes one recording's spans by name and projects "who is whose parent" in
// readable terms. `find` keeps the first span of a name so repeated names (many
// provider attempts) resolve to the earliest one.
function tree(spans: readonly StoredSpan[]) {
  const byId = new Map(spans.map((span) => [span.spanId, span]));
  const find = (name: string) => spans.find((span) => span.name === name);
  return {
    find,
    parentNameOf: (name: string) => {
      const parentId = find(name)?.parentSpanId;
      return parentId === undefined ? undefined : byId.get(parentId)?.name;
    },
  };
}

// The logical-operation layer has a fixed name, so it is found directly. It is
// INTERNAL on purpose: it spans route resolution plus every candidate, so it has
// no single upstream and is deliberately not an inference span.
function inferenceSpanOf(spans: readonly StoredSpan[]): StoredSpan | undefined {
  return spans.find((span) => span.name === spanName.inference);
}

// Each provider attempt IS an inference span now: CLIENT, named `{operation}
// {model}` at runtime. Find them structurally — the CLIENT children of the
// logical-operation layer. (The upstream HTTP CLIENT spans sit one level deeper,
// under an attempt, so they are not caught here.)
function attemptSpansOf(spans: readonly StoredSpan[]): readonly StoredSpan[] {
  const layer = inferenceSpanOf(spans);
  return spans.filter((span) => span.parentSpanId === layer?.spanId && span.kind === SpanKind.CLIENT);
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
  // 路由解析是「选出第一个候选」，属于逻辑操作的一部分，所以挂在它下面而不是 root 下。
  // 这也是路由失败时仍然有一条带 gen_ai.request.model 的 span 的原因。
  expect(spanTree.parentNameOf(spanName.route)).toBe(spanName.inference);
});

test('the route span records how many candidates survived capability filtering', async () => {
  const { spans } = await runOnce();

  expect(tree(spans).find(spanName.route)?.attributes[attributeName.routeCandidateCount]).toBe(1);
});

test('the root span carries no gen_ai attributes', async () => {
  const { spans } = await runOnce();

  const root = spans.find((span) => span.name === spanName.request);
  expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
  expect(inferenceSpanOf(spans)?.attributes[attributeName.genAiRequestModel]).toBe(REQUESTED_MODEL);
  expect(inferenceSpanOf(spans)?.attributes[attributeName.genAiResponseModel]).toBe('raw-model');
});

test('a settled usage row still leaves no gen_ai attributes on the root span', async () => {
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => textStream('ok') })], {
    immediateStreamCompletion: {
      outcome: 'success',
      usage: { providerId: 'primary', modelId: 'upstream-model', inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    },
  });
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);

  // 先钉住这一趟确实结算出了 usage。没有这条，下面的断言在 usage 为空时会空过 ——
  // runOnce() 的 raw 直通就是这种情况，删掉 usage setter 也照样绿。
  expect(harness.recording.finals[0]).toMatchObject({ usage: expect.objectContaining({ inputTokens: 3 }) });
  const root = harness.recording.spans.find((span) => span.name === spanName.request);
  expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
});

test('a parse failure ends the parse span before the root settles', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  const response = await harness.run(jsonRequest({ prompt: 'missing model' }));
  await settleRecording(harness.recording);

  expect(response.status).toBe(400);
  // take() drains the buffer right after root.end(): a parse span that did not
  // get in ahead of that disappears from the trace entirely.
  expect(tree(harness.recording.spans).find(spanName.parse)).toBeDefined();
});

test('a throwing session store still leaves an ended session span behind', async () => {
  const harness = pipeline([rawProvider({ id: 'raw' })]);
  harness.source.logicalSessionStore.begin = () => {
    throw new Error('logical session store unavailable');
  };

  await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }))).rejects.toThrow(
    'logical session store unavailable',
  );
  await settleRecording(harness.recording);

  // The outer catch settles the root, so an unended session span is dropped on
  // export and the failed request shows no session-resolve segment at all.
  const sessionSpan = tree(harness.recording.spans).find(spanName.session);
  expect(sessionSpan?.endedAt).toBeInstanceOf(Date);
  expect(sessionSpan?.statusCode).toBe(SpanStatusCode.ERROR);
});

test('a model invocation failure produces exactly one attempt span', async () => {
  // Model providers, not raw ones: a raw transport matching the inbound protocol
  // passes through without ever materializing a model invocation.
  const harness = pipeline(
    [
      modelProvider({ id: 'primary', invoke: () => textStream('unused'), targetProtocol: ProviderProtocol.Anthropic }),
      modelProvider({ id: 'backup', invoke: () => textStream('unused') }),
    ],
    {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
        modelInvocationError: new SyntaxError('invalid invocation'),
      }),
    },
  );

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const attempts = attemptSpansOf(harness.recording.spans);

  expect(response.status).toBe(400);
  expect(attempts).toHaveLength(1);
  // The span is opened before prepare resolves the target protocol, so this exit
  // has to attach it after the fact — it is not in the creation attributes.
  expect(attempts[0]?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.Anthropic);
  // 请求整形失败不是候选特有的，所以**不**转移到 backup —— 断言这一点，
  // 免得后人误以为「只有一个 attempt」是因为 hasNext 为 false。
  expect(harness.recording.finals).toEqual([
    expect.objectContaining({ errorCode: 'invalid_request', finalProviderId: 'primary', outcome: 'failure' }),
  ]);
});

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
  const inference = inferenceSpanOf(spans);

  expect(inference).toBeDefined();
  // 逻辑操作层没有单一上游，所以是 INTERNAL，不是 inference span。
  expect(inference?.kind).toBe(SpanKind.INTERNAL);
  expect(tree(spans).parentNameOf(spanName.inference)).toBe(spanName.request);
  const attempts = attemptSpansOf(spans);
  expect(attempts).toHaveLength(2);
  expect(attempts.map((span) => span.parentSpanId)).toEqual([inference?.spanId, inference?.spanId]);
});

test('the two layers split the gen_ai attributes by what each of them can honestly answer', async () => {
  const spans = await runFailover();
  const inference = inferenceSpanOf(spans);
  const attempts = attemptSpansOf(spans);

  // 逻辑操作层：只说得出「调用方要什么」。它横跨两个 provider，所以既没有单一
  // operation 也没有单一 provider —— 写上去就是 overload,那正是三层要避免的。
  expect(inference?.attributes[attributeName.genAiRequestModel]).toBe(REQUESTED_MODEL);
  expect(inference?.attributes[attributeName.capability]).toBe('language');
  expect(inference?.attributes[attributeName.genAiOperationName]).toBeUndefined();
  expect(inference?.attributes[attributeName.genAiProviderName]).toBeUndefined();
  // 每条 attempt 都只打了一个上游，所以这两个在这一层答案唯一。子层的 request.model 是
  // **送给该 provider 的**模型，与父层记的「调用方点名的别名」不是一回事。
  expect(attempts).toHaveLength(2);
  for (const attempt of attempts) {
    expect(attempt.kind).toBe(SpanKind.CLIENT);
    expect(attempt.attributes[attributeName.genAiOperationName]).toBe('chat');
    expect(attempt.attributes[attributeName.genAiRequestModel]).toBe(attempt.attributes[attributeName.attemptModelId]);
  }
  expect(attempts[0]?.attributes[attributeName.genAiRequestModel]).not.toBe(REQUESTED_MODEL);
});

test('the logical-operation layer counts the providers it went through', async () => {
  const spans = await runFailover();

  expect(inferenceSpanOf(spans)?.attributes[attributeName.inferenceAttemptCount]).toBe(2);
});

test('a failover that eventually succeeds leaves the inference span OK', async () => {
  const spans = await runFailover();
  const inference = inferenceSpanOf(spans);
  const attempts = attemptSpansOf(spans);

  // ERROR is decided by how this logical operation settled, not by whether an
  // attempt failed along the way.
  expect(inference?.statusCode).not.toBe(SpanStatusCode.ERROR);
  expect(attempts[0]?.statusCode).toBe(SpanStatusCode.ERROR);
});

test('the inference span ends on terminal settlement, not when the stream Response returns', async () => {
  // The finish part lands well after the Response does, so a span closed at
  // function return ends a measurable distance before the completion settles —
  // millisecond timestamps cannot tell those two apart without this gap.
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => slowTextStream('slow', STREAM_TAIL_MS) })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  const returnedAt = Date.now();
  await response.text();
  await settleRecording(harness.recording);
  const inference = inferenceSpanOf(harness.recording.spans);

  expect(inference?.endedAt.getTime()).toBeGreaterThan(returnedAt + STREAM_TAIL_MS / 2);
});

test('an unmapped provider throw still leaves an ended inference span behind', async () => {
  // The test adapter maps only Error instances onto a provider response, so this
  // one propagates out of the candidate loop without any session settlement.
  const fault = { reason: 'unmapped provider fault' };
  const harness = pipeline([
    modelProvider({
      id: 'primary',
      invoke: () => {
        throw fault;
      },
    }),
  ]);

  await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }))).rejects.toBe(fault);
  await settleRecording(harness.recording);
  const spans = harness.recording.spans;
  const inference = inferenceSpanOf(spans);

  // The attempt span ended before the throw and is already buffered. Root
  // settlement then drains the buffer, so an unended inference span vanishes and
  // leaves that attempt pointing at a parent the trace does not contain.
  expect(inference?.endedAt).toBeInstanceOf(Date);
  expect(attemptSpansOf(spans).map((span) => span.parentSpanId)).toEqual([inference?.spanId]);
});

test('a request that settles as failure marks the inference span with the settled error', async () => {
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => textStream('unused') })], {
    adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      modelInvocationError: new SyntaxError('invalid invocation'),
    }),
  });

  await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const inference = inferenceSpanOf(harness.recording.spans);

  expect(inference?.statusCode).toBe(SpanStatusCode.ERROR);
  expect(inference?.attributes[attributeName.errorCode]).toBe('invalid_request');
  expect(inference?.attributes[attributeName.httpStatusCode]).toBe(400);
});

test('prepare runs inside the attempt span, not before it', async () => {
  const spans = await runFailover();
  const attempts = attemptSpansOf(spans);
  const prepares = spans.filter((span) => span.name === spanName.prepare);

  expect(prepares).toHaveLength(2);
  expect(prepares.map((span) => span.parentSpanId)).toEqual(attempts.map((span) => span.spanId));
  // 这条是「attempt span 被开着不关」的唯一警报。未结束的 span 在导出时被直接丢弃，
  // 所以数 attempt 的条数永远数不出这个坑（任务 4 的那条计数断言实测抓不到）；
  // 但被丢掉的父亲会让已导出的 prepare 变成孤儿，parentNameOf 于是返回 undefined。
  expect(tree(spans).parentNameOf(spanName.prepare)).toBe(attemptSpansOf(spans)[0]?.name);
  for (const [index, prepare] of prepares.entries()) {
    const attempt = attempts[index];
    // 1ms of slack on each side: StoredSpan timestamps are `new Date(fractional
    // ms)`, which truncates, and the two spans' hrtimes do not share an epoch
    // anchor, so a containment that holds to the nanosecond can still land one
    // integer millisecond the wrong way (~1 run in 30). A real containment bug
    // is prepare left open across its parent's end — tens of ms at least, and
    // anyway an unended parent is dropped, which the parentNameOf check above
    // already catches. Nothing real fits inside one millisecond.
    expect(prepare.startedAt.getTime()).toBeGreaterThanOrEqual((attempt?.startedAt.getTime() ?? 0) - 1);
    expect(prepare.endedAt.getTime()).toBeLessThanOrEqual((attempt?.endedAt.getTime() ?? 0) + 1);
  }
});

test('only the first candidate materializes the invocation', async () => {
  const prepares = (await runFailover()).filter((span) => span.name === spanName.prepare);

  expect(prepares.map((span) => span.attributes[attributeName.prepareMode])).toEqual(['materialize', 'reuse']);
});

test('a prepare throw still leaves an ended prepare span behind', async () => {
  // Not a SyntaxError: the test adapter's requestError maps only those, so this
  // one is rethrown out of prepare instead of coming back as a 'reject'.
  const harness = pipeline(
    [modelProvider({ id: 'primary', invoke: () => textStream('unused'), targetProtocol: ProviderProtocol.Anthropic })],
    {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
        modelInvocationError: new RangeError('materialize exploded'),
      }),
    },
  );

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const spanTree = tree(harness.recording.spans);
  const prepare = spanTree.find(spanName.prepare);

  expect(response.status).toBe(502);
  // The throw runs to the loop's catch and on to session.finish(), which drains
  // the span buffer: a prepare span not closed on the way out is dropped from
  // the trace instead of showing where the attempt died.
  expect(prepare?.endedAt).toBeInstanceOf(Date);
  expect(prepare?.statusCode).toBe(SpanStatusCode.ERROR);
  // Pins where `slot.spanRef.current = attemptSpan` sits in attempt/model.ts:
  // the catch path closes the attempt span through that ref, so assigning it
  // only after the prepare await leaves the attempt unended on a throw, dropped
  // from the buffer, and this prepare span orphaned under a parent id that is
  // no longer in the trace. Duration and status both survive that unharmed.
  expect(spanTree.parentNameOf(spanName.prepare)).toBe(attemptSpansOf(harness.recording.spans)[0]?.name);
  // targetProtocol 在 materialize 抛之前就已经写下；漏挂的话失败那一跳没有厂商口味。
  const attempt = attemptSpansOf(harness.recording.spans)[0];
  expect(attempt?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.Anthropic);
  expect(attempt?.attributes[attributeName.genAiProviderName]).toBe('anthropic');
});

test('an unsupported invocation still leaves an ended prepare span under the attempt', async () => {
  const harness = pipeline(
    [modelProvider({ id: 'primary', invoke: () => textStream('unused'), targetProtocol: ProviderProtocol.Anthropic })],
    {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
        modelInvocationError: new SyntaxError('unsupported invocation'),
        modelUnsupported: true,
      }),
    },
  );

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const spanTree = tree(harness.recording.spans);

  expect(response.status).toBe(501);
  // Emitting this rejection ends the attempt span and finishes the request,
  // which drains the span buffer. Emitted from inside prepare — as it was when
  // resolveInvocation called emitReject itself — it takes the still-open prepare
  // span down with it and the trace shows no preparation at all.
  expect(spanTree.find(spanName.prepare)?.endedAt).toBeInstanceOf(Date);
  expect(spanTree.parentNameOf(spanName.prepare)).toBe(attemptSpansOf(harness.recording.spans)[0]?.name);
  // Same ordering hazard for the attribute: it is attached after prepare
  // resolves it, so it only lands if the span is still open at that point.
  expect(attemptSpansOf(harness.recording.spans)[0]?.attributes[attributeName.targetProtocol]).toBe(
    ProviderProtocol.Anthropic,
  );
});

test('a candidate reusing a memoized unsupported invocation does not report materialize', async () => {
  const harness = pipeline(
    [
      modelProvider({ id: 'primary', invoke: () => textStream('unused') }),
      modelProvider({ id: 'backup', invoke: () => textStream('unused') }),
    ],
    {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
        modelInvocationError: new SyntaxError('unsupported invocation'),
        modelUnsupported: true,
      }),
    },
  );

  await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const prepares = harness.recording.spans.filter((span) => span.name === spanName.prepare);

  // Candidate 0 memoized a rejection rather than an invocation, so holder
  // .invocation stays undefined while there is still nothing left to
  // materialize: candidate 1 must not claim it materialized anything.
  expect(prepares.map((span) => span.attributes[attributeName.prepareMode])).toEqual(['materialize', 'reuse']);
});

test('candidate invocation runs inside the attempt span context', async () => {
  let activeSpanId: string | undefined;
  const harness = pipeline([
    modelProvider({
      id: 'primary',
      invoke: () => {
        activeSpanId = trace.getSpan(context.active())?.spanContext().spanId;
        return textStream('ok');
      },
    }),
  ]);

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await response.text();
  await settleRecording(harness.recording);

  // Not just "some span": the upstream HTTP span in wire.ts hangs off whatever
  // context.active() holds here, so this is what keeps it inside the attempt.
  const attempt = attemptSpansOf(harness.recording.spans)[0];
  expect(attempt?.spanId).toBeDefined();
  expect(activeSpanId).toBe(attempt?.spanId);
});

// A stream carrying non-zero usage. pipeline-helpers' textStream() reports all
// zeros, which cannot tell "which key got which number" apart. `delayMs` holds
// the first chunk back; `tailMs` keeps the stream open after it, so a test can
// separate "time to first chunk" from "how long the whole thing took".
function usageStream(delayMs = 0, tailMs = 0): ModelEventStream {
  let opened = false;
  return new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      if (!opened) {
        opened = true;
        if (delayMs > 0) await Bun.sleep(delayMs);
        controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'ok' });
        return;
      }
      if (tailMs > 0) await Bun.sleep(tailMs);
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

async function runWithUsage(invoke: () => ModelEventStream = () => usageStream()) {
  const harness = pipeline([modelProvider({ id: 'primary', invoke })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  // usage / response model / response id 描述的是**某一次上游应答**，所以它们落在
  // 那条 attempt 的 inference span 上，不在横跨全部候选的逻辑操作层上。
  return attemptSpansOf(harness.recording.spans)[0];
}

test('the inference span carries usage under the standard gen_ai names', async () => {
  const inference = await runWithUsage();

  expect(inference?.attributes[attributeName.genAiUsageInputTokens]).toBe(21);
  expect(inference?.attributes[attributeName.genAiUsageOutputTokens]).toBe(14);
  expect(inference?.attributes[attributeName.genAiUsageTotalTokens]).toBe(35);
  expect(inference?.attributes['gen_ai.usage.cache_read.input_tokens']).toBe(7);
  expect(inference?.attributes['gen_ai.usage.cache_write.input_tokens']).toBe(3);
  expect(inference?.attributes['gen_ai.usage.reasoning.output_tokens']).toBe(5);
  // None of the invented names may survive.
  expect(inference?.attributes['gen_ai.usage.cache_read_tokens']).toBeUndefined();
});

test('the usage the inference span emits still lands in the trace-store token columns', async () => {
  const inference = await runWithUsage();

  // The only executable check that the recorder's attributeName strings and the
  // store's ATTR map still agree byte-for-byte. Rename one side and every token
  // stays in attributes_json instead of a column, and the dashboard silently
  // shows no tokens — nothing else in the suite notices.
  // `projectAttributes` is resolved from packages/core's built `dist`, so this
  // test only sees a core-side rename after core is rebuilt. CI is safe (turbo
  // gives test:unit `dependsOn: ["build", "^build"]`); running this file by hand
  // against a stale dist reports a false green.
  expect(projectAttributes(inference?.attributes ?? {}, false).columns).toMatchObject({
    cacheReadTokens: 7,
    cacheWriteTokens: 3,
    inputTokens: 21,
    outputTokens: 14,
    reasoningTokens: 5,
    totalTokens: 35,
  });
});

test('the inference span carries the model the upstream actually answered with', async () => {
  const inference = await runWithUsage();

  expect(inference?.attributes[attributeName.genAiResponseModel]).toBe('primary-model');
  // 同一层上「送过去的」与「答回来的」并排，才看得出上游改没改模型。
  expect(inference?.attributes[attributeName.genAiRequestModel]).toBe('primary-model');
});

// Candidate 0 sleeps, then closes without yielding anything, so the loop fails
// over to candidate 1. Candidates run in sequence, so this sleep elapses before
// candidate 1 is dispatched.
function slowEmptyStream(delayMs: number): ModelEventStream {
  return new ReadableStream<TextStreamPart<ToolSet>>({
    async pull(controller) {
      await Bun.sleep(delayMs);
      controller.close();
    },
  });
}

test('time_to_first_chunk is this span own start to its first chunk, in seconds', async () => {
  // The fixture lays down three intervals, in this order:
  //   burn  80ms  candidate 0 sleeps, yields nothing, fails
  //   delay 340ms candidate 1 sleeps, then emits the first chunk
  //   tail  240ms the stream stays open, then finishes
  // so the correct value is burn+delay = 420, and the two relational bounds
  // below admit (delay + burn/2, burn + delay + tail/2) = (380, 540).
  // The three are unequal on purpose. Every wrong implementation seen so far is
  // some sum of a subset of them, and exactly one subset is inside the window:
  //   80 burn | 340 delay (attempt origin) | 240 tail | 320 burn+tail
  //   580 delay+tail | 660 burn+delay+tail (span duration) -- all >=40ms outside
  //   420 burn+delay -- INSIDE, the only one
  // With all three equal (as they were) several of those collapse into the
  // window and the bounds stop discriminating.
  const harness = pipeline([
    modelProvider({ id: 'primary', invoke: () => slowEmptyStream(FAILOVER_BURN_MS) }),
    modelProvider({ id: 'backup', invoke: () => usageStream(FIRST_CHUNK_DELAY_MS, STREAM_TAIL_MS) }),
  ]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  const spans = harness.recording.spans;
  const inference = inferenceSpanOf(spans);
  // NaN if the attribute is missing, and every comparison below is then false.
  const genAiMs = (inference?.attributes[attributeName.genAiTimeToFirstChunk] as number) * 1000;
  // The attempt-origin TTFT, measured from candidate 1's dispatch: the burn is
  // not in it. Reusing this for the GenAI span is the tempting wrong move that
  // `firstChunkAt` exists to prevent.
  const attemptMs = spans.find((span) => span.name === spanName.request)?.attributes[attributeName.ttftMs] as number;
  const spanMs = (inference?.endedAt.getTime() ?? 0) - (inference?.startedAt.getTime() ?? 0);
  // The burn off attempt[0]'s own span and the tail as the inference span's
  // remainder — neither is read back from `genAiMs`, because the value under
  // test cannot be its own witness.
  const attemptSpans = attemptSpansOf(spans);
  const burnMs = (attemptSpans[0]?.endedAt.getTime() ?? 0) - (attemptSpans[0]?.startedAt.getTime() ?? 0);
  const tailMs = spanMs - burnMs - attemptMs;

  // Fixture self-check, one line per interval, against a floor that is NOT
  // derived from the constants above: trimming one of them to zero has to fail
  // here. Trimming it only relaxes the matching bound below into a tautology
  // (`genAiMs < spanMs` always holds), which is how these holes keep opening.
  expect(harness.recording.attempts.map((attempt) => attempt.outcome)).toEqual(['failure', 'success']);
  expect(burnMs).toBeGreaterThan(MIN_FIXTURE_INTERVAL_MS);
  expect(attemptMs).toBeGreaterThan(MIN_FIXTURE_INTERVAL_MS);
  expect(tailMs).toBeGreaterThan(MIN_FIXTURE_INTERVAL_MS);
  // Above the attempt origin: failover time counts.
  expect(genAiMs).toBeGreaterThan(attemptMs + FAILOVER_BURN_MS / 2);
  // Below the span's own duration: the tail does not count. This also excludes
  // the process origin (seconds of uptime) and a millisecond-valued attribute,
  // both of which land orders of magnitude above this ceiling.
  expect(genAiMs).toBeLessThan(spanMs - STREAM_TAIL_MS / 2);
});

test('a settlement that failed after the first chunk still records its TTFT', async () => {
  // `emit.ts` forwards firstChunkAt on presence, not on outcome, and
  // inferenceAttributes writes the TTFT for every outcome. A stream that
  // answered and then died is exactly the case where "how long until it started
  // answering" is still worth knowing, so the ungated form is the intent.
  const harness = pipeline([
    modelProvider({ id: 'primary', invoke: () => textThenErrorStream('partial', new Error('upstream died')) }),
  ]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await expect(response.text()).rejects.toThrow('upstream died');
  await settleRecording(harness.recording);
  const inference = inferenceSpanOf(harness.recording.spans);

  // Without this the assertion below would pass vacuously on a success path.
  expect(harness.recording.finals[0]).toMatchObject({ outcome: 'failure' });
  expect(typeof inference?.attributes[attributeName.genAiTimeToFirstChunk]).toBe('number');
});

test('the attempt span owns the gen_ai namespace, and keeps its own keys alongside', async () => {
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => usageStream() })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  const attempt = attemptSpansOf(harness.recording.spans)[0];

  // 原先这里断言 attempt 上「不许有 gen_ai.*」，为的是躲 Langfuse 把多个 attempt 都判成
  // GENERATION。三层之后这条反了：每次 attempt 就是一次真实的上游推理调用，判成
  // GENERATION 是准确分类；而且标准 metric gen_ai.client.operation.duration 带
  // provider.name + error.type，只有按 attempt 发射才拿得到每个 provider 的 SLO。
  expect(attempt?.attributes[attributeName.genAiOperationName]).toBe('chat');
  expect(attempt?.attributes[attributeName.genAiResponseModel]).toBe('primary-model');
  // 这个夹具没有 targetProtocol，所以 provider.name 按设计**不写** —— 它是聚合的判别器，
  // 写错值比缺值更糟。有协议时写什么由下一条钉住。
  expect(attempt?.attributes[attributeName.genAiProviderName]).toBeUndefined();
  // aio_proxy.attempt.* 与标准 key 并存不重复：provider_id 是用户自定义的配置 key，
  // 与 gen_ai.provider.name 这个厂商判别值不是一回事。
  expect(attempt?.attributes[attributeName.attemptModelId]).toBe('primary-model');
  expect(typeof attempt?.attributes[attributeName.attemptTtftMs]).toBe('number');
});

// provider.name 取的是**上游协议口味**，不是我们的 provider id —— 语义约定把它定义成
// telemetry format 的判别器，还专门点名 proxy 场景说它可以与真实上游不同。
test('gen_ai.provider.name comes from the protocol actually spoken, not our provider id', async () => {
  const harness = pipeline([
    modelProvider({ id: 'primary', invoke: () => textStream('ok'), targetProtocol: ProviderProtocol.Anthropic }),
  ]);
  await (await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }))).text();
  await settleRecording(harness.recording);
  const attempt = attemptSpansOf(harness.recording.spans)[0];

  expect(attempt?.attributes[attributeName.genAiProviderName]).toBe('anthropic');
  expect(attempt?.attributes[attributeName.providerId]).toBe('primary');
});

test('a raw passthrough attempt records gen_ai.provider.name from the inbound protocol', async () => {
  const { spans } = await runOnce();
  expect(attemptSpansOf(spans)[0]?.attributes[attributeName.genAiProviderName]).toBe('openai');
});

test('the root span TTFT key still feeds the list page summary column', async () => {
  // `completion.ts` writes request-level TTFT onto the root span under
  // `attributeName.ttftMs`, and core's `rowToSummary` reads it back as a **literal**
  // (`trace-queries.ts`, 'aio_proxy.response.ttft_ms') to fill the list page's TTFT
  // column. Nothing else joins those two sides: every server-side reader goes through
  // the constant and follows a rename, so renaming the value blanks the whole column
  // with a fully green suite. This drives a real request and reads the number back out
  // of the real store, so the two spellings have to keep agreeing.
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => usageStream() })]);
  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, stream: true }));
  await response.text();
  await settleRecording(harness.recording);
  const spans = harness.recording.spans;
  const root = spans.find((span) => span.parentSpanId === undefined);

  // Fixture self-check: this run really did settle a streamed TTFT onto the root span.
  // Without it a fixture that produces none would leave the assertion below comparing
  // undefined against undefined.
  expect(typeof root?.attributes[attributeName.ttftMs]).toBe('number');

  const home = mkdtempSync(join(tmpdir(), 'aio-span-tree-ttft-'));
  const handle = openDb({ home });
  try {
    const store = createTraceStore(handle.db);
    store.startRoot({
      traceId: root!.traceId,
      spanId: root!.spanId,
      requestId: 'request-ttft',
      inboundProtocol: 'openai-chat',
      name: root!.name,
      kind: root!.kind,
      startedAt: root!.startedAt,
      statusCode: root!.statusCode,
      attributes: {},
      events: [],
      links: [],
    });
    store.complete({
      traceId: root!.traceId,
      rootSpanId: root!.spanId,
      spans,
      summary: { finalProviderId: 'primary', finalModelId: 'primary-model', finalHttpStatus: 200 },
    });

    // `ttftMs` is not a projected column — it survives only as this attribute in
    // attributes_json, so a summary that still reports it proves the key round-tripped.
    const summary = store.find(root!.traceId)?.trace;
    expect(typeof summary?.ttftMs).toBe('number');
    expect(summary?.ttftMs).toBe(root!.attributes[attributeName.ttftMs]);
  } finally {
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
