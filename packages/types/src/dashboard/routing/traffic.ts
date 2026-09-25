import { z } from 'zod';

import { IdSchema } from '../../common';
import { type UsageOverviewRange, UsageOverviewRangeSchema } from '../../usage';
// Counts travel as decimal strings, matching the existing usage wire format: SQLite
// integers can exceed the JS safe-integer range, so the frontend decodes with BigInt().
import { NonNegativeIntegerStringSchema } from '../dashboard';

const matchesDto =
  <Dto>() =>
  <Schema extends z.ZodType<Dto>>(schema: Schema): Schema =>
    schema;

export type DashboardRoutingTrafficProvider = {
  readonly providerId: string;
  /** Requests this Provider ultimately served (the root span's final_provider_id).
   * The numerator of the actual traffic share. */
  readonly finalCount: string;
  /** Attempts made against this Provider, including attempts that failed and were
   * failed over to another Provider. */
  readonly attemptCount: string;
  /** Attempts whose termination_reason was null, i.e. attempt-level successes. Compute a
   * success rate as successCount / attemptCount, never against finalCount. */
  readonly successCount: string;
  /** Nearest-rank p95 over every attempt against this Provider, failures included, so a Provider
   * that fails fast shows a low p95 beside a poor success rate — read it with successCount, never
   * alone. Null when there is no sample; never 0, which would read as "zero latency". */
  readonly p95LatencyMs: number | null;
};

export type DashboardRoutingTrafficModel = {
  readonly modelId: string;
  readonly providers: readonly DashboardRoutingTrafficProvider[];
};

export type DashboardRoutingTrafficResponse = {
  readonly range: UsageOverviewRange;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly models: readonly DashboardRoutingTrafficModel[];
};

export type DashboardRoutingTrafficBucket = {
  readonly key: string;
  readonly values: Readonly<Record<string, string>>;
};

export type DashboardRoutingTrafficBucketsResponse = {
  readonly range: UsageOverviewRange;
  readonly modelId: string;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly bucketUnit: 'hour' | 'day';
  /** Every Provider ID seen in this window, so the chart can pin a stable series order. */
  readonly providerIds: readonly string[];
  readonly buckets: readonly DashboardRoutingTrafficBucket[];
};

export const DashboardRoutingTrafficProviderSchema = matchesDto<DashboardRoutingTrafficProvider>()(
  z.strictObject({
    providerId: IdSchema,
    finalCount: NonNegativeIntegerStringSchema,
    attemptCount: NonNegativeIntegerStringSchema,
    successCount: NonNegativeIntegerStringSchema,
    p95LatencyMs: z.number().int().min(0).nullable(),
  }),
);

export const DashboardRoutingTrafficModelSchema = matchesDto<DashboardRoutingTrafficModel>()(
  z.strictObject({
    modelId: IdSchema,
    providers: z.array(DashboardRoutingTrafficProviderSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficResponseSchema = matchesDto<DashboardRoutingTrafficResponse>()(
  z.strictObject({
    range: UsageOverviewRangeSchema,
    rangeStart: z.iso.datetime(),
    rangeEnd: z.iso.datetime(),
    models: z.array(DashboardRoutingTrafficModelSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficBucketSchema = matchesDto<DashboardRoutingTrafficBucket>()(
  z.strictObject({
    // Always a full ISO instant: usageBucketKeys returns .toISOString() on both branches, so a
    // 'day' bucketUnit yields local midnight rather than a date-only string. Left loose to match
    // the sibling DashboardUsageBucketSchema.key; tightening both to z.iso.datetime() is a
    // separate change, and tightening only one would fork the convention again.
    key: z.string().min(1),
    values: z.record(IdSchema, NonNegativeIntegerStringSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficBucketsResponseSchema = matchesDto<DashboardRoutingTrafficBucketsResponse>()(
  z.strictObject({
    range: UsageOverviewRangeSchema,
    modelId: IdSchema,
    rangeStart: z.iso.datetime(),
    rangeEnd: z.iso.datetime(),
    bucketUnit: z.enum(['hour', 'day']),
    providerIds: z.array(IdSchema).readonly(),
    buckets: z.array(DashboardRoutingTrafficBucketSchema).readonly(),
  }),
);
