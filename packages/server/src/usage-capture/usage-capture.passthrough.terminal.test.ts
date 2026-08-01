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
