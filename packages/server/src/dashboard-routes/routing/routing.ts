import {
  type DashboardRoutingModelMutation,
  DashboardRoutingModelMutationSchema,
  UsageOverviewRangeSchema,
} from '@aio-proxy/types';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import { ConfigPathMissingError, ConfigReloadRejectedError } from '../../config-store';
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

const RoutingTrafficQuerySchema = z.object({ range: UsageOverviewRangeSchema });

// A model id can contain slashes, so it travels as a query parameter rather than a path segment.
const RoutingTrafficBucketsQuerySchema = RoutingTrafficQuerySchema.extend({ model: z.string().min(1) });

// One factory keeps the rejection body identical across every query validator in this file.
// GET validation failures deliberately reuse the mutation error vocabulary: `validation_failed`
// is a member of DashboardRoutingMutationErrorCodeSchema, and matching the mutation validator
// above keeps one rejection shape across this file, even though overview/overview.ts differs.
const queryValidator = <Schema extends z.ZodType>(schema: Schema) =>
  validator('query', (raw, context) => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : context.json({ error: 'validation_failed' } as const, 400);
  });

const trafficValidator = queryValidator(RoutingTrafficQuerySchema);

const trafficBucketsValidator = queryValidator(RoutingTrafficBucketsQuerySchema);

export const createDashboardRoutingRoutes = (state: ServerState) =>
  new Hono()
    .get('/routing/models', async (context) => context.json(await state.modelRouting.list()))
    .put('/routing/models', routingMutationValidator, async (context) => {
      try {
        return context.json(await state.modelRouting.update(context.req.valid('json')));
      } catch (error) {
        if (error instanceof ConfigPathMissingError) return context.json({ error: 'config_unavailable' }, 409);
        if (error instanceof ModelRoutingStaleRevisionError) return context.json({ error: 'stale_revision' }, 409);
        if (error instanceof ConfigReloadRejectedError) return context.json({ error: 'validation_failed' }, 422);
        throw error;
      }
    })
    .get('/routing/traffic/buckets', trafficBucketsValidator, (context) => {
      const { range, model } = context.req.valid('query');
      return context.json(state.traceStore.routingTrafficBuckets({ range, modelId: model }));
    })
    .get('/routing/traffic', trafficValidator, (context) => {
      // Destructure `range` rather than forwarding the validated object: the trace store's query
      // type carries an optional `now` it uses as its clock for resolving the time window. The
      // local schema cannot produce that key, so this is guarding the store's contract, not this
      // schema's — forwarding wholesale would let a later schema edit reach the clock.
      const { range } = context.req.valid('query');
      return context.json(state.traceStore.routingTraffic({ range }));
    });
