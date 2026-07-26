import { describe, expect, test } from 'bun:test';

import { createKimiRuntime } from './runtime';
import { catalog, context, validCredential } from './runtime.test-support';

describe('Kimi Code runtime', () => {
  test('offers both raw protocols for every catalog language model', async () => {
    const runtime = await createKimiRuntime(context(validCredential(), catalog()));

    for (const modelId of ['openai-model', 'anthropic-model', 'raw-only-model']) {
      expect(runtime.raw?.({ protocol: 'openai-compatible', modelId })).toBeDefined();
      expect(runtime.raw?.({ protocol: 'anthropic', modelId })).toBeDefined();
    }
    expect(runtime.raw?.({ protocol: 'gemini', modelId: 'openai-model' })).toBeUndefined();
    expect(runtime.raw?.({ protocol: 'anthropic', modelId: 'missing' })).toBeUndefined();
  });

  for (const scenario of [
    { protocol: 'openai-compatible', path: '/v1/chat/completions' },
    { protocol: 'anthropic', path: '/v1/messages' },
  ] as const) {
    test(`${scenario.protocol} raw transport allowlists its path and preserves request details`, async () => {
      let captured: Request | undefined;
      let signal: AbortSignal | null | undefined;
      const runtime = await createKimiRuntime(context(validCredential('raw-token'), catalog()), {
        fetch: async (input, init) => {
          captured = new Request(input, init);
          signal = init?.signal;
          return Response.json({ ok: true });
        },
      });
      const transport = runtime.raw?.({ protocol: scenario.protocol, modelId: 'openai-model' });
      const controller = new AbortController();
      const request = new Request(`https://untrusted.example${scenario.path}?trace=1`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client': 'kept',
          host: 'attacker.example',
          cookie: 'session=client-secret',
          'proxy-authorization': 'Basic client-secret',
          authorization: 'Bearer client-secret',
          'x-api-key': 'placeholder-secret',
          'x-goog-api-key': 'placeholder-secret',
          'anthropic-api-key': 'placeholder-secret',
        },
        body: JSON.stringify({ model: 'client-model', marker: 'kept' }),
        signal: controller.signal,
        redirect: 'manual',
      });

      await transport?.invoke(request);

      expect(captured?.url).toBe(`https://api.kimi.com/coding${scenario.path}?trace=1`);
      expect(captured?.method).toBe('POST');
      expect(captured?.redirect).toBe('manual');
      expect(signal).toBe(controller.signal);
      expect(captured?.headers.get('x-client')).toBe('kept');
      expect(captured?.headers.get('authorization')).toBe('Bearer raw-token');
      for (const name of 'host cookie proxy-authorization x-api-key x-goog-api-key anthropic-api-key'.split(' ')) {
        expect(captured?.headers.get(name)).toBeNull();
      }
      expect(await captured?.json()).toEqual({ model: 'client-model', marker: 'kept' });
    });
  }

  test('rejects non-allowlisted raw paths before fetch without exposing the inbound host', async () => {
    let calls = 0;
    const runtime = await createKimiRuntime(context(validCredential(), catalog()), {
      fetch: async () => {
        calls += 1;
        return Response.json({});
      },
    });
    const transport = runtime.raw?.({ protocol: 'anthropic', modelId: 'openai-model' });
    const request = new Request('https://secret-host.example/v1/messages/client-secret-path', {
      method: 'POST',
      body: 'client-secret-body',
    });

    const error = await transport?.invoke(request).catch(String);
    expect(error).toBe('Error: Unsupported Kimi raw path');
    expect(calls).toBe(0);
  });
});
