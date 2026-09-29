import { z } from 'zod';

import { DashboardLocalizedTextSchema } from '../dashboard-localized-text';
import { NonNegativeIntegerStringSchema } from '../dashboard/index';

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
      windows: z.array(DesktopQuotaWindowSchema),
    })
    .strict(),
]);

export const DesktopProviderSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    state: z.enum(['ok', 'degraded', 'unavailable', 'disabled']),
    diagnostic: z
      .object({ code: z.string().min(1), summary: z.string().min(1) })
      .strict()
      .nullable(),
    quota: DesktopQuotaSchema,
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
    usage24h: z
      .object({
        requests: NonNegativeIntegerStringSchema,
        failedRequests: NonNegativeIntegerStringSchema,
        inputTokens: NonNegativeIntegerStringSchema,
        outputTokens: NonNegativeIntegerStringSchema,
        estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
        pricingCoverage: z.number().min(0).max(1).nullable(),
      })
      .strict(),
    trend7d: z.array(
      z
        .object({
          start: z.iso.datetime(),
          requests: NonNegativeIntegerStringSchema,
          totalTokens: NonNegativeIntegerStringSchema,
          estimatedCostNanoUsd: NonNegativeIntegerStringSchema,
        })
        .strict(),
    ),
    activity: z.array(z.object({ date: z.iso.date(), totalTokens: NonNegativeIntegerStringSchema }).strict()),
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
export type DesktopSummaryV1 = z.output<typeof DesktopSummaryV1Schema>;
