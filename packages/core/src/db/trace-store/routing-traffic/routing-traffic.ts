import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type {
  DashboardRoutingTrafficBucketsResponse,
  DashboardRoutingTrafficModel,
  DashboardRoutingTrafficProvider,
  DashboardRoutingTrafficResponse,
} from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { RoutingTrafficBucketsQuery, RoutingTrafficQuery } from '../types';
import { type ResolvedUsageRange, resolveUsageRange, usageBucketKeys } from '../usage-range';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

// The token_count probe span also carries attempt_index and provider_id, but it is not a
// generation attempt; counting it would inflate the attempt count and depress the success rate.
// This is the same exclusion overview/diagnostics.ts applies.
const SKIPPED_SPAN_NAME = 'aio_proxy.token_count.candidate_skipped';

/**
 * Generation traffic only. `aio_proxy.operation` stays in the attributes JSON rather than in a
 * column, so this mirrors the coalesce-to-'model' shape trace-percentile already uses: rows written
 * before the key existed are generation.
 *
 * Token counting routes through the same candidate list, records its attempts under the same span
 * name with the same provider attributes, and finishes its root with a requested model and a final
 * Provider — nothing distinguishes it downstream. Clients count tokens before most calls, so without
 * this the counts would dominate the served shares, attempt totals, success rates and p95 of
 * whichever Provider answered them.
 */
const GENERATION = (alias: string) =>
  `coalesce(json_extract(${alias}.attributes_json, '$."aio_proxy.operation"'), 'model') = 'model'`;

// A root that failed or was cancelled still names a final Provider: `finalFailure()` in the
// pipeline sets finalProviderId alongside outcome 'failure', so the last Provider tried is recorded
// even when nothing was served. `termination_reason is null` is therefore required, not optional —
// without it a request every candidate failed counts as traffic that Provider served, inflating the
// served totals, both halves of the configured-versus-actual comparison, the deviation verdict and
// the chart. It is the same discriminator the attempt query already uses for successCount.
const SERVED_ROOT = `root.parent_span_id is null
      and root.final_provider_id is not null
      and root.termination_reason is null
      and ${GENERATION('root')}
      and root.ended_at >= ? and root.ended_at <= ?`;

type RawAttemptRow = {
  readonly modelId: string;
  readonly providerId: string;
  readonly attemptCount: string;
  readonly successCount: string;
  readonly durations: string;
};

type RawFinalRow = {
  readonly modelId: string;
  readonly providerId: string;
  readonly finalCount: string;
};

type RawBucketRow = {
  readonly bucket: string | number;
  readonly providerId: string;
  readonly finalCount: string;
};

type Accumulated = {
  finalCount: string;
  attemptCount: string;
  successCount: string;
  p95LatencyMs: number | null;
};

