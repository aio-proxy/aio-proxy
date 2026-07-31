import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';

describe('createOpenAIStreamFetch', () => {
  test('defaults managed upstream streams to identity and controlled decoding', async () => {
    const seen: { encoding?: string | null; decompress?: boolean } = {};
    const fetch = createOpenAIStreamFetch('openai-response', async (input, init) => {
      seen.encoding = new Request(input, init).headers.get('accept-encoding');
      seen.decompress = (init as { decompress?: boolean } | undefined)?.decompress;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    await fetch('https://example.test/v1');
    expect(seen).toEqual({ encoding: 'identity', decompress: false });
  });

  test('applies a configured upstream encoding fallback', async () => {
    let seenHeaders: Headers | undefined;
    let seenDecompress: unknown;
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        seenDecompress = (init as { decompress?: boolean } | undefined)?.decompress;
        return new Response('{}', { headers: { 'content-type': 'application/json' } });
      },
      { acceptEncoding: 'br' },
    );

    await fetch('https://example.test/v1');

    expect(seenHeaders?.get('accept-encoding')).toBe('br');
    expect(seenDecompress).toBe(false);
  });

  test('true non-stream calls leave encoding and decompression to Bun', async () => {
    let initSeen: (RequestInit & { decompress?: boolean }) | undefined;
    const fetch = createOpenAIStreamFetch('openai-response', async (_input, init) => {
      initSeen = init;
      return Response.json({ ok: true });
    });

    await fetch('https://example.test', undefined, { upstreamStream: false });

    expect(new Headers(initSeen?.headers).has('accept-encoding')).toBe(false);
    expect(Object.hasOwn(initSeen ?? {}, 'decompress')).toBe(false);
  });

  test('per-call stream policy takes precedence over the wrapper default', async () => {
    const seen: Array<{ readonly encoding: string | null; readonly decompress: unknown }> = [];
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async (input, init) => {
        seen.push({
          encoding: new Request(input, init).headers.get('accept-encoding'),
          decompress: (init as { decompress?: boolean } | undefined)?.decompress,
        });
        return Response.json({ ok: true });
      },
      { upstreamStream: false },
    );

    await fetch('https://example.test/default');
    await fetch('https://example.test/override', undefined, { upstreamStream: true });

    expect(seen).toEqual([
      { encoding: null, decompress: undefined },
      { encoding: 'identity', decompress: false },
    ]);
  });

  test('request header beats plugin fallback and per-call stream default', async () => {
    let encoding: string | null = null;
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async (input, init, ...rest: unknown[]) => {
        encoding = new Request(input, init).headers.get('accept-encoding');
        expect(rest).toEqual([]);
        return Response.json({ ok: true });
      },
      { acceptEncoding: 'identity', upstreamStream: true },
    );

    await fetch('https://example.test', { headers: { 'ACCEPT-ENCODING': 'gzip' } }, { upstreamStream: false });

    expect(encoding).toBe('gzip');
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
    expect(headers.get('accept-encoding')).toBe('identity');
  });
});
