import { z } from 'zod';

import { DashboardLocalizedTextSchema } from '../dashboard-localized-text';
import { NonNegativeIntegerStringSchema } from '../dashboard/index';

// The panel's usage windows: a subset of the Dashboard overview ranges with the same boundaries.
export const DesktopUsageRangeSchema = z.enum(['24h', '7d', '30d']);
export type DesktopUsageRange = z.output<typeof DesktopUsageRangeSchema>;

// Every object is strict: this DTO is a cross-version contract with a native client, so an internal
// field leaking into it must fail the server's tests instead of silently becoming API.
const DesktopQuotaWindowSchema = z
  .object({
    id: z.string().min(1),
    label: DashboardLocalizedTextSchema,
    remainingRatio: z.number().min(0).max(1).nullable(),
    resetsAt: z.iso.datetime().nullable(),
    windowMinutes: z.number().int().positive().nullable(),
  })
  .strict();

export const DesktopQuotaSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }).strict(),
  z.object({ status: z.literal('unsupported') }).strict(),
  z.object({ status: z.literal('loading') }).strict(),
  z.object({ status: z.literal('failed') }).strict(),
  z
    .object({
      status: z.literal('ready'),
      sampledAt: z.iso.datetime(),
      refreshFailed: z.boolean(),
      plan: DashboardLocalizedTextSchema.nullable(),
      windows: z.array(DesktopQuotaWindowSchema),
    })
    .strict(),
]);

export const DesktopProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    // The OAuth plugin's display name, with ` / <capability>` for a non-default capability; null for
    // API and AI SDK Providers. Several accounts of one plugin share it, so it names the service.
    service: DashboardLocalizedTextSchema.nullable(),
    // The plugin's icon as it declares it: a Lobe Icons slug, an http(s) URL or a `data:image/` URI.
    icon: z.string().min(1).nullable(),
    enabled: z.boolean(),
    accountLabel: z.string().min(1).nullable(),
    state: z.enum(['ok', 'degraded', 'unavailable', 'disabled']),
    diagnostic: z
      .object({ code: z.string().min(1), summary: z.string().min(1), suggestedCommand: z.string().min(1).nullable() })
      .strict()
      .nullable(),
    quota: DesktopQuotaSchema,
  })
  .strict();

const DesktopUsageTotalsSchema = z
  .object({
    requests: NonNegativeIntegerStringSchema,
    failedRequests: NonNegativeIntegerStringSchema,
    inputTokens: NonNegativeIntegerStringSchema,
    outputTokens: NonNegativeIntegerStringSchema,
    estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
    pricingCoverage: z.number().min(0).max(1).nullable(),
  })
  .strict();

const sliceShape = {
  requests: NonNegativeIntegerStringSchema,
  failedRequests: NonNegativeIntegerStringSchema,
  totalTokens: NonNegativeIntegerStringSchema,
  estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
};

/** Models per heatmap day: enough for a hover card, without shipping a year of every model. */
export const DESKTOP_ACTIVITY_MAX_MODELS = 5;

export const DesktopUsageSchema = z
  .object({
    range: DesktopUsageRangeSchema,
    bucketUnit: z.enum(['hour', 'day']),
    rangeStart: z.iso.datetime(),
    rangeEnd: z.iso.datetime(),
    current: DesktopUsageTotalsSchema,
    previous: DesktopUsageTotalsSchema,
    buckets: z.array(z.object({ start: z.iso.datetime(), ...sliceShape }).strict()),
    byModel: z.array(z.object({ modelId: z.string().min(1), ...sliceShape }).strict()).max(20),
    byProvider: z.array(z.object({ providerId: z.string().min(1), name: z.string().min(1), ...sliceShape }).strict()),
    // Sparse per-bucket splits for the stacked trend: `bucket` indexes `buckets`; buckets without
    // traffic for a series are omitted. Models are those in `byModel`, so a bucket's cells may sum
    // below the bucket; the client draws the rest as Other.
    trendByModel: z.array(
      z.object({ bucket: z.number().int().nonnegative(), modelId: z.string().min(1), ...sliceShape }).strict(),
    ),
    trendByProvider: z.array(
      z.object({ bucket: z.number().int().nonnegative(), providerId: z.string().min(1), ...sliceShape }).strict(),
    ),
  })
  .strict();

export const DesktopSummaryV1Schema = z
  .object({
    protocolVersion: z.literal(1),
    generatedAt: z.iso.datetime(),
    // ppid lets discovery match the sidecar to launchd's job pid, which is the /bin/sh wrapper.
    server: z
      .object({ version: z.string().min(1), pid: z.number().int().positive(), ppid: z.number().int().nonnegative() })
      .strict(),
    usage: DesktopUsageSchema,
    activity: z.array(
      z
        .object({
          date: z.iso.date(),
          totalTokens: NonNegativeIntegerStringSchema,
          // The day's largest models by tokens, for the heatmap's hover card.
          models: z
            .array(z.object({ modelId: z.string().min(1), totalTokens: NonNegativeIntegerStringSchema }).strict())
            .max(DESKTOP_ACTIVITY_MAX_MODELS),
        })
        .strict(),
    ),
    providers: z.array(DesktopProviderSchema),
    alerts: z.array(
      z
        .object({
          providerId: z.string().min(1),
          kind: z.enum(['diagnostic', 'quota_exhausted']),
          message: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict();

export type DesktopQuota = z.output<typeof DesktopQuotaSchema>;
export type DesktopProvider = z.output<typeof DesktopProviderSchema>;
export type DesktopUsage = z.output<typeof DesktopUsageSchema>;
export type DesktopSummaryV1 = z.output<typeof DesktopSummaryV1Schema>;
