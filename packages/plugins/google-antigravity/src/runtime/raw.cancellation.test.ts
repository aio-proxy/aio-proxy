import { describe, expect, test } from 'bun:test';

import { createGeminiRawResolver } from './raw';
import { logicalContext, resolve } from './raw.test-support';

describe('Gemini raw resolver', () => {
  test('propagates non-Error caller cancellation without provider replay', async () => {
    const reason = { kind: 'caller-cancelled' };
    const abort = new AbortController();
    abort.abort(reason);
    const resolver = createGeminiRawResolver({
      execute: async () => {
        throw reason;
      },
    });
    const request = new Request('http://localhost/v1beta/models/gemini-3-flash-agent:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: abort.signal,
    });

    await expect(resolve(resolver, 'gemini')?.invoke(request, logicalContext())).rejects.toBe(reason);
  });

  test('propagates caller cancellation while reading the request body', async () => {
    const reason = { kind: 'body-read-cancelled' };
    const abort = new AbortController();
    let executions = 0;
    const resolver = createGeminiRawResolver({
      execute: async () => {
        executions += 1;
        return Response.json({ response: {} });
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        abort.abort(reason);
        controller.error(reason);
      },
    });
    const request = new Request('http://localhost/v1beta/models/gemini-3-flash-agent:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: abort.signal,
    });

    await expect(resolve(resolver, 'gemini')?.invoke(request, logicalContext())).rejects.toBe(reason);
    expect(executions).toBe(0);
  });

  test('propagates caller cancellation while reading a successful upstream JSON body', async () => {
    const reason = { kind: 'response-body-cancelled' };
    const abort = new AbortController();
    const resolver = createGeminiRawResolver({
      execute: async () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            abort.abort(reason);
            controller.error(reason);
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    const request = new Request('http://localhost/v1beta/models/gemini-3-flash-agent:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: abort.signal,
    });

    await expect(resolve(resolver, 'gemini')?.invoke(request, logicalContext())).rejects.toBe(reason);
  });
});
