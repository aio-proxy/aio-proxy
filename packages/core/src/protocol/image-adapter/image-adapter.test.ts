import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { REQUEST_BODY_LIMITS } from '../request';
import { defineImageProtocolAdapter } from './image-adapter';

describe('defineImageProtocolAdapter', () => {
  test('freezes an image adapter with capability image and no imageSse', () => {
    const adapter = defineImageProtocolAdapter({
      protocol: ProviderProtocol.OpenAIImage,
      async parse() {
        return { model: 'gpt-image-2', prompt: 'hi' };
      },
      model: (request) => request.model,
      wantsStream: () => false,
      async rawRequest(raw) {
        return raw;
      },
      imageInvocation: (request) => ({
        operation: 'generate',
        prompt: request.prompt,
        n: 1,
        responseFormat: 'b64_json',
      }),
      imageJson: async () => ({ created: 1, data: [] }),
      errors: {
        requestError: () => undefined,
        modelNotFound: (message) => Response.json({ message }, { status: 404 }),
        previousResponseConflict: () => new Response(null, { status: 409 }),
        tooLarge: () => new Response(null, { status: 413 }),
        unsupportedContentEncoding: () => new Response(null, { status: 415 }),
        unsupported: (feature) => Response.json({ feature }, { status: 501 }),
        provider: () => undefined,
        rateLimited: () => new Response(null, { status: 429 }),
      },
    });

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.capability).toBe('image');
    expect(adapter.protocol).toBe(ProviderProtocol.OpenAIImage);
    expect(adapter.bodyLimits(new Request('https://x'), undefined)).toEqual(REQUEST_BODY_LIMITS);
    expect(adapter.imageInvocation({ model: 'gpt-image-2', prompt: 'hi' }, undefined)).toMatchObject({
      operation: 'generate',
      prompt: 'hi',
      n: 1,
      responseFormat: 'b64_json',
    });
    expect('imageSse' in adapter).toBe(false);
    expect('modelInvocation' in adapter).toBe(false);
  });

  test('uses route-specific bodyLimits when provided', () => {
    const adapter = defineImageProtocolAdapter({
      protocol: ProviderProtocol.OpenAIImage,
      bodyLimits: () => ({ encoded: 357_564_416, decoded: 357_564_416 }),
      async parse() {
        return { model: 'gpt-image-2', prompt: 'hi' };
      },
      model: (request) => request.model,
      wantsStream: () => false,
      async rawRequest(raw) {
        return raw;
      },
      imageInvocation: () => ({ operation: 'generate', prompt: 'hi', n: 1, responseFormat: 'b64_json' }),
      imageJson: async () => ({}),
      errors: {
        requestError: () => undefined,
        modelNotFound: () => new Response(null, { status: 404 }),
        previousResponseConflict: () => new Response(null, { status: 409 }),
        tooLarge: () => new Response(null, { status: 413 }),
        unsupportedContentEncoding: () => new Response(null, { status: 415 }),
        unsupported: () => new Response(null, { status: 501 }),
        provider: () => undefined,
        rateLimited: () => new Response(null, { status: 429 }),
      },
    });
    expect(adapter.bodyLimits(new Request('https://x'), undefined)).toEqual({
      encoded: 357_564_416,
      decoded: 357_564_416,
    });
  });
});