export function routingTraffic(db: BunSQLiteDatabase, query: RoutingTrafficQuery): DashboardRoutingTrafficResponse {
  const range = resolveUsageRange(query.range, query.now ?? new Date());
  const models = new Map<string, Map<string, Accumulated>>();

  for (const row of attemptRows(db, range)) {
    const accumulated = entry(models, row.modelId, row.providerId);
    accumulated.attemptCount = row.attemptCount;
    accumulated.successCount = row.successCount;
    accumulated.p95LatencyMs = percentile95(row.durations);
  }
  for (const row of finalRows(db, range)) {
    entry(models, row.modelId, row.providerId).finalCount = row.finalCount;
  }

  return {
    range: query.range,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    models: [...models]
      .map(([modelId, providers]): DashboardRoutingTrafficModel => ({
        modelId,
        providers: [...providers]
          .map(([providerId, value]): DashboardRoutingTrafficProvider => ({ providerId, ...value }))
          .sort((left, right) => left.providerId.localeCompare(right.providerId)),
      }))
      .sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}

export function routingTrafficBuckets(
  db: BunSQLiteDatabase,
  query: RoutingTrafficBucketsQuery,
): DashboardRoutingTrafficBucketsResponse {
  const range = resolveUsageRange(query.range, query.now ?? new Date());
  const byBucket = new Map<string | number, Map<string, string>>();
  const providerIds = new Set<string>();

  for (const row of bucketRows(db, range, query.modelId)) {
    providerIds.add(row.providerId);
    const values = byBucket.get(row.bucket) ?? new Map<string, string>();
    values.set(row.providerId, row.finalCount);
    byBucket.set(row.bucket, values);
  }

  const ordered = [...providerIds].sort((left, right) => left.localeCompare(right));
  return {
    range: query.range,
    modelId: query.modelId,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    bucketUnit: range.bucketUnit,
    providerIds: ordered,
    // Fill empty buckets with '0': a missing key would leave a gap in the stacked chart
    // instead of a zero-height segment.
    buckets: usageBucketKeys(query.range, range.start, range.end).map(({ identity, key }) => ({
      key,
      values: Object.fromEntries(ordered.map((id) => [id, byBucket.get(identity)?.get(id) ?? '0'])),
    })),
  };
}

/** One row per (model, Provider): both queries group by exactly those two columns, so callers
 * assign rather than accumulate. Adding a column to either `group by` breaks that silently. */
function entry(models: Map<string, Map<string, Accumulated>>, modelId: string, providerId: string): Accumulated {
  const providers = models.get(modelId) ?? new Map<string, Accumulated>();
  models.set(modelId, providers);
  const existing = providers.get(providerId);
  if (existing !== undefined) return existing;
  const created: Accumulated = { finalCount: '0', attemptCount: '0', successCount: '0', p95LatencyMs: null };
  providers.set(providerId, created);
  return created;
}

/** Nearest-rank p95 over integer durations. Null with no sample, never 0, which would read as
 * "zero latency". */
function percentile95(durations: string): number | null {
  const parsed = (JSON.parse(durations) as number[]).sort((left, right) => left - right);
  if (parsed.length === 0) return null;
  return parsed[Math.ceil(parsed.length * 0.95) - 1] ?? null;
}

function attemptRows(db: BunSQLiteDatabase, range: ResolvedUsageRange): RawAttemptRow[] {
  return all<RawAttemptRow>(
    db,
    // Drive from the root span and filter on ITS ended_at. Two reasons, both verified:
    // 1. Correctness — finalRows windows on the root's ended_at too, so both halves of a
    //    share comparison must use the same time basis or an edge trace lands in one and
    //    not the other.
    // 2. Plan — this is the only shape SQLite can narrow by time here. It uses the existing
    //    trace_span_root_ended_idx (parent_span_id=? AND ended_at>? AND ended_at<?).
    //    Filtering on attempt.ended_at instead yields no time predicate on the driving
    //    table at all, scanning the whole retention window.
    // Attempt spans hang off the inference span rather than the root, so the only usable
    // relation is trace_id.
    // `attempt.ended_at is not null` guards the duration array: ended_at is nullable and
    // SQLite's max() returns NULL if any argument is NULL, so an unfinished attempt would
    // contribute a null that sorts to the front and can displace the p95. The sibling
    // diagnostics query gets this for free by windowing on the same span's ended_at; here the
    // window is on root.ended_at, so the attempt side needs it spelled out. It also drops
    // never-completed attempts from attemptCount, which is the correct reading.
    `select root.requested_model_id as modelId,
      attempt.provider_id as providerId,
      cast(count(*) as text) as attemptCount,
      cast(count(case when attempt.termination_reason is null then 1 end) as text) as successCount,
      json_group_array(max(0, attempt.ended_at - attempt.started_at)) as durations
    from trace_span root
      join trace_span attempt on attempt.trace_id = root.trace_id
        and attempt.attempt_index is not null
        and attempt.provider_id is not null
        and attempt.ended_at is not null
        and attempt.name != ?
    where root.parent_span_id is null
      and ${GENERATION('root')}
      and root.ended_at >= ? and root.ended_at <= ?
      and root.requested_model_id is not null
    group by root.requested_model_id, attempt.provider_id`,
    [SKIPPED_SPAN_NAME, range.start.getTime(), range.end.getTime()],
  );
}

function finalRows(db: BunSQLiteDatabase, range: ResolvedUsageRange): RawFinalRow[] {
  return all<RawFinalRow>(
    db,
    `select root.requested_model_id as modelId,
      root.final_provider_id as providerId,
      cast(count(*) as text) as finalCount
    from trace_span root
    where ${SERVED_ROOT}
      and root.requested_model_id is not null
    group by root.requested_model_id, root.final_provider_id`,
    [range.start.getTime(), range.end.getTime()],
  );
}

function bucketRows(db: BunSQLiteDatabase, range: ResolvedUsageRange, modelId: string): RawBucketRow[] {
  const bucket =
    range.bucketUnit === 'hour'
      ? `min(23, cast((root.ended_at - ${range.start.getTime()}) / 3600000 as integer))`
      : `strftime('%Y-%m-%d', root.ended_at / 1000, 'unixepoch', 'localtime')`;
  return all<RawBucketRow>(
    db,
    `select ${bucket} as bucket,
      root.final_provider_id as providerId,
      cast(count(*) as text) as finalCount
    from trace_span root
    where ${SERVED_ROOT}
      and root.requested_model_id = ?
    group by bucket, root.final_provider_id`,
    [range.start.getTime(), range.end.getTime(), modelId],
  );
}

function all<T>(db: BunSQLiteDatabase, sql: string, params: readonly SQLQueryBindings[]): T[] {
  return (db as IterableDatabase).$client.query<T, SQLQueryBindings[]>(sql).all(...params);
}
