import { type DashboardRoutingModelMutation, DashboardRoutingModelMutationSchema } from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';

import { ConfigPathMissingError } from '../../config-store';
import { ModelRoutingStaleRevisionError } from '../../model-routing';
import type { ServerState } from '../../server-state';

const routingMutationValidator = validator('json', (raw, context) => {
  const parsed = DashboardRoutingModelMutationSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation_failed' } as const, 400);
}) as unknown as MiddlewareHandler<
  Record<string, never>,
  string,
  {
    in: { json: DashboardRoutingModelMutation };
    out: { json: DashboardRoutingModelMutation };
  }
>;

export const createDashboardRoutingRoutes = (state: ServerState) =>
  new Hono()
    .get('/routing/models', async (context) => context.json(await state.modelRouting.list()))
    .put('/routing/models', routingMutationValidator, async (context) => {
      try {
        return context.json(await state.modelRouting.update(context.req.valid('json')));
      } catch (error) {
        if (error instanceof ConfigPathMissingError) return context.json({ error: 'config_unavailable' }, 409);
        if (error instanceof ModelRoutingStaleRevisionError) return context.json({ error: 'stale_revision' }, 409);
        throw error;
      }
    });
