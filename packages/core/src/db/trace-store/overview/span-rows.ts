import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import type { OverviewRow } from '../usage-overview/aggregation';
import type { ResolvedRange } from './range';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

/** One root span per row, with cache accounting normalized by the successful attempt's capture path. */
export type RootRow = OverviewRow & {
  readonly cacheReadTokens: bigint;
  readonly cacheWriteTokens: bigint;
  readonly normalizedCacheReadTokens: bigint;
  readonly normalizedPromptTokens: bigint;
  readonly cacheHitRateKnown: boolean;
};

type RawRootRow = {
  readonly bucket: string | number;
  readonly dimension: string;
  readonly terminationReason: string | null;
  readonly transport: string | null;
  readonly targetProtocol: string | null;
  readonly hasUsage: number;
  readonly priced: number;
  readonly estimatedCostNanoUsd: string;
  readonly inputTokens: string;
  readonly outputTokens: string;
  readonly totalTokens: string | null;
  readonly cacheReadTokens: string;
  readonly cacheWriteTokens: string;
};

/**
 * Per-request rows straight from `trace_span`. Exact, but bounded by the trace
 * retention window, so only the rolling hour-bucketed range uses it.
 */
export function spanRows(db: BunSQLiteDatabase, range: ResolvedRange): readonly RootRow[] {
  const bucket =
    range.bucketUnit === 'hour'
      ? `min(23, cast((root.ended_at - ?) / 3600000 as integer))`
      : `strftime('%Y-%m-%d', root.ended_at / 1000, 'unixepoch', 'localtime')`;
  const sql = `
    select ${bucket} as bucket,
      coalesce(root.final_model_id, root.requested_model_id, 'unknown') as dimension,
      root.termination_reason as terminationReason,
      attempt.transport as transport,
      attempt.target_protocol as targetProtocol,
      case when root.input_tokens is not null or root.output_tokens is not null
        or root.total_tokens is not null or root.cache_read_tokens is not null
        or root.cache_write_tokens is not null or root.reasoning_tokens is not null
        or root.estimated_cost_nano_usd is not null then 1 else 0 end as hasUsage,
      case when root.estimated_cost_nano_usd is not null then 1 else 0 end as priced,
      cast(coalesce(root.estimated_cost_nano_usd, 0) as text) as estimatedCostNanoUsd,
      cast(coalesce(root.input_tokens, 0) as text) as inputTokens,
      cast(coalesce(root.output_tokens, 0) as text) as outputTokens,
      cast(root.total_tokens as text) as totalTokens,
      cast(coalesce(root.cache_read_tokens, 0) as text) as cacheReadTokens,
      cast(coalesce(root.cache_write_tokens, 0) as text) as cacheWriteTokens
    from trace_span root
    left join trace_span attempt on attempt.trace_id = root.trace_id
      and attempt.parent_span_id = root.span_id
      and attempt.name = 'aio_proxy.provider.attempt' and attempt.termination_reason is null
    where root.parent_span_id is null and root.ended_at >= ? and root.ended_at <= ?`;
  const params = [
    ...(range.bucketUnit === 'hour' ? [range.start.getTime()] : []),
    range.start.getTime(),
    range.end.getTime(),
  ];
  const statement = (db as IterableDatabase).$client.query<RawRootRow, SQLQueryBindings[]>(sql);
  return statement.all(...(params as SQLQueryBindings[])).map((row) => {
    const inputTokens = parseSqliteInteger(row.inputTokens);
    const outputTokens = parseSqliteInteger(row.outputTokens);
    const cacheReadTokens = parseSqliteInteger(row.cacheReadTokens);
    const cacheWriteTokens = parseSqliteInteger(row.cacheWriteTokens);
    const capturesCache = row.transport === 'raw' || row.transport === 'ai_sdk';
    const cachedTokens = cacheReadTokens + cacheWriteTokens;
    let normalizedPromptTokens = 0n;
    if (row.transport === 'raw' && row.targetProtocol === 'anthropic') {
      normalizedPromptTokens = inputTokens + cachedTokens;
    } else if (capturesCache) {
      normalizedPromptTokens = inputTokens > cachedTokens ? inputTokens : cachedTokens;
    }
    return {
      bucket: row.bucket,
      dimension: row.dimension,
      terminationReason: row.terminationReason,
      requestCount: 1n,
      hasUsage: row.hasUsage,
      priced: row.priced,
      estimatedCostNanoUsd: parseSqliteInteger(row.estimatedCostNanoUsd),
      inputTokens,
      outputTokens,
      totalTokens: row.totalTokens === null ? inputTokens + outputTokens : parseSqliteInteger(row.totalTokens),
      cacheReadTokens,
      cacheWriteTokens,
      normalizedCacheReadTokens: capturesCache ? cacheReadTokens : 0n,
      normalizedPromptTokens,
      cacheHitRateKnown: true,
    };
  });
}
