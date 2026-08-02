import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../../runtime';
import { counter, countFixture, requestedModel } from '../token-count.test-support';

function rawAnthropicProvider(
  id: string,
  seen: { url?: string; model?: string },
  kind: RuntimeProviderInstance['kind'] = ProviderKind.Api,
): RuntimeProviderInstance {
  return {
    id,
    kind,
    enabled: true,
    alias: { [requestedModel]: { model: `${id}-wire`, preserve: false } },
    raw: {
      resolve: ({ protocol, modelId }) =>
        protocol === ProviderProtocol.Anthropic
          ? {
              invoke: async (request: Request) => {
                seen.url = request.url;
                const body: unknown = await request.clone().json();
                if (body !== null && typeof body === 'object' && 'model' in body && typeof body.model === 'string') {
                  seen.model = body.model;
                }
                void modelId;
                return Response.json({ input_tokens: 4242 });
              },
            }
          : undefined,
    },
  };
}

test('forwards count_tokens upstream when a same-protocol raw provider is available', async () => {
  const seen: { url?: string; model?: string } = {};
  const fixture = countFixture([rawAnthropicProvider('relay', seen)]);
  const response = await fixture.anthropic();

  expect(response.status).toBe(200);
  // Upstream value is returned verbatim; the estimate header must be absent.
  expect(await response.json()).toEqual({ input_tokens: 4242 });
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBeNull();
  // rawRequest rewrote the client alias to the wire model and kept the count path.
  expect(seen.model).toBe('relay-wire');
  expect(seen.url).toContain('/v1/messages/count_tokens');
});

test('falls through to estimator when raw provider protocol does not match inbound', async () => {
  const seen: { url?: string; model?: string } = {};
  const openaiRaw: RuntimeProviderInstance = {
    ...rawAnthropicProvider('openai', seen),
    raw: {
      resolve: ({ protocol }) =>
        protocol === ProviderProtocol.OpenAIResponse ? { invoke: async () => Response.json({}) } : undefined,
    },
  };
  const fixture = countFixture([openaiRaw]);
  const response = await fixture.anthropic();
  expect(response.status).toBe(200);
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBe('true');
  expect(seen.url).toBeUndefined(); // upstream never called
});

test('cancels the upstream body and falls through when the raw provider returns a non-2xx response', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull() {
      // Never emits; only the reader/cancel path matters.
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider: RuntimeProviderInstance = {
    id: 'failing',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { [requestedModel]: { model: 'failing-wire', preserve: false } },
    raw: {
      resolve: ({ protocol }) =>
        protocol === ProviderProtocol.Anthropic
          ? { invoke: async () => new Response(body, { status: 500 }) }
          : undefined,
    },
  };
  const fixture = countFixture([provider]);
  const response = await fixture.anthropic();

  // No further candidate, so the route falls through to the estimator.
  expect(response.status).toBe(200);
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBe('true');
  // The abandoned upstream stream must be released, not leaked.
  expect(cancelled).toBe(true);
});

test('a raw failure advances to the next candidate without invoking the same provider tokenCount', async () => {
  const tokenCountCalls: string[] = [];
  const withBoth: RuntimeProviderInstance = {
    id: 'both',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { [requestedModel]: { model: 'both-wire', preserve: false } },
    raw: {
      resolve: ({ protocol }) =>
        protocol === ProviderProtocol.Anthropic
          ? { invoke: async () => Response.json({}, { status: 500 }) }
          : undefined,
    },
    tokenCount: {
      countTokens: counter('both', 111, tokenCountCalls),
    },
  };
  const fixture = countFixture([withBoth]);
  const response = await fixture.anthropic();

  // Raw failed → advance to next candidate (here none), so estimate; the SAME provider's
  // tokenCount must NOT fire a second upstream request.
  expect(response.status).toBe(200);
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBe('true');
  expect(tokenCountCalls).toEqual([]);
});

test('does not raw-forward a non-anthropic provider and lets it use its own tokenCount', async () => {
  let rawInvoked = false;
  const tokenCountCalls: string[] = [];
  const geminiWithRaw: RuntimeProviderInstance = {
    id: 'gemini',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { [requestedModel]: { model: 'gemini-wire', preserve: false } },
    raw: {
      resolve: ({ protocol }) =>
        protocol === ProviderProtocol.Gemini
          ? {
              invoke: async () => {
                rawInvoked = true;
                return Response.json({ totalTokens: 9999 });
              },
            }
          : undefined,
    },
    tokenCount: {
      countTokens: counter('gemini', 321, tokenCountCalls),
    },
  };
  const fixture = countFixture([geminiWithRaw]);
  const response = await fixture.gemini();

  expect(response.status).toBe(200);
  // The gemini adapter is out of the raw-forward scope: raw.invoke is never called,
  // and the provider's own tokenCount capability answers the count.
  expect(rawInvoked).toBe(false);
  expect(tokenCountCalls).toEqual(['gemini']);
  expect(await response.json()).toEqual({ totalTokens: 321 });
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBeNull();
});

test('raw-forwards an OAuth-kind provider that exposes an anthropic raw capability', async () => {
  const seen: { url?: string; model?: string } = {};
  const fixture = countFixture([rawAnthropicProvider('plugin', seen, ProviderKind.OAuth)]);
  const response = await fixture.anthropic();

  expect(response.status).toBe(200);
  // Plugin/OAuth providers with an anthropic raw capability are forwarded, not estimated.
  expect(await response.json()).toEqual({ input_tokens: 4242 });
  expect(response.headers.get('x-aio-proxy-token-count-estimated')).toBeNull();
  expect(seen.model).toBe('plugin-wire');
  expect(seen.url).toContain('/v1/messages/count_tokens');
});
