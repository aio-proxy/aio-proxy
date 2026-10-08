import { openAIDecisionsAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../../runtime';
import { handleProtocolRequest } from '../pipeline';

export function createOpenAIDecisionsRoutes(source: ProviderRouteSource) {
  return new Hono().post('/v1/decisions', (context) =>
    handleProtocolRequest({
      adapter: openAIDecisionsAdapter,
      context: {},
      httpRoute: '/v1/decisions',
      rawRequest: context.req.raw,
      source,
    }),
  );
}
