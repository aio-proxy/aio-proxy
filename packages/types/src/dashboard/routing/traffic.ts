import { z } from 'zod';

import { IdSchema } from '../../common';
import { type UsageOverviewRange, UsageOverviewRangeSchema } from '../../usage';

const matchesDto =
  <Dto>() =>
  <Schema extends z.ZodType<Dto>>(schema: Schema): Schema =>
    schema;

// Counts travel as decimal strings, matching the existing usage wire format: SQLite
// integers can exceed the JS safe-integer range, so the frontend decodes with BigInt().
const CountSchema = z.string().regex(/^\d+$/u);

export type DashboardRoutingTrafficProvider = {
  readonly providerId: string;
  /** Requests this Provider ultimately served (the root span's final_provider_id).
   * The numerator of the actual traffic share. */
  readonly finalCount: string;
  /** Attempts made against this Provider, including attempts that failed and were
   * failed over to another Provider. */
  readonly attemptCount: string;
  readonly successCount: string;
  /** Null when there is no sample. Never 0, which would read as "zero latency". */
  readonly p95LatencyMs: number | null;
};

export type DashboardRoutingTrafficModel = {
  readonly modelId: string;
  readonly providers: readonly DashboardRoutingTrafficProvider[];
};

export type DashboardRoutingTrafficResponse = {
  readonly range: UsageOverviewRange;
  readonly from: string;
  readonly to: string;
  readonly models: readonly DashboardRoutingTrafficModel[];
};

export type DashboardRoutingTrafficBucket = {
  readonly bucket: string;
  readonly values: Readonly<Record<string, string>>;
};

export type DashboardRoutingTrafficBucketsResponse = {
  readonly range: UsageOverviewRange;
  readonly modelId: string;
  readonly from: string;
  readonly to: string;
  readonly bucketUnit: 'hour' | 'day';
  /** Every Provider ID seen in this window, so the chart can pin a stable series order. */
  readonly providerIds: readonly string[];
  readonly buckets: readonly DashboardRoutingTrafficBucket[];
};

export const DashboardRoutingTrafficProviderSchema = matchesDto<DashboardRoutingTrafficProvider>()(
  z.strictObject({
    providerId: IdSchema,
    finalCount: CountSchema,
    attemptCount: CountSchema,
    successCount: CountSchema,
    p95LatencyMs: z.number().nonnegative().nullable(),
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
    from: z.string().min(1),
    to: z.string().min(1),
    models: z.array(DashboardRoutingTrafficModelSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficBucketSchema = matchesDto<DashboardRoutingTrafficBucket>()(
  z.strictObject({
    bucket: z.string().min(1),
    values: z.record(IdSchema, CountSchema),
  }),
);

export const DashboardRoutingTrafficBucketsResponseSchema = matchesDto<DashboardRoutingTrafficBucketsResponse>()(
  z.strictObject({
    range: UsageOverviewRangeSchema,
    modelId: IdSchema,
    from: z.string().min(1),
    to: z.string().min(1),
    bucketUnit: z.enum(['hour', 'day']),
    providerIds: z.array(IdSchema).readonly(),
    buckets: z.array(DashboardRoutingTrafficBucketSchema).readonly(),
  }),
);
