import { geminiInteractionsAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../runtime';
import { handleProtocolRequest } from './pipeline';

export function createGeminiInteractionsRoutes(source: ProviderRouteSource) {
  return new Hono().post('/v1beta/interactions', (context) =>
    handleProtocolRequest({
      adapter: geminiInteractionsAdapter,
      context: {},
      rawRequest: context.req.raw,
      source,
    }),
  );
}
