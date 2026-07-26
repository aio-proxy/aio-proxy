import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';
import { compress, compressionFormats, encoder, responsesTerminal } from './openai-stream-fetch.test-support';

describe('createOpenAIStreamFetch', () => {
  test('closes after a compressed terminal without requesting the next encoded chunk', async () => {
    for (const encoding of Object.keys(compressionFormats) as (keyof typeof compressionFormats)[]) {
      let pulls = 0;
      const encodedTerminal = await compress(encoding, encoder.encode(responsesTerminal));
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encodedTerminal);
              return;
            }
            controller.enqueue(Uint8Array.of(0xff));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const fetch = createOpenAIStreamFetch('openai-response', async () => {
        return new Response(body, {
          headers: {
            'content-type': 'text/event-stream',
            'content-encoding': encoding,
          },
        });
      });
      const response = await fetch('https://example.test/stream');
      expect(await response.text()).toBe(responsesTerminal);
      await Bun.sleep(10);
      expect(pulls).toBe(1);
    }
  });

  test('decodes compressed non-SSE JSON and never suppresses its errors', async () => {
    const json = JSON.stringify({ ok: true, value: 42 });
    const encoded = await compress('gzip', encoder.encode(json));
    const okFetch = createOpenAIStreamFetch('openai-response', async () => {
      return new Response(encoded, {
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
      });
    });
    expect(await (await okFetch('https://example.test/json')).text()).toBe(json);

    const bad = encoded.subarray(0, 6);
    const errFetch = createOpenAIStreamFetch('openai-response', async () => {
      return new Response(bad, {
        headers: {
          'content-type': 'application/json',
          'content-encoding': 'gzip',
        },
      });
    });
    await expect(errFetch('https://example.test/json').then((r) => r.text())).rejects.toBeDefined();
  });
});
