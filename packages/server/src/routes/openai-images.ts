import { openAIImagesAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../runtime';
import { handleProtocolRequest } from './pipeline';

export function createOpenAIImagesRoutes(source: ProviderRouteSource) {
  return new Hono()
    .post('/v1/images/generations', (context) =>
      handleProtocolRequest({
        adapter: openAIImagesAdapter,
        context: { operation: 'generations' },
        rawRequest: context.req.raw,
        source,
      }),
    )
    .post('/v1/images/edits', (context) =>
      handleProtocolRequest({
        adapter: openAIImagesAdapter,
        context: { operation: 'edits' },
        rawRequest: context.req.raw,
        source,
      }),
    );
}
