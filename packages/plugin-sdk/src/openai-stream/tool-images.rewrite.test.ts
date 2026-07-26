import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';
import { createToolImageMarker } from './tool-image-trust';

describe('createOpenAIStreamFetch tool images', () => {
  test('rewrites marked SDK tool content to ordered CPA image_url parts', async () => {
    let captured: Request | undefined;
    const fetch = createOpenAIStreamFetch(
      'openai-compatible',
      async (input, init) => {
        captured = new Request(input, init);
        return Response.json({ ok: true });
      },
      { rewriteToolImages: true },
    );
    const body = {
      model: 'gpt-test',
      temperature: 0.2,
      messages: [
        { role: 'user', content: 'inspect' },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify([
            { type: 'text', text: 'before' },
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: 'AA==' },
              providerOptions: {
                openai: { imageDetail: 'high' },
                aioProxy: createToolImageMarker(),
              },
            },
            {
              type: 'file',
              mediaType: 'image',
              data: { type: 'url', url: 'https://example.test/second.png' },
              providerOptions: { aioProxy: createToolImageMarker() },
            },
            { type: 'text', text: 'after' },
          ]),
        },
      ],
    };

    await fetch('https://example.test/v1/chat/completions?trace=1', {
      method: 'POST',
      headers: {
        'content-encoding': 'gzip',
        'content-length': '999',
        'content-type': 'application/json',
        'x-client': 'kept',
      },
      body: JSON.stringify(body),
    });

    expect(captured?.url).toBe('https://example.test/v1/chat/completions?trace=1');
    expect(captured?.headers.get('content-encoding')).toBeNull();
    expect(captured?.headers.get('content-length')).toBeNull();
    expect(captured?.headers.get('x-client')).toBe('kept');
    expect(await captured?.json()).toEqual({
      model: 'gpt-test',
      temperature: 0.2,
      messages: [
        { role: 'user', content: 'inspect' },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
            { type: 'image_url', image_url: { url: 'https://example.test/second.png' } },
            { type: 'text', text: 'after' },
          ],
        },
      ],
    });
  });
});
