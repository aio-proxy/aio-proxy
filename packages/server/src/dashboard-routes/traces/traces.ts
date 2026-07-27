import type { TracesQuery } from '@aio-proxy/core/db';
import { DashboardTracePageSizeSchema, OtelSpanStatusCodeSchema, TraceTerminationReasonSchema } from '@aio-proxy/types';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import type { ServerState } from '../../server-state';

const TracesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().pipe(DashboardTracePageSizeSchema).default(50),
  startedAfter: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  startedBefore: z.iso
    .datetime()
    .transform((value) => new Date(value))
    .optional(),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/u)
    .optional(),
  requestId: z.string().trim().min(1).optional(),
  sessionSource: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).max(512).optional(),
  otelStatusCode: OtelSpanStatusCodeSchema.optional(),
  terminationReason: TraceTerminationReasonSchema.optional(),
  inboundProtocol: z.string().trim().min(1).optional(),
  requestedModelId: z.string().trim().min(1).optional(),
  finalProviderId: z.string().trim().min(1).optional(),
  finalModelId: z.string().trim().min(1).optional(),
  finalHttpStatus: z.coerce.number().int().min(100).max(599).optional(),
});

const TraceIdParamsSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/u),
});

const tracesQueryValidator = validator('query', (raw, context) => {
  const parsed = TracesQuerySchema.safeParse(raw);
  return parsed.success
    ? toTracesQuery(parsed.data)
    : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

const traceIdParamsValidator = validator('param', (raw, context) => {
  const parsed = TraceIdParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

function toTracesQuery(query: z.output<typeof TracesQuerySchema>): TracesQuery {
  return {
    page: query.page,
    pageSize: query.pageSize,
    ...(query.startedAfter === undefined ? {} : { startedAfter: query.startedAfter }),
    ...(query.startedBefore === undefined ? {} : { startedBefore: query.startedBefore }),
    ...(query.traceId === undefined ? {} : { traceId: query.traceId }),
    ...(query.requestId === undefined ? {} : { requestId: query.requestId }),
    ...(query.sessionSource === undefined ? {} : { sessionSource: query.sessionSource }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.otelStatusCode === undefined ? {} : { otelStatusCode: query.otelStatusCode }),
    ...(query.terminationReason === undefined ? {} : { terminationReason: query.terminationReason }),
    ...(query.inboundProtocol === undefined ? {} : { inboundProtocol: query.inboundProtocol }),
    ...(query.requestedModelId === undefined ? {} : { requestedModelId: query.requestedModelId }),
    ...(query.finalProviderId === undefined ? {} : { finalProviderId: query.finalProviderId }),
    ...(query.finalModelId === undefined ? {} : { finalModelId: query.finalModelId }),
    ...(query.finalHttpStatus === undefined ? {} : { finalHttpStatus: query.finalHttpStatus }),
  };
}

export const createDashboardTraceRoutes = (state: ServerState) =>
  new Hono()
    .get('/', tracesQueryValidator, (context) => context.json(state.traceStore.list(context.req.valid('query'))))
    .get('/:traceId', traceIdParamsValidator, (context) => {
      context.header('cache-control', 'no-store');
      const detail = state.traceStore.find(context.req.valid('param').traceId);
      return detail === undefined ? context.json({ error: 'trace not found' }, 404) : context.json(detail);
    });
