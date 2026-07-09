import { z } from "zod";
import { IdSchema } from "./common";
import { ProviderKind } from "./provider";
import { UsageRowSchema } from "./usage";

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
  requestCount: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  reasoningTokens: z.number().int().min(0),
  estimatedCostUsd: z.number().min(0),
});

export const DashboardUsageRowSchema = UsageRowSchema.extend({
  id: IdSchema,
  traceId: IdSchema,
  createdAt: z.string().datetime(),
});

export const DashboardUsageResponseSchema = z.object({
  summary: DashboardUsageSummarySchema,
  rows: z.array(DashboardUsageRowSchema),
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
export type DashboardUsageRowInput = z.input<typeof DashboardUsageRowSchema>;
export type DashboardUsageRow = z.output<typeof DashboardUsageRowSchema>;
export type DashboardUsageResponseInput = z.input<typeof DashboardUsageResponseSchema>;
export type DashboardUsageResponse = z.output<typeof DashboardUsageResponseSchema>;
export type DashboardEventInput = z.input<typeof DashboardEventSchema>;
export type DashboardEvent = z.output<typeof DashboardEventSchema>;
