import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';
import { asSchema } from 'ai';

import { defineProtocolAdapter, functionToolSet, type ProtocolAdapter } from '../../src/index';

type RequestValue = { readonly model: string };
type RouteContext = { readonly stream: boolean };

describe('defineProtocolAdapter', () => {
  test('adds the empty-dimensions default and freezes the adapter', () => {
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
