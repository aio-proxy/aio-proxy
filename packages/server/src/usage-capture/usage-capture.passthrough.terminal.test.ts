import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';
import { clearPriceCatalog, seedPriceCatalog } from './test-support';

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
  beforeEach(async () => {
    await seedPriceCatalog([]);
  });

  afterEach(() => {
    clearPriceCatalog();
  });

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

  test('Gemini defers completion to EOF so multi-candidate usage is not lost', async () => {
    // candidateCount > 1: the first candidate reports finishReason in an early
    // frame, but the aggregate usageMetadata trails in a later frame. Completion
    // must NOT settle on the first finishReason — it waits for EOF and records
    // the full usage.
    let releaseTail: (() => void) | undefined;
    const tailGate = new Promise<void>((r) => (releaseTail = r));
    const firstCandidate =
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]},"finishReason":"STOP","index":0}]}\n\n';
    const trailingUsage =
      'data: {"candidates":[{"content":{"parts":[{"text":"b"}]},"finishReason":"STOP","index":1}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":6,"totalTokenCount":10}}\n\n';
    const captured = createUsageCapture().passthrough({
      response: new Response(
        framedStream([firstCandidate], async () => {
          await tailGate;
          return trailingUsage;
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      protocol: ProviderProtocol.Gemini,
      providerId: 'provider',
      modelId: 'model',
    });

    // Drain the first candidate frame; completion must stay pending — the first
    // finishReason must not settle the trace.
    const reader = captured.value.body!.getReader();
    await reader.read();
    const pending = await Promise.race([captured.completion.then(() => 'settled'), Promise.resolve('pending')]);
    expect(pending).toBe('pending');

    // Release the trailing usage frame and drain to EOF.
    releaseTail?.();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
    }
    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    expect('usage' in completion ? completion.usage : undefined).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });

  test('a client cancel after the terminal frame does not overwrite the trace success', async () => {
    // The client reads the terminal frame, then cancels while the async usage
    // lookup is still settling. The trace outcome was decided at the terminal
    // frame and must stay success — not be flipped to cancelled.
    const completedFrame =
      'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","id":"resp_1","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n';
    const encoder = new TextEncoder();
    let frameSent = false;
    const captured = createUsageCapture().passthrough({
      response: new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            // Emit the terminal frame, then leave the stream open (no more data)
            // until the client cancels — cancel unblocks via the cancel handler.
            if (!frameSent) {
              frameSent = true;
              controller.enqueue(encoder.encode(completedFrame));
            }
          },
          cancel() {},
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
    });

    const reader = captured.value.body!.getReader();
    await reader.read(); // terminal frame
    await reader.cancel('client stopped');

    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    expect('usage' in completion ? completion.usage : undefined).toMatchObject({ inputTokens: 2, outputTokens: 3 });
  });

  test('OpenAICompatible resolves at [DONE] with usage from the trailing frame', async () => {
    let releaseTail: (() => void) | undefined;
    const tailGate = new Promise<void>((r) => (releaseTail = r));
    const finishFrame = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
    // The usage arrives AFTER finish_reason (stream_options.include_usage), then [DONE].
    // Resolving on finish_reason would drop this usage; the terminal must be [DONE].
    const captured = createUsageCapture().passthrough({
      response: new Response(
        framedStream([finishFrame], async () => {
          await tailGate;
          return 'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\ndata: [DONE]\n\n';
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    // Drain the client body to drive pulls; finish_reason alone must NOT resolve —
    // completion waits for the trailing usage frame + [DONE].
    releaseTail?.();
    const [completion, body] = await Promise.all([captured.completion, captured.value.text()]);
    expect(completion.outcome).toBe('success');
    expect('usage' in completion ? completion.usage : undefined).toMatchObject({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
    expect(body).toContain('[DONE]');
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
