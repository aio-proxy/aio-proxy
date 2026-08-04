import { UsageOverviewGroupBySchema, UsageOverviewMetricSchema, UsageOverviewRangeSchema } from '@aio-proxy/types';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import type { DashboardAuthentication } from '../dashboard-auth';
import type { ServerState } from '../server-state';
import { createDashboardEventsRoute } from './events';
import { createDashboardOAuthLoginRoutes } from './oauth-login';
import { createDashboardOverviewRoute } from './overview';
import { createDashboardProviderDraftRoutes } from './provider-draft';
import { createDashboardProviderReadRoutes } from './provider-routes';
import { redactSecrets } from './provider-secrets';
import { createDashboardProviderWriteRoutes } from './provider-write-routes';
import { createDashboardSettingsRoute } from './settings';
import { createDashboardTraceRoutes } from './traces';

export { redactSecrets } from './provider-secrets';

const UsageOverviewQuerySchema = z.object({
  range: UsageOverviewRangeSchema.default('24h'),
  metric: UsageOverviewMetricSchema.default('cost'),
  groupBy: UsageOverviewGroupBySchema.default('model'),
});

const usageOverviewValidator = validator('query', (raw, context) => {
  const parsed = UsageOverviewQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

export const createDashboardRoutes = (state: ServerState, auth: DashboardAuthentication) =>
  new Hono()
    .get('/config', (context) => context.json(redactSecrets(state.currentConfig())))
    .get('/oauth/capabilities', (context) => context.json({ capabilities: state.oauthCapabilities() }))
    .route('/oauth', createDashboardOAuthLoginRoutes(state))
    .route('/', createDashboardProviderReadRoutes(state))
    .route('/', createDashboardProviderDraftRoutes(state))
    .route('/', createDashboardProviderWriteRoutes(state))
    .get('/usage', usageOverviewValidator, (context) => {
      const query = context.req.valid('query');
      return context.json(state.traceStore.overview(query));
    })
    .route('/overview', createDashboardOverviewRoute(state))
    .route('/settings', createDashboardSettingsRoute(state))
    .route('/traces', createDashboardTraceRoutes(state))
    .route('/events', createDashboardEventsRoute(state, auth))
    .post('/reload', async (context) => {
      const result = await state.reload();
      if (result.ok) {
        return context.json({ ok: true, diff: result.diff });
      }
      return context.json({ ok: false, error: result.error, stage: result.stage }, 409);
    });
