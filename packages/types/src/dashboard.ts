import { z } from "zod";
import { IdSchema } from "./common";
import { ProviderKind } from "./provider";
import {
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
  UsageRowSchema,
} from "./usage";

export const DashboardProviderProbeSchema = z.enum(["OK", "FAIL"]);

export const DashboardProviderSummarySchema = z.object({
  id: IdSchema,
  kind: z.enum(ProviderKind),
  enabled: z.boolean(),
  passthrough: z.boolean(),
  last_status: z.string(),
  last_latency: z.number().int().min(0).nullable(),
  probe: DashboardProviderProbeSchema.optional(),
  name: z.string().optional(),
  clientModels: z.array(z.string()).readonly(),
  hasApiKey: z.boolean().optional(),
});

export const DashboardProvidersResponseSchema = z.object({
  providers: z.array(DashboardProviderSummarySchema),
});

export const DashboardUsageSummarySchema = z.object({
  estimatedCostUsd: z.number().min(0),
  pricingCoverage: z.number().min(0).max(1).nullable(),
  pricedRequestCount: z.number().int().min(0),
  usageRequestCount: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  successCount: z.number().int().min(0),
  failureCount: z.number().int().min(0),
  cancelledCount: z.number().int().min(0),
  successRate: z.number().min(0).max(1).nullable(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  averageRpm: z.number().min(0),
  averageTpm: z.number().min(0),
});

export const DashboardUsageSeriesSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["dimension", "other", "failed", "cancelled"]),
});

export const DashboardUsageBucketSchema = z.object({
  key: z.string().min(1),
  values: z.record(z.string(), z.number().min(0)),
});

export const DashboardUsageOverviewResponseSchema = z.object({
  range: UsageOverviewRangeSchema,
  metric: UsageOverviewMetricSchema,
  groupBy: UsageOverviewGroupBySchema,
  rangeStart: z.string().datetime(),
  rangeEnd: z.string().datetime(),
  bucketUnit: z.enum(["hour", "day"]),
  summary: DashboardUsageSummarySchema,
  series: z.array(DashboardUsageSeriesSchema),
  buckets: z.array(DashboardUsageBucketSchema),
});

export const DashboardEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("config.changed"),
    data: z.object({
      providerIds: z.object({
        added: z.array(IdSchema),
        removed: z.array(IdSchema),
      }),
    }),
  }),
  z.object({
    event: z.literal("events.dropped"),
    data: z.object({
      queuedBytes: z.number().int().min(0),
      queuedEvents: z.number().int().min(0),
    }),
  }),
  z.object({
    event: z.literal("trace.start"),
    data: z.object({
      trace_id: IdSchema,
      providerId: IdSchema,
      modelId: IdSchema,
    }),
  }),
  z.object({
    event: z.literal("trace.delta"),
    data: z.object({
      trace_id: IdSchema,
      textDelta: z.string(),
    }),
  }),
  z.object({
    event: z.literal("trace.end"),
    data: z.object({
      trace_id: IdSchema,
      usage: UsageRowSchema.optional(),
    }),
  }),
]);

export type DashboardProviderProbeInput = z.input<typeof DashboardProviderProbeSchema>;
export type DashboardProviderProbe = z.output<typeof DashboardProviderProbeSchema>;
export type DashboardProviderSummaryInput = z.input<typeof DashboardProviderSummarySchema>;
export type DashboardProviderSummary = z.output<typeof DashboardProviderSummarySchema>;
export type DashboardProvidersResponseInput = z.input<typeof DashboardProvidersResponseSchema>;
export type DashboardProvidersResponse = z.output<typeof DashboardProvidersResponseSchema>;
export type DashboardUsageSummaryInput = z.input<typeof DashboardUsageSummarySchema>;
export type DashboardUsageSummary = z.output<typeof DashboardUsageSummarySchema>;
export type DashboardUsageSeriesInput = z.input<typeof DashboardUsageSeriesSchema>;
export type DashboardUsageSeries = z.output<typeof DashboardUsageSeriesSchema>;
export type DashboardUsageBucketInput = z.input<typeof DashboardUsageBucketSchema>;
export type DashboardUsageBucket = z.output<typeof DashboardUsageBucketSchema>;
export type DashboardUsageOverviewResponseInput = z.input<typeof DashboardUsageOverviewResponseSchema>;
export type DashboardUsageOverviewResponse = z.output<typeof DashboardUsageOverviewResponseSchema>;
export type DashboardEventInput = z.input<typeof DashboardEventSchema>;
export type DashboardEvent = z.output<typeof DashboardEventSchema>;
