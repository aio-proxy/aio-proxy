import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';
import { asSchema } from 'ai';

import {
  defineEmbeddingProtocolAdapter,
  defineProtocolAdapter,
  functionToolSet,
  readJsonRequest,
  RequestBodyTooLargeError,
  withRequestBodyLimits,
  type ProtocolAdapter,
} from '../../index';

type RequestValue = { readonly model: string };
type RouteContext = { readonly stream: boolean };

test('defineEmbeddingProtocolAdapter freezes capability embedding and omits stream/session defaults', async () => {
  const adapter = defineEmbeddingProtocolAdapter({
    capability: 'embedding',
    protocol: ProviderProtocol.OpenAICompatible,
    parse: async () => ({ model: 'm' }),
    model: (request) => request.model,
    rawRequest: async (raw) => raw,
    embeddingInvocation: () => ({ values: [{ value: 'hi' }] }),
    embeddingJson: (result) => result.embeddings,
    errors: {
      requestError: () => undefined,
      modelNotFound: (message) => Response.json({ message }, { status: 404 }),
      previousResponseConflict: () => new Response(null, { status: 409 }),
      tooLarge: () => new Response(null, { status: 413 }),
      unsupportedContentEncoding: () => new Response(null, { status: 415 }),
      unsupported: () => new Response(null, { status: 501 }),
      provider: () => undefined,
      rateLimited: () => new Response(null, { status: 429 }),
    },
  });
  await withRequestBodyLimits({ encoded: 8, decoded: 8 }, async () => {
    const raw = new Request('https://proxy.test', { method: 'POST', body: '{"model":"too-long"}' });
    await expect(readJsonRequest(raw, adapter.bodyLimits(raw, undefined))).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });
  expect(adapter.capability).toBe('embedding');
  expect(adapter.wantsStream({ model: 'm' }, { stream: true })).toBe(false);
});

describe('defineProtocolAdapter', () => {
  test('adds the empty-dimensions default and freezes the adapter', async () => {
    const adapter = defineProtocolAdapter<RequestValue, RouteContext>({
      protocol: ProviderProtocol.OpenAICompatible,
      async parse(raw) {
        return (await raw.clone().json()) as RequestValue;
      },
      model: (request) => request.model,
      wantsStream: (_request, context) => context.stream,
      async rawRequest(raw) {
        return raw.clone();
      },
      modelInvocation: () => ({ messages: [] }),
      modelJson: async () => ({ ok: true }),
      modelSse: () => Object.assign(new ReadableStream<Uint8Array>(), { completion: Promise.resolve() }),
      errors: {
        requestError: () => undefined,
        modelNotFound: (message) => Response.json({ message }, { status: 404 }),
        previousResponseConflict: () => new Response(null, { status: 409 }),
        tooLarge: () => new Response(null, { status: 413 }),
        unsupportedContentEncoding: () => new Response(null, { status: 415 }),
        unsupported: () => new Response(null, { status: 501 }),
        provider: () => undefined,
        rateLimited: (s) => {
          const r = new Response(null, { status: 429 });
          r.headers.set('retry-after', String(s));
          return r;
        },
      },
    });

    expect(adapter.dimensions({ model: 'm' }, { stream: false })).toEqual({});
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.capability).toBe('language');
    expect(adapter.bodyLimits(new Request('https://x'), { stream: false })).toEqual({
      encoded: 256 * 1_024 * 1_024,
      decoded: 256 * 1_024 * 1_024,
    });
    await withRequestBodyLimits({ encoded: 8, decoded: 8 }, async () => {
      const raw = new Request('https://proxy.test', { method: 'POST', body: '{"model":"too-long"}' });
      await expect(readJsonRequest(raw, adapter.bodyLimits(raw, { stream: false }))).rejects.toBeInstanceOf(
        RequestBodyTooLargeError,
      );
    });
    const typed: ProtocolAdapter<RequestValue, RouteContext> = adapter;
    expect(typed.protocol).toBe(ProviderProtocol.OpenAICompatible);
  });
});

test('functionToolSet converts function definitions without mutating schemas', async () => {
  const schema = { type: 'object', properties: { city: { type: 'string' } } } as const;
  const tools = functionToolSet([{ name: 'weather', description: 'Weather', inputSchema: schema }]);

  expect(Object.keys(tools ?? {})).toEqual(['weather']);
  expect(tools?.weather).toMatchObject({ type: 'function', description: 'Weather' });
  expect(await asSchema(tools?.weather?.inputSchema).jsonSchema).toEqual(schema);
  expect(schema).toEqual({ type: 'object', properties: { city: { type: 'string' } } });
});

test('functionToolSet preserves __proto__ as an own enumerable tool entry', () => {
  const tools = functionToolSet([{ name: '__proto__' }]);

  expect(Object.keys(tools ?? {})).toEqual(['__proto__']);
  expect(Object.hasOwn(tools ?? {}, '__proto__')).toBe(true);
});
