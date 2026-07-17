import { z } from "zod";
import { providerLoginCommand } from "./commands";
import { IdSchema } from "./common";
import { type DiagnosticCode, PluginStateSchema, ProviderStateSchema } from "./plugin";
import { ProviderKind, ProviderProtocolSchema } from "./provider";
import {
  RequestOutcomeSchema,
  UsageOverviewGroupBySchema,
  UsageOverviewMetricSchema,
  UsageOverviewRangeSchema,
  UsageRowSchema,
} from "./usage";

export const DashboardProviderProbeSchema = z.enum(["OK", "FAIL"]);

const DashboardLocalizedTextValueSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value);

export const DashboardLocalizedTextSchema = z.union([
  DashboardLocalizedTextValueSchema,
  z.record(z.string(), DashboardLocalizedTextValueSchema).superRefine((value, context) => {
    if (!Object.hasOwn(value, "default")) {
      context.addIssue({ code: "custom", message: "default localized text is required" });
    }
    for (const key of Object.keys(value)) {
      if (key === "default") continue;
      try {
        if (Intl.getCanonicalLocales(key)[0] !== key) {
          context.addIssue({ code: "custom", message: "localized text keys must be canonical" });
        }
      } catch {
        context.addIssue({ code: "custom", message: "localized text keys must be language tags" });
      }
    }
  }),
]);

export const DashboardPluginSummarySchema = z.object({
  packageName: z.string().min(1),
  label: DashboardLocalizedTextSchema.optional(),
  description: DashboardLocalizedTextSchema.optional(),
  builtIn: z.boolean(),
  version: z.string().optional(),
  state: PluginStateSchema,
});

export const DashboardPluginsResponseSchema = z.object({
  plugins: z.array(DashboardPluginSummarySchema),
});

export const DashboardProviderSummarySchema = z.object({
  id: IdSchema,
  kind: z.union([z.enum(ProviderKind), z.literal("invalid")]),
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
  catalogLastSuccessAt: z.string().datetime().optional(),
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

export const DashboardRequestLogsPageSizeSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(50),
  z.literal(100),
]);

export const DashboardRequestAttemptSchema = z.object({
  index: z.number().int().min(0),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  providerKind: z.enum(ProviderKind),
  protocol: ProviderProtocolSchema.optional(),
  outcome: RequestOutcomeSchema,
  statusCode: z.number().int().optional(),
  errorCode: z.string().optional(),
  durationMs: z.number().int().min(0),
});

export const DashboardRequestLogSchema = z.object({
  requestId: z.string().min(1),
  inboundProtocol: z.string().min(1),
  requestedModelId: z.string().min(1),
  outcome: RequestOutcomeSchema,
  finalProviderId: z.string().optional(),
  finalModelId: z.string().optional(),
  finalStatusCode: z.number().int().optional(),
  errorCode: z.string().optional(),
  attempts: z.array(DashboardRequestAttemptSchema),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().min(0),
  usage: UsageRowSchema.optional(),
});

export const DashboardRequestLogsResponseSchema = z.object({
  items: z.array(DashboardRequestLogSchema),
  page: z.number().int().min(1),
  pageSize: DashboardRequestLogsPageSizeSchema,
  total: z.number().int().min(0),
  pageCount: z.number().int().min(0),
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
export type DashboardPluginSummaryInput = z.input<typeof DashboardPluginSummarySchema>;
export type DashboardPluginSummary = z.output<typeof DashboardPluginSummarySchema>;
export type DashboardPluginsResponseInput = z.input<typeof DashboardPluginsResponseSchema>;
export type DashboardPluginsResponse = z.output<typeof DashboardPluginsResponseSchema>;
export type DashboardProviderSummaryInput = z.input<typeof DashboardProviderSummarySchema>;
export type DashboardProviderSummary = z.output<typeof DashboardProviderSummarySchema>;

const providerLoginDiagnosticCodes: ReadonlySet<DiagnosticCode> = new Set([
  "ACCOUNT_OPTIONS_INVALID",
  "CREDENTIALS_MISSING_OR_INVALID",
  "CREDENTIAL_REFRESH_FAILED",
]);

export const dashboardProviderSuggestedCommand = (
  provider: Pick<DashboardProviderSummary, "id" | "state">,
): string | undefined => {
  const diagnostic = provider.state.diagnostic;
  if (diagnostic === undefined) return undefined;
  if (diagnostic.suggestedCommand === undefined) return undefined;
  if (providerLoginDiagnosticCodes.has(diagnostic.code)) {
    return providerLoginCommand(provider.id);
  }
  return diagnostic.suggestedCommand;
};

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
export type DashboardRequestLogsPageSize = z.output<typeof DashboardRequestLogsPageSizeSchema>;
export type DashboardRequestAttempt = z.output<typeof DashboardRequestAttemptSchema>;
export type DashboardRequestLog = z.output<typeof DashboardRequestLogSchema>;
export type DashboardRequestLogsResponse = z.output<typeof DashboardRequestLogsResponseSchema>;
export type DashboardEventInput = z.input<typeof DashboardEventSchema>;
export type DashboardEvent = z.output<typeof DashboardEventSchema>;
