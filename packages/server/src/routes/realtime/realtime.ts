import { Hono } from 'hono';

import type { CallerPrincipalEnv } from '../../caller-principal';
import { realtimeCapabilityNotSupported } from './errors';
import { handleRealtimeHangup } from './hangup';
import { handleRealtimeSideband } from './sideband';
import { handleRealtimeCreate } from './signaling';
import type { RealtimeRouteSource } from './source';

/** The ChatGPT/Codex OAuth upstream has no equivalent capability. Registering
 *  these converts a confusing 404 into a diagnosable 501. */
export const UNSUPPORTED_REALTIME_ROUTES = [
  { method: 'post', path: '/v1/realtime/client_secrets' },
  { method: 'post', path: '/v1/realtime/sessions' },
  { method: 'post', path: '/v1/realtime/transcription_sessions' },
  { method: 'get', path: '/v1/realtime/translations' },
  { method: 'post', path: '/v1/realtime/translations' },
  { method: 'post', path: '/v1/realtime/translations/client_secrets' },
  { method: 'post', path: '/v1/realtime/calls/:call_id/accept' },
  { method: 'post', path: '/v1/realtime/calls/:call_id/reject' },
  { method: 'post', path: '/v1/realtime/calls/:call_id/refer' },
] as const;

export function createRealtimeRoutes(source: RealtimeRouteSource) {
  const app = new Hono<CallerPrincipalEnv>();

  // Registered before the create/sideband routes so `/v1/realtime/translations`
  // cannot be shadowed by a broader realtime pattern.
  for (const route of UNSUPPORTED_REALTIME_ROUTES) {
    app[route.method](route.path, () => realtimeCapabilityNotSupported());
  }

  app.post('/v1/realtime/calls/:call_id/hangup', (context) => handleRealtimeHangup(context, source));

  app.post('/v1/live', (context) => handleRealtimeCreate(context, source, 'live'));
  app.post('/v1/realtime', (context) => handleRealtimeCreate(context, source, 'realtime-query'));
  app.post('/v1/realtime/calls', (context) => handleRealtimeCreate(context, source, 'realtime-calls'));

  app.get('/v1/live/:call_id', (context) => handleRealtimeSideband(context, source, 'live'));
  app.get('/v1/realtime/calls/:call_id', (context) => handleRealtimeSideband(context, source, 'realtime-calls'));
  // With `call_id` this is a sideband attach; without it, a direct connection.
  app.get('/v1/realtime', (context) =>
    handleRealtimeSideband(
      context,
      source,
      context.req.query('call_id') === undefined ? 'realtime-direct' : 'realtime-query',
    ),
  );

  return app;
}
