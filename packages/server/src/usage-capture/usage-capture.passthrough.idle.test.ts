import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

describe('passthrough idle timeout', () => {
  test('stalled stream resolves failure with stream_idle_timeout and cancels upstream', async () => {
    let cancelled = false;
    const stalling = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
          ),
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
