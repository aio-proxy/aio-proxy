import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';
import { compress, encoder } from './openai-stream-fetch.test-support';

describe('createOpenAIStreamFetch', () => {
  test('propagates raw-source and decoder errors before terminal', async () => {
    const sourceError = new TypeError('raw source failed');
    const failingSource = new ReadableStream<Uint8Array>({
      pull() {
        throw sourceError;
      },
    });
    const sourceFetch = createOpenAIStreamFetch('openai-response', async () => {
      return new Response(failingSource, { headers: { 'content-type': 'text/event-stream' } });
    });
    await expect(sourceFetch('https://example.test/stream').then((r) => r.text())).rejects.toBe(sourceError);

    const truncated = (await compress('gzip', encoder.encode('data: hi\n\n'))).subarray(0, 8);
    const decoderFetch = createOpenAIStreamFetch('openai-compatible', async () => {
      return new Response(truncated, {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
        },
      });
    });
    await expect(decoderFetch('https://example.test/stream').then((r) => r.text())).rejects.toBeDefined();
  });

  test('propagates downstream cancellation to the encoded reader and every decoder once', async () => {
    let cancelCount = 0;
    let cancelReason: unknown;
    const encoded = await compress('gzip', encoder.encode('data: slow\n\n'));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel(reason) {
        cancelCount += 1;
        cancelReason = reason;
      },
    });
    const fetch = createOpenAIStreamFetch('openai-compatible', async () => {
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
        },
      });
    });
    const response = await fetch('https://example.test/stream');
    await response.body?.cancel('client-gone');
    expect(cancelCount).toBe(1);
    expect(cancelReason).toBe('client-gone');
  });

  test('rejects unsupported encoding before returning a response', async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = createOpenAIStreamFetch('openai-response', async () => {
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'lzma',
        },
      });
    });
    await expect(fetch('https://example.test/stream')).rejects.toThrow(/lzma|unsupported|encoding/i);
    expect(pulls).toBe(0);
  });
});
