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
});

export const DashboardProvidersResponseSchema = z.object({
  providers: z.array(DashboardProviderSummarySchema),
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
export type DashboardEventInput = z.input<typeof DashboardEventSchema>;
export type DashboardEvent = z.output<typeof DashboardEventSchema>;
