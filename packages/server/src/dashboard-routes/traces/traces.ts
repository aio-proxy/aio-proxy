import { join } from 'node:path';

import { aioHome } from '@aio-proxy/core';
import { decodeTraceCursor, encodeTraceCursor, type TracesQuery, type TracesSummaryQuery } from '@aio-proxy/core/db';
import {
  DashboardTracePageSizeSchema,
  OtelSpanStatusCodeSchema,
  TraceOutcomeSchema,
  TraceTerminationReasonSchema,
} from '@aio-proxy/types';
import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';

import { traceDiagnosticsFromAttributes } from '../../request-tracing/semantic';
import type { ServerState } from '../../server-state';
import { readTraceWireLog } from './wire-log';

const isoDate = z.iso.datetime().transform((value) => new Date(value));

const TraceFiltersQuerySchema = z.object({
  startedAfter: isoDate.optional(),
  startedBefore: isoDate.optional(),
  traceId: z
    .string()
    .regex(/^[0-9a-f]{32}$/u)
    .optional(),
  requestId: z.string().trim().min(1).optional(),
  sessionSource: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).max(512).optional(),
  otelStatusCode: OtelSpanStatusCodeSchema.optional(),
  outcome: TraceOutcomeSchema.optional(),
  terminationReason: TraceTerminationReasonSchema.optional(),
  inboundProtocol: z.string().trim().min(1).optional(),
  requestedModelId: z.string().trim().min(1).optional(),
  finalProviderId: z.string().trim().min(1).optional(),
  finalModelId: z.string().trim().min(1).optional(),
  finalHttpStatus: z.coerce.number().int().min(100).max(599).optional(),
});

const TracesQuerySchema = TraceFiltersQuerySchema.extend({
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
});

// 图表要画满整个时间范围，桶还要对齐到范围起点，所以这两个参数在摘要里是必填。
const TraceSummaryQuerySchema = TraceFiltersQuerySchema.extend({
  startedAfter: isoDate,
  startedBefore: isoDate,
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

const traceSummaryQueryValidator = validator('query', (raw, context) => {
  const parsed = TraceSummaryQuerySchema.safeParse(raw);
  return parsed.success
    ? toTraceSummaryQuery(parsed.data)
    : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

const traceIdParamsValidator = validator('param', (raw, context) => {
  const parsed = TraceIdParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation failed', details: parsed.error.issues }, 400);
});

function toTraceFilters(query: z.output<typeof TraceFiltersQuerySchema>) {
  return {
    ...(query.startedAfter === undefined ? {} : { startedAfter: query.startedAfter }),
    ...(query.startedBefore === undefined ? {} : { startedBefore: query.startedBefore }),
    ...(query.traceId === undefined ? {} : { traceId: query.traceId }),
    ...(query.requestId === undefined ? {} : { requestId: query.requestId }),
    ...(query.sessionSource === undefined ? {} : { sessionSource: query.sessionSource }),
    ...(query.sessionId === undefined ? {} : { sessionId: query.sessionId }),
    ...(query.otelStatusCode === undefined ? {} : { otelStatusCode: query.otelStatusCode }),
    ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
    ...(query.terminationReason === undefined ? {} : { terminationReason: query.terminationReason }),
    ...(query.inboundProtocol === undefined ? {} : { inboundProtocol: query.inboundProtocol }),
    ...(query.requestedModelId === undefined ? {} : { requestedModelId: query.requestedModelId }),
    ...(query.finalProviderId === undefined ? {} : { finalProviderId: query.finalProviderId }),
    ...(query.finalModelId === undefined ? {} : { finalModelId: query.finalModelId }),
    ...(query.finalHttpStatus === undefined ? {} : { finalHttpStatus: query.finalHttpStatus }),
  };
}

function toTracesQuery(query: z.output<typeof TracesQuerySchema>): TracesQuery {
  return {
    pageSize: query.pageSize,
    ...(query.pageToken === undefined ? {} : { cursor: query.pageToken }),
    ...toTraceFilters(query),
  };
}

function toTraceSummaryQuery(query: z.output<typeof TraceSummaryQuerySchema>): TracesSummaryQuery {
  return { ...toTraceFilters(query), startedAfter: query.startedAfter, startedBefore: query.startedBefore };
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
    .get('/summary', traceSummaryQueryValidator, (context) =>
      context.json(state.traceStore.summary(context.req.valid('query'))),
    )
    .get('/:traceId', traceIdParamsValidator, (context) => {
      context.header('cache-control', 'no-store');
      const detail = state.traceStore.find(context.req.valid('param').traceId);
      if (detail === undefined) return context.json({ error: 'trace not found' }, 404);
      const root = detail.spans.find((span) => span.spanId === detail.trace.rootSpanId);
      const diagnostics = root === undefined ? undefined : traceDiagnosticsFromAttributes(root.attributes);
      return context.json({ ...detail, ...(diagnostics === undefined ? {} : { diagnostics }) });
    })
    // 分位对比自己算不出「调用链不存在」和「调用链不可比」的区别，所以先按详情路由的口径
    // 确认它存在，再去聚合 —— 否则一个打错的 traceId 会拿到一个安静的 null。
    .get('/:traceId/percentile', traceIdParamsValidator, (context) => {
      context.header('cache-control', 'no-store');
      const { traceId } = context.req.valid('param');
      if (state.traceStore.find(traceId) === undefined) return context.json({ error: 'trace not found' }, 404);
      return context.json(state.traceStore.percentile(traceId));
    })
    .get('/:traceId/wire', traceIdParamsValidator, async (context) => {
      context.header('cache-control', 'no-store');
      const detail = state.traceStore.find(context.req.valid('param').traceId);
      if (detail === undefined) return context.json({ error: 'trace not found' }, 404);
      const logging = state.logging;
      return context.json(
        await readTraceWireLog({
          requestId: detail.trace.requestId,
          startedAt: new Date(detail.trace.startedAt),
          // 跨本地零点的请求后半截写在第二天的文件里，结束时刻决定了要不要连那个也扫
          ...(detail.trace.endedAt === null ? {} : { endedAt: new Date(detail.trace.endedAt) }),
          logging,
          logDir: logging?.dir ?? join(aioHome(), 'logs'),
        }),
      );
    });
