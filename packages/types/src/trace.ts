import { z } from 'zod';

import { IdSchema } from './common';
import { UsageRowSchema } from './usage';

const TraceBaseSchema = z.object({
  traceId: IdSchema,
  timestamp: z.iso.datetime(),
});

export const TraceEventSchema = z.discriminatedUnion('type', [
  TraceBaseSchema.extend({
    type: z.literal('start'),
    providerId: IdSchema,
    modelId: IdSchema,
  }),
  TraceBaseSchema.extend({
    type: z.literal('delta'),
    textDelta: z.string(),
  }),
  TraceBaseSchema.extend({
    type: z.literal('end'),
    usage: UsageRowSchema.optional(),
  }),
  TraceBaseSchema.extend({
    type: z.literal('error'),
    error: z.object({
      message: z.string().min(1),
      code: z.string().optional(),
    }),
  }),
]);

export type TraceEventInput = z.input<typeof TraceEventSchema>;
export type TraceEvent = z.output<typeof TraceEventSchema>;

export const OtelSpanStatusCodeSchema = z.enum(['UNSET', 'OK', 'ERROR']);
// 调用链的成败，按人看到的那个口径：跑完了没报错算成功，报错算失败，还在跑的两边都不算。
// 跟 OTel 的状态码不是一回事 —— 成功的根 span 是 UNSET，OK 从来没人写过。
export const TraceOutcomeSchema = z.enum(['success', 'error']);
export const TraceTerminationReasonSchema = z.enum(['failure', 'cancelled', 'interrupted']);
export const TraceSpanKindSchema = z.enum(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER']);
export const DashboardTracePageSizeSchema = z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]);

export const DashboardTraceSummarySchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/u),
  rootSpanId: z.string().regex(/^[0-9a-f]{16}$/u),
  requestId: z.string().min(1),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationMs: z.number().min(0),
  stream: z.boolean().optional(),
  fast: z.boolean().optional(),
  ttftMs: z.number().min(0).optional(),
  otelStatusCode: OtelSpanStatusCodeSchema,
  terminationReason: TraceTerminationReasonSchema.optional(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  session: z.object({ source: z.string().min(1), id: z.string().min(1) }).optional(),
  sessionResolvedBy: z.string().optional(),
  inboundProtocol: z.string().min(1),
  requestedModelId: z.string().min(1).optional(),
  finalProviderId: z.string().optional(),
  finalModelId: z.string().optional(),
  finalHttpStatus: z.number().int().optional(),
  usage: UsageRowSchema.optional(),
});

const SpanAttributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
]);
const SpanAttributesSchema = z.record(z.string(), SpanAttributeValueSchema);

export const DashboardTraceSpanSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/u),
  spanId: z.string().regex(/^[0-9a-f]{16}$/u),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/u)
    .optional(),
  name: z.string().min(1),
  kind: TraceSpanKindSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  durationMs: z.number().min(0),
  otelStatusCode: OtelSpanStatusCodeSchema,
  terminationReason: TraceTerminationReasonSchema.optional(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  attributes: SpanAttributesSchema,
  events: z.array(
    z.object({
      name: z.string().min(1),
      timestamp: z.iso.datetime(),
      attributes: SpanAttributesSchema,
    }),
  ),
  links: z.array(
    z.object({
      traceId: z.string().regex(/^[0-9a-f]{32}$/u),
      spanId: z.string().regex(/^[0-9a-f]{16}$/u),
      attributes: SpanAttributesSchema,
    }),
  ),
});

export const DashboardTracesResponseSchema = z
  .object({
    items: z.array(DashboardTraceSummarySchema),
    nextPageToken: z.string().min(1).optional(),
    prevPageToken: z.string().min(1).optional(),
  })
  .strict();

const DashboardTraceRequestDiagnosticsSchema = z
  .object({
    protocol: z.string().min(1),
    method: z.string().min(1),
    contentType: z.string().min(1).max(512).optional(),
    contentLengthBytes: z.number().int().min(0).optional(),
    userAgent: z.string().min(1).max(512).optional(),
  })
  .strict();

const DashboardTraceResponseDiagnosticsSchema = z
  .object({
    statusCode: z.number().int().min(100).max(599),
    contentType: z.string().min(1).max(512).optional(),
    contentLengthBytes: z.number().int().min(0).optional(),
  })
  .strict();

