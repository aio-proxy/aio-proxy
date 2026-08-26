import { openAIEmbeddingsAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../runtime';
import { handleProtocolRequest } from './pipeline';

export function createOpenAIEmbeddingsRoutes(source: ProviderRouteSource) {
  return new Hono().post('/v1/embeddings', (context) =>
    handleProtocolRequest({
      adapter: openAIEmbeddingsAdapter,
      context: {},
      rawRequest: context.req.raw,
      source,
    }),
  );
}
