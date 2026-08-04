import { z } from 'zod';

import { providerLoginCommand } from './commands';
import { IdSchema } from './common';
import { type DiagnosticCode, ProviderStateSchema } from './plugin';
import { ProviderKind } from './provider';
import {
  DashboardOverviewRangeSchema,
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
  UsageRowSchema,
} from './usage';

export const DashboardProviderProbeSchema = z.enum(['OK', 'FAIL']);

export const DashboardProviderSummarySchema = z.object({
  id: IdSchema,
  kind: z.union([z.enum(ProviderKind), z.literal('invalid')]),
  enabled: z.boolean(),
  passthrough: z.boolean(),
  last_status: z.string(),
  last_latency: z.number().int().min(0).nullable(),
  probe: DashboardProviderProbeSchema.optional(),
  name: z.string().optional(),
  clientModels: z.array(z.string()).readonly(),
  hasApiKey: z.boolean().optional(),
  state: ProviderStateSchema,
  plugin: z.string().optional(),
  capability: z.string().optional(),
  accountLabel: z.string().optional(),
  expiresAt: z.number().int().optional(),
  catalogLastSuccessAt: z.iso.datetime().optional(),
});

export const DashboardProvidersResponseSchema = z.object({
  providers: z.array(DashboardProviderSummarySchema),
});

export const NonNegativeIntegerStringSchema = z.string().regex(/^(?:0|[1-9]\d*)$/u);
// oxlint-disable-next-line typescript/no-deprecated -- Keep the finite boundary explicit in the public schema.
const NonNegativeFiniteNumberSchema = z.number().finite().min(0);

export const DashboardUsageSummarySchema = z.object({
  estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
  pricingCoverage: z.number().min(0).max(1).nullable(),
  pricedRequestCount: NonNegativeIntegerStringSchema,
  usageRequestCount: NonNegativeIntegerStringSchema,
  requestCount: NonNegativeIntegerStringSchema,
  successCount: NonNegativeIntegerStringSchema,
  failureCount: NonNegativeIntegerStringSchema,
  cancelledCount: NonNegativeIntegerStringSchema,
  successRate: z.number().min(0).max(1).nullable(),
  inputTokens: NonNegativeIntegerStringSchema,
  outputTokens: NonNegativeIntegerStringSchema,
  totalTokens: NonNegativeIntegerStringSchema,
  averageRpm: z.number().min(0),
  averageTpm: z.number().min(0),
});

export const DashboardUsageSeriesSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(['dimension', 'other', 'failed', 'cancelled']),
});

export const DashboardUsageBucketSchema = z.object({
  key: z.string().min(1),
  values: z.record(z.string(), NonNegativeIntegerStringSchema),
});

export const DashboardUsageOverviewResponseSchema = z.object({
  range: UsageOverviewRangeSchema,
  metric: UsageOverviewMetricSchema,
  groupBy: UsageOverviewGroupBySchema,
  rangeStart: z.iso.datetime(),
  rangeEnd: z.iso.datetime(),
  bucketUnit: z.enum(['hour', 'day']),
  summary: DashboardUsageSummarySchema,
  series: z.array(DashboardUsageSeriesSchema),
  buckets: z.array(DashboardUsageBucketSchema),
});

const DashboardOverviewTrendSchema = z.object({
  buckets: z.array(DashboardUsageBucketSchema),
  series: z.array(DashboardUsageSeriesSchema),
});

export const DashboardOverviewResponseSchema = z.object({
  range: DashboardOverviewRangeSchema,
  summary: z.object({
    requestCount: NonNegativeIntegerStringSchema,
    totalTokens: NonNegativeIntegerStringSchema,
    cacheReadTokens: NonNegativeIntegerStringSchema,
    cacheWriteTokens: NonNegativeIntegerStringSchema,
    cacheHitRate: NonNegativeFiniteNumberSchema.max(1).nullable(),
    estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
    averageRpm: NonNegativeFiniteNumberSchema,
    averageTpm: NonNegativeFiniteNumberSchema,
    providerCount: NonNegativeFiniteNumberSchema.int(),
  }),
  modelTrendByMetric: z.object({
    requests: DashboardOverviewTrendSchema,
    tokens: DashboardOverviewTrendSchema,
    cost: DashboardOverviewTrendSchema,
  }),
  providerHealth: z.array(
    z.object({
      providerId: IdSchema,
      successRate: NonNegativeFiniteNumberSchema.max(1),
      p95LatencyMs: NonNegativeFiniteNumberSchema,
    }),
  ),
  topModelCosts: z.array(z.object({ modelId: IdSchema, estimatedCostNanoUsd: NonNegativeIntegerStringSchema })),
  activity: z.object({
    year: z.number().int(),
    days: z.array(z.object({ date: z.iso.date(), requestCount: NonNegativeIntegerStringSchema })).readonly(),
  }),
});

export const DashboardEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('config.changed'),
    data: z.object({
      providerIds: z.object({
        added: z.array(IdSchema),
        removed: z.array(IdSchema),
      }),
    }),
  }),
  z.object({
    event: z.literal('events.dropped'),
    data: z.object({
      queuedBytes: z.number().int().min(0),
      queuedEvents: z.number().int().min(0),
    }),
  }),
  z.object({
    event: z.literal('trace.start'),
    data: z.object({
      trace_id: IdSchema,
      providerId: IdSchema,
      modelId: IdSchema,
    }),
  }),
  z.object({
    event: z.literal('trace.delta'),
    data: z.object({
      trace_id: IdSchema,
      textDelta: z.string(),
    }),
  }),
  z.object({
    event: z.literal('trace.end'),
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

const providerLoginDiagnosticCodes: ReadonlySet<DiagnosticCode> = new Set([
  'ACCOUNT_OPTIONS_INVALID',
  'CREDENTIALS_MISSING_OR_INVALID',
  'CREDENTIAL_REFRESH_FAILED',
]);

export const dashboardProviderSuggestedCommand = (
  provider: Pick<DashboardProviderSummary, 'id' | 'state'>,
): string | undefined => {
  const diagnostic = provider.state.diagnostic;
  if (diagnostic === undefined) return undefined;
  if (diagnostic.suggestedCommand === undefined) return undefined;
  if (providerLoginDiagnosticCodes.has(diagnostic.code)) {
    return providerLoginCommand(provider.id);
  }
  return diagnostic.suggestedCommand;
};

export const dashboardProviderNeedsReauthorization = (
  provider: Pick<DashboardProviderSummary, 'id' | 'kind' | 'state'>,
): boolean =>
  provider.kind === 'oauth' && dashboardProviderSuggestedCommand(provider) === providerLoginCommand(provider.id);

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
export type DashboardOverviewResponseInput = z.input<typeof DashboardOverviewResponseSchema>;
export type DashboardOverviewResponse = z.output<typeof DashboardOverviewResponseSchema>;
export type DashboardEventInput = z.input<typeof DashboardEventSchema>;
export type DashboardEvent = z.output<typeof DashboardEventSchema>;
