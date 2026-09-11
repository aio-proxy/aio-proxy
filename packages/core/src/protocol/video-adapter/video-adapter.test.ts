import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { REQUEST_BODY_LIMITS } from '../request';
import { defineVideoProtocolAdapter } from './video-adapter';

describe('defineVideoProtocolAdapter', () => {
  test('freezes a video adapter with no convert hooks', () => {
    const adapter = defineVideoProtocolAdapter({
      protocol: ProviderProtocol.OpenAIVideo,
      async parse() {
        return { model: 'sora-2' };
      },
      model: (request) => request.model,
      wantsStream: () => false,
      async rawRequest(raw) {
        return raw;
      },
      errors: {
        requestError: () => undefined,
        modelNotFound: () => new Response(null, { status: 404 }),
        previousResponseConflict: () => new Response(null, { status: 409 }),
        tooLarge: () => new Response(null, { status: 413 }),
        unsupportedContentEncoding: () => new Response(null, { status: 415 }),
        unsupported: (feature) => Response.json({ feature }, { status: 501 }),
        provider: () => undefined,
        rateLimited: () => new Response(null, { status: 429 }),
      },
    });

    expect(Object.isFrozen(adapter)).toBe(true);
    expect(adapter.capability).toBe('video');
    expect(adapter.protocol).toBe(ProviderProtocol.OpenAIVideo);
    expect(adapter.convertSkipReason?.({ model: 'sora-2' }, 'sora-2')).toBe('video_convert');
    expect(adapter.bodyLimits(new Request('https://x'), undefined)).toEqual(REQUEST_BODY_LIMITS);
    expect('modelInvocation' in adapter).toBe(false);
    expect('imageInvocation' in adapter).toBe(false);
  });
});
