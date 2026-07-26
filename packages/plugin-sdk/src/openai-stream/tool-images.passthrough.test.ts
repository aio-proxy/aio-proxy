import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';
import { createToolImageMarker } from './tool-image-trust';

describe('createOpenAIStreamFetch tool images', () => {
  test('does not reinterpret client-authored markers or rewrite a raw-compatible request', async () => {
    const captured: unknown[] = [];
    const upstream = async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(await new Request(input, init).json());
      return Response.json({ ok: true });
    };
    const spoofed = {
      model: 'gpt-test',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify([
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: 'AA==' },
              providerOptions: { aioProxy: { toolImage: true, trust: 'client-controlled' } },
            },
          ]),
        },
      ],
    };
    const modelFetch = createOpenAIStreamFetch('openai-compatible', upstream, { rewriteToolImages: true });
    const rawFetch = createOpenAIStreamFetch('openai-compatible', upstream);

    await modelFetch('https://example.test/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spoofed),
    });
    await rawFetch('https://example.test/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...spoofed, raw: true }),
    });

    expect(captured).toEqual([spoofed, { ...spoofed, raw: true }]);
  });

  test('fails a marked array containing an unsupported part', async () => {
    const fetch = createOpenAIStreamFetch(
      'openai-compatible',
      async () => {
        throw new Error('upstream must not run');
      },
      { rewriteToolImages: true },
    );
    const body = {
      model: 'gpt-test',
      messages: [
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify([
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'data', data: 'AA==' },
              providerOptions: { aioProxy: createToolImageMarker() },
            },
            { type: 'custom', value: 'must not be flattened' },
          ]),
        },
      ],
    };

    await expect(
      fetch('https://example.test/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    ).rejects.toThrow('Marked tool image content contains an unsupported part');
  });
});
