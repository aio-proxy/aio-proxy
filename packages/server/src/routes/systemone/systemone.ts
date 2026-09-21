import { typeSafeSystemOneAdapter } from '@aio-proxy/core';
import { Hono } from 'hono';

import type { ProviderRouteSource } from '../../runtime';
import { handleProtocolRequest } from '../pipeline';

export function createSystemOneRoutes(source: ProviderRouteSource) {
  return new Hono().post('/v1/systemone', (context) =>
    handleProtocolRequest({
      adapter: typeSafeSystemOneAdapter,
      context: {},
      httpRoute: '/v1/systemone',
      rawRequest: context.req.raw,
      source,
    }),
  );
}
