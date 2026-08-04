import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { DashboardOverviewDiagnosticsResponse } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

type RawHealthRow = {
  readonly providerId: string;
  readonly successCount: string;
  readonly attemptCount: string;
  readonly durations: string;
};

type RawCostRow = { readonly modelId: string; readonly estimatedCostNanoUsd: string };

export function overviewDashboardDiagnostics(db: BunSQLiteDatabase): DashboardOverviewDiagnosticsResponse {
  return { providerHealth: providerHealth(db), topModelCosts: topModelCosts(db) };
}

function providerHealth(db: BunSQLiteDatabase): DashboardOverviewDiagnosticsResponse['providerHealth'] {
  const rows = all<RawHealthRow>(
    db,
    `select provider_id as providerId,
      cast(sum(case when termination_reason is null then 1 else 0 end) as text) as successCount,
      cast(count(*) as text) as attemptCount,
      json_group_array(max(0, ended_at - started_at)) as durations
    from trace_span where name = 'aio_proxy.provider.attempt' and provider_id is not null
      group by provider_id order by provider_id`,
    [],
  );
  return rows.map((row) => {
    const durations = (JSON.parse(row.durations) as number[]).sort((left, right) => left - right);
    const successes = parseSqliteInteger(row.successCount);
    const attempts = parseSqliteInteger(row.attemptCount);
    return {
      providerId: row.providerId,
      successRate: Number(successes) / Number(attempts),
      p95LatencyMs: durations[Math.ceil(durations.length * 0.95) - 1]!,
    };
  });
}

function topModelCosts(db: BunSQLiteDatabase): DashboardOverviewDiagnosticsResponse['topModelCosts'] {
  return all<RawCostRow>(
    db,
    `select coalesce(final_model_id, requested_model_id, 'unknown') as modelId,
      cast(sum(estimated_cost_nano_usd) as text) as estimatedCostNanoUsd
    from trace_span where parent_span_id is null and estimated_cost_nano_usd is not null
      group by modelId`,
    [],
  )
    .map((row) => ({ modelId: row.modelId, estimatedCostNanoUsd: parseSqliteInteger(row.estimatedCostNanoUsd) }))
    .sort(
      (left, right) =>
        compareBigIntDescending(left.estimatedCostNanoUsd, right.estimatedCostNanoUsd) ||
        left.modelId.localeCompare(right.modelId),
    )
    .slice(0, 5)
    .map((row) => ({ ...row, estimatedCostNanoUsd: row.estimatedCostNanoUsd.toString() }));
}

function all<T>(db: BunSQLiteDatabase, sql: string, params: readonly SQLQueryBindings[]): T[] {
  return (db as IterableDatabase).$client.query<T, SQLQueryBindings[]>(sql).all(...params);
}

const compareBigIntDescending = (left: bigint, right: bigint) => (left === right ? 0 : left > right ? -1 : 1);
