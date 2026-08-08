import { decodeTraceCursor, encodeTraceCursor, type TracesQuery } from '@aio-proxy/core/db';
import { DashboardTracePageSizeSchema, OtelSpanStatusCodeSchema, TraceTerminationReasonSchema } from '@aio-proxy/types';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import { traceDiagnosticsFromAttributes } from '../../request-tracing/semantic';
import type { ServerState } from '../../server-state';

const TracesQuerySchema = z.object({
  pageSize: z.coerce.number().pipe(DashboardTracePageSizeSchema).default(50),
  pageToken: z
    .string()
    .transform((value, context) => {
      const cursor = decodeTraceCursor(value);
      if (cursor !== undefined) return cursor;
      context.addIssue({ code: 'custom', message: 'invalid page token' });
      return z.NEVER;
    })
    .optional(),
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
    pageSize: query.pageSize,
    ...(query.pageToken === undefined ? {} : { cursor: query.pageToken }),
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
    .get('/', tracesQueryValidator, (context) => {
      const page = state.traceStore.list(context.req.valid('query'));
      return context.json({
        items: page.items,
        ...(page.nextCursor === undefined ? {} : { nextPageToken: encodeTraceCursor(page.nextCursor) }),
        ...(page.previousCursor === undefined ? {} : { prevPageToken: encodeTraceCursor(page.previousCursor) }),
      });
    })
    .get('/:traceId', traceIdParamsValidator, (context) => {
      context.header('cache-control', 'no-store');
      const detail = state.traceStore.find(context.req.valid('param').traceId);
      if (detail === undefined) return context.json({ error: 'trace not found' }, 404);
      const root = detail.spans.find((span) => span.spanId === detail.trace.rootSpanId);
      const diagnostics = root === undefined ? undefined : traceDiagnosticsFromAttributes(root.attributes);
      return context.json({ ...detail, ...(diagnostics === undefined ? {} : { diagnostics }) });
    });