export const DashboardTraceDiagnosticsSchema = z
  .object({
    request: DashboardTraceRequestDiagnosticsSchema.optional(),
    response: DashboardTraceResponseDiagnosticsSchema.optional(),
  })
  .strict();

export const DashboardTraceDetailSchema = z.object({
  trace: DashboardTraceSummarySchema,
  spans: z.array(DashboardTraceSpanSchema),
  diagnostics: DashboardTraceDiagnosticsSchema.optional(),
});

export const DashboardTraceSummaryBucketSizeSchema = z.enum(['1m', '5m', '30m', '1h', '1d']);

/**
 * 一个时间桶里的成功/失败数。注意与 `DashboardTraceSummarySchema` 区分：
 * 那个是一行调用链的摘要，这个是 `GET /dashboard/api/traces/summary` 的聚合结果。
 *
 * 口径跟 `TraceOutcomeSchema` 一致：跑完了没报错算 `success`，报错算 `error`，
 * 还在跑的两边都不计 —— 图上少掉的那一点就是「还没有结果」，不该被算成成功。
 */
export const DashboardTraceSummaryBucketSchema = z
  .object({
    at: z.iso.datetime(),
    success: z.number().int().min(0),
    error: z.number().int().min(0),
  })
  .strict();

export const DashboardTraceSummaryResponseSchema = z
  .object({
    bucket: DashboardTraceSummaryBucketSizeSchema,
    buckets: z.array(DashboardTraceSummaryBucketSchema),
    totals: z.object({ success: z.number().int().min(0), error: z.number().int().min(0) }).strict(),
  })
  .strict();

// 分位对比只在「有意义」时才有值：同模型、同一小时窗口、成功且已结束的调用链
// 够 30 条才给结果，不够就 null，前端整块不渲染而不是画个空条。
export const DashboardTracePercentileSchema = z
  .object({
    modelId: z.string().min(1),
    windowMinutes: z.number().int().positive(),
    sampleCount: z.number().int().min(0),
    durationMs: z.number().min(0),
    percentile: z.number().min(0).max(100),
    minMs: z.number().min(0),
    maxMs: z.number().min(0),
    p50Ms: z.number().min(0),
    p95Ms: z.number().min(0),
  })
  .strict();

export const DashboardTracePercentileResponseSchema = z
  .object({ comparison: DashboardTracePercentileSchema.nullable() })
  .strict();

export type OtelSpanStatusCode = z.output<typeof OtelSpanStatusCodeSchema>;
export type TraceOutcome = z.output<typeof TraceOutcomeSchema>;
export type TraceTerminationReason = z.output<typeof TraceTerminationReasonSchema>;
export type TraceSpanKind = z.output<typeof TraceSpanKindSchema>;
export type DashboardTracePageSize = z.output<typeof DashboardTracePageSizeSchema>;
export type DashboardTraceSummaryInput = z.input<typeof DashboardTraceSummarySchema>;
export type DashboardTraceSummary = z.output<typeof DashboardTraceSummarySchema>;
export type DashboardTraceSpanInput = z.input<typeof DashboardTraceSpanSchema>;
export type DashboardTraceSpan = z.output<typeof DashboardTraceSpanSchema>;
export type DashboardTracesResponseInput = z.input<typeof DashboardTracesResponseSchema>;
export type DashboardTracesResponse = z.output<typeof DashboardTracesResponseSchema>;
export type DashboardTraceDiagnosticsInput = z.input<typeof DashboardTraceDiagnosticsSchema>;
export type DashboardTraceDiagnostics = z.output<typeof DashboardTraceDiagnosticsSchema>;
export type DashboardTraceDetailInput = z.input<typeof DashboardTraceDetailSchema>;
export type DashboardTraceDetail = z.output<typeof DashboardTraceDetailSchema>;
export type DashboardTraceSummaryBucketSize = z.output<typeof DashboardTraceSummaryBucketSizeSchema>;
export type DashboardTraceSummaryBucket = z.output<typeof DashboardTraceSummaryBucketSchema>;
export type DashboardTraceSummaryResponse = z.output<typeof DashboardTraceSummaryResponseSchema>;
export type DashboardTracePercentile = z.output<typeof DashboardTracePercentileSchema>;
export type DashboardTracePercentileResponse = z.output<typeof DashboardTracePercentileResponseSchema>;
