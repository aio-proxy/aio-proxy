import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';

describe('createOpenAIStreamFetch', () => {
  test('advertises gzip, deflate, br, zstd and disables Bun decompression', async () => {
    let seenHeaders: Headers | undefined;
    let seenDecompress: unknown;
    const fetch = createOpenAIStreamFetch('openai-response', async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      seenDecompress = (init as { decompress?: boolean } | undefined)?.decompress;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    await fetch('https://example.test/v1');
    expect(seenHeaders?.get('accept-encoding')).toBe('gzip, deflate, br, zstd');
    expect(seenDecompress).toBe(false);
  });

  test('allows a caller to request an identity upstream response', async () => {
    let seenHeaders: Headers | undefined;
    let seenDecompress: unknown;
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        seenDecompress = (init as { decompress?: boolean } | undefined)?.decompress;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
      { acceptEncoding: 'identity' },
    );

    await fetch('https://example.test/v1');

    expect(seenHeaders?.get('accept-encoding')).toBe('identity');
    expect(seenDecompress).toBe(false);
  });

  test('preserves method, body, signal, redirect, and caller headers other than Accept-Encoding', async () => {
    const signal = AbortSignal.timeout(5_000);
    let seen: Request | undefined;
    let seenInit: RequestInit | undefined;
    const fetch = createOpenAIStreamFetch('openai-compatible', async (input, init) => {
      seen = input instanceof Request ? input : new Request(input, init);
      seenInit = init;
      return new Response('ok');
    });
    await fetch('https://example.test/chat', {
      method: 'POST',
      body: JSON.stringify({ ping: true }),
      signal,
      redirect: 'manual',
      headers: {
        authorization: 'Bearer test',
        'x-custom': 'keep-me',
        'accept-encoding': 'identity',
      },
    });
    expect(seen?.method).toBe('POST');
    expect(await seen?.text()).toBe(JSON.stringify({ ping: true }));
    expect(seen?.signal).toBe(signal);
    expect(seenInit?.redirect ?? seen?.redirect).toBe('manual');
    const headers = new Headers(seenInit?.headers);
    expect(headers.get('authorization')).toBe('Bearer test');
    expect(headers.get('x-custom')).toBe('keep-me');
    expect(headers.get('accept-encoding')).toBe('gzip, deflate, br, zstd');
  });
});
