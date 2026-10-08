import { DashboardOverviewRangeSchema } from '@aio-proxy/types';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import type { ServerState } from '../../server-state';

const DashboardOverviewQuerySchema = z.object({
  range: DashboardOverviewRangeSchema,
  callerId: z.string().min(1).max(128).optional(),
});

const overviewValidator = validator('query', (raw, context) => {
  const parsed = DashboardOverviewQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

export const createDashboardOverviewRoute = (state: ServerState) =>
  new Hono()
    .get('/', overviewValidator, (context) => {
      const overview = state.traceStore.overviewDashboard(context.req.valid('query'));
      return context.json({
        ...overview,
        summary: { ...overview.summary, providerCount: state.currentConfig().providers.length },
      });
    })
    .get('/diagnostics', overviewValidator, (context) =>
      context.json(state.traceStore.overviewDashboardDiagnostics(context.req.valid('query'))),
    )
    .get(
      '/activity',
      validator('query', (raw, context) => {
        const parsed = DashboardOverviewQuerySchema.pick({ callerId: true }).safeParse(raw);
        return parsed.success ? parsed.data : context.json({ error: 'validation failed' }, 400);
      }),
      (context) => context.json(state.traceStore.overviewDashboardActivity(context.req.valid('query'))),
    )
    .get('/callers', (context) => {
      for (const entry of state.currentConfig().server.apiKeys) state.traceStore.resolveUsageCaller(entry);
      return context.json(state.traceStore.usageCallers());
    })
    .get('/caller-ranking', overviewValidator, (context) => {
      for (const entry of state.currentConfig().server.apiKeys) state.traceStore.resolveUsageCaller(entry);
      return context.json(state.traceStore.callerRanking(context.req.valid('query')));
    });
