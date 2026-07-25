import { z } from 'zod';

import { IdSchema } from './common';
import { UsageRowSchema } from './usage';

const TraceBaseSchema = z.object({
  traceId: IdSchema,
  timestamp: z.string().datetime(),
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
export const TraceTerminationReasonSchema = z.enum(['failure', 'cancelled', 'interrupted']);
export const TraceSpanKindSchema = z.enum(['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER']);
export const DashboardTracePageSizeSchema = z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]);

export const DashboardTraceSummarySchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/u),
  rootSpanId: z.string().regex(/^[0-9a-f]{16}$/u),
  requestId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().min(0),
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
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number().finite()),
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
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  durationMs: z.number().min(0),
  otelStatusCode: OtelSpanStatusCodeSchema,
  terminationReason: TraceTerminationReasonSchema.optional(),
  errorType: z.string().optional(),
  errorCode: z.string().optional(),
  attributes: SpanAttributesSchema,
  events: z.array(
    z.object({
      name: z.string().min(1),
      timestamp: z.string().datetime(),
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

export const DashboardTracesResponseSchema = z.object({
  items: z.array(DashboardTraceSummarySchema),
  page: z.number().int().min(1),
  pageSize: DashboardTracePageSizeSchema,
  total: z.number().int().min(0),
  pageCount: z.number().int().min(0),
});

export const DashboardTraceDetailSchema = z.object({
  trace: DashboardTraceSummarySchema,
  spans: z.array(DashboardTraceSpanSchema),
});

export type OtelSpanStatusCode = z.output<typeof OtelSpanStatusCodeSchema>;
export type TraceTerminationReason = z.output<typeof TraceTerminationReasonSchema>;
export type TraceSpanKind = z.output<typeof TraceSpanKindSchema>;
export type DashboardTracePageSize = z.output<typeof DashboardTracePageSizeSchema>;
export type DashboardTraceSummaryInput = z.input<typeof DashboardTraceSummarySchema>;
export type DashboardTraceSummary = z.output<typeof DashboardTraceSummarySchema>;
export type DashboardTraceSpanInput = z.input<typeof DashboardTraceSpanSchema>;
export type DashboardTraceSpan = z.output<typeof DashboardTraceSpanSchema>;
export type DashboardTracesResponseInput = z.input<typeof DashboardTracesResponseSchema>;
export type DashboardTracesResponse = z.output<typeof DashboardTracesResponseSchema>;
export type DashboardTraceDetailInput = z.input<typeof DashboardTraceDetailSchema>;
export type DashboardTraceDetail = z.output<typeof DashboardTraceDetailSchema>;
