import { expect, test } from 'bun:test';

import type { StoredSpan } from '@aio-proxy/core/db';
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
} from '../../../__tests__/pipeline-helpers';
import { attributeName, spanName } from '../../request-tracing';
import { pipeline } from './test-support';

// Long enough that the settlement of a streamed completion is unambiguously
// later than the moment the Response was handed back.
const STREAM_TAIL_MS = 120;

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

test('the root span carries no gen_ai attributes', async () => {
  const { spans } = await runOnce();

  const root = spans.find((span) => span.name === spanName.request);
  expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
  // GenAI span 的名字是 `{operation} {model}` 动态拼的，所以按结构找而不按名字找：
  // root 的子 span 里只有它是 CLIENT，parse/session/route 都是默认的 INTERNAL。
  const inference = spans.find((span) => span.parentSpanId === root?.spanId && span.kind === SpanKind.CLIENT);
  expect(inference?.attributes[attributeName.genAiRequestModel]).toBe(REQUESTED_MODEL);
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
  const attempts = harness.recording.spans.filter((span) => span.name === spanName.attempt);

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
  const inference = harness.recording.spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);

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
  const inference = spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);

  // The attempt span ended before the throw and is already buffered. Root
  // settlement then drains the buffer, so an unended inference span vanishes and
  // leaves that attempt pointing at a parent the trace does not contain.
  expect(inference?.endedAt).toBeInstanceOf(Date);
  expect(spans.filter((span) => span.name === spanName.attempt).map((span) => span.parentSpanId)).toEqual([
    inference?.spanId,
  ]);
});

test('a request that settles as failure marks the inference span with the settled error', async () => {
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => textStream('unused') })], {
    adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      modelInvocationError: new SyntaxError('invalid invocation'),
    }),
  });

  await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const inference = harness.recording.spans.find((span) => span.name === `chat ${REQUESTED_MODEL}`);

  expect(inference?.statusCode).toBe(SpanStatusCode.ERROR);
  expect(inference?.attributes[attributeName.errorCode]).toBe('invalid_request');
  expect(inference?.attributes[attributeName.httpStatusCode]).toBe(400);
});

test('prepare runs inside the attempt span, not before it', async () => {
  const spans = await runFailover();
  const attempts = spans.filter((span) => span.name === spanName.attempt);
  const prepares = spans.filter((span) => span.name === spanName.prepare);

  expect(prepares).toHaveLength(2);
  expect(prepares.map((span) => span.parentSpanId)).toEqual(attempts.map((span) => span.spanId));
  // 这条是「attempt span 被开着不关」的唯一警报。未结束的 span 在导出时被直接丢弃，
  // 所以数 attempt 的条数永远数不出这个坑（任务 4 的那条计数断言实测抓不到）；
  // 但被丢掉的父亲会让已导出的 prepare 变成孤儿，parentNameOf 于是返回 undefined。
  expect(tree(spans).parentNameOf(spanName.prepare)).toBe(spanName.attempt);
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

test('a prepare throw still leaves an ended prepare span behind', async () => {
  // Not a SyntaxError: the test adapter's requestError maps only those, so this
  // one is rethrown out of prepare instead of coming back as a 'reject'.
  const harness = pipeline([modelProvider({ id: 'primary', invoke: () => textStream('unused') })], {
    adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, {
      modelInvocationError: new RangeError('materialize exploded'),
    }),
  });

  const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: 'ping' }));
  await settleRecording(harness.recording);
  const prepare = tree(harness.recording.spans).find(spanName.prepare);

  expect(response.status).toBe(502);
  // The throw runs to the loop's catch and on to session.finish(), which drains
  // the span buffer: a prepare span not closed on the way out is dropped from
  // the trace instead of showing where the attempt died.
  expect(prepare?.endedAt).toBeInstanceOf(Date);
  expect(prepare?.statusCode).toBe(SpanStatusCode.ERROR);
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
  expect(spanTree.parentNameOf(spanName.prepare)).toBe(spanName.attempt);
  // Same ordering hazard for the attribute: it is attached after prepare
  // resolves it, so it only lands if the span is still open at that point.
  expect(spanTree.find(spanName.attempt)?.attributes[attributeName.targetProtocol]).toBe(ProviderProtocol.Anthropic);
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
  const attempt = harness.recording.spans.find((span) => span.name === spanName.attempt);
  expect(attempt?.spanId).toBeDefined();
  expect(activeSpanId).toBe(attempt?.spanId);
});
