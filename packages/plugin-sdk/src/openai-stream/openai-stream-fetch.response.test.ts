import { describe, expect, test } from 'bun:test';

import { createOpenAIStreamFetch } from './openai-stream-fetch';
import { compress, encoder, responsesTerminal } from './openai-stream-fetch.test-support';

describe('createOpenAIStreamFetch', () => {
  test('preserves a bodyless upstream response', async () => {
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async () => new Response(null, { status: 204, headers: { 'x-request-id': 'req-empty' } }),
    );

    const response = await fetch('https://example.test/empty');
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get('x-request-id')).toBe('req-empty');
  });

  test('rejects a bodyless Responses event stream without a terminal event', async () => {
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async () => new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
    );

    await expect(fetch('https://example.test/empty-stream').then((response) => response.text())).rejects.toThrow(
      /terminal event/i,
    );
  });

  test('passes through an error-status event stream without enforcing a terminal event', async () => {
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async () =>
        new Response('data: {"error":"upstream 503"}\n\n', {
          status: 503,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    const response = await fetch('https://example.test/error-stream');
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('data: {"error":"upstream 503"}\n\n');
  });

  test('preserves representation headers on an unencoded non-SSE response', async () => {
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async () =>
        new Response('error', {
          status: 400,
          headers: { 'content-type': 'application/json', 'content-length': '5' },
        }),
    );

    const response = await fetch('https://example.test/error');
    expect(response.headers.get('content-length')).toBe('5');
    expect(await response.text()).toBe('error');
  });

  test('preserves representation headers on an identity-encoded non-SSE response', async () => {
    const fetch = createOpenAIStreamFetch(
      'openai-response',
      async () =>
        new Response('error', {
          status: 400,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'identity',
            'content-length': '5',
          },
        }),
    );

    const response = await fetch('https://example.test/error');
    expect(response.headers.get('content-encoding')).toBe('identity');
    expect(response.headers.get('content-length')).toBe('5');
    expect(await response.text()).toBe('error');
  });

  test('removes stale Content-Encoding and Content-Length while preserving status and statusText', async () => {
    const encoded = await compress('gzip', encoder.encode(responsesTerminal));
    const fetch = createOpenAIStreamFetch('openai-response', async () => {
      return new Response(encoded, {
        status: 201,
        statusText: 'Created',
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(encoded.byteLength),
          'x-request-id': 'req-1',
        },
      });
    });
    const response = await fetch('https://example.test/stream');
    expect(response.status).toBe(201);
    expect(response.statusText).toBe('Created');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(await response.text()).toBe(responsesTerminal);
  });

  test('protects a platform-decoded unexpected SSE without decoding its stale encoding again', async () => {
    const fetch = createOpenAIStreamFetch('openai-response', async () => {
      return new Response(responsesTerminal, {
        headers: {
          'content-type': 'text/event-stream',
          'content-encoding': 'gzip',
          'content-length': String(responsesTerminal.length),
        },
      });
    });

    const response = await fetch('https://example.test/non-stream-sse', undefined, { upstreamStream: false });

    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(await response.text()).toBe(responsesTerminal);
  });
});
