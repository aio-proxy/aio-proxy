import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { UsageCallerRanking } from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../../usage-numbers';
import type { DashboardOverviewQuery } from '../../types';
import { usageCallers } from '../../usage-callers';
import { resolveRange } from '../range';

type Row = {
  callerId: string;
  label: string | null;
  kind: UsageCallerRanking['kind'] | null;
  requestCount: string;
  totalTokens: string;
  estimatedCostNanoUsd: string;
};

export function callerRanking(db: BunSQLiteDatabase, query: DashboardOverviewQuery): UsageCallerRanking[] {
  const range = resolveRange(query.range, query.now ?? new Date());
  const daily = range.bucketUnit === 'day';
  const sql = daily
    ? `select caller_id as callerId, null as label, null as kind,
    request_count as requestCount, total_tokens as totalTokens, estimated_cost_nano_usd as estimatedCostNanoUsd
    from usage_caller_daily where local_day >= ? and local_day <= ?`
    : `select coalesce(caller_id, 'legacy') as callerId, caller_label as label, caller_kind as kind,
    '1' as requestCount, cast(coalesce(total_tokens, coalesce(input_tokens, 0) + coalesce(output_tokens, 0)) as text) as totalTokens,
    cast(coalesce(estimated_cost_nano_usd, 0) as text) as estimatedCostNanoUsd
    from trace_span where parent_span_id is null and ended_at >= ? and ended_at <= ?`;
  const client = (db as BunSQLiteDatabase & { $client: Database }).$client;
  const rows = client
    .query<Row, SQLQueryBindings[]>(sql)
    .iterate(
      daily ? localDate(range.start) : range.start.getTime(),
      daily ? localDate(range.end) : range.end.getTime(),
    );
  const names = new Map(usageCallers(db).map((caller) => [caller.id, caller]));
  const totals = new Map<string, UsageCallerRanking>();
  for (const row of rows) {
    const previous = totals.get(row.callerId);
    totals.set(row.callerId, {
      id: row.callerId,
      label: names.get(row.callerId)?.label ?? row.label ?? '',
      kind:
        names.get(row.callerId)?.kind ??
        row.kind ??
        (row.callerId === 'anonymous' ? 'anonymous' : row.callerId === 'legacy' ? 'legacy' : 'agent'),
      requestCount: (BigInt(previous?.requestCount ?? '0') + parseSqliteInteger(row.requestCount)).toString(),
      totalTokens: (BigInt(previous?.totalTokens ?? '0') + parseSqliteInteger(row.totalTokens)).toString(),
      estimatedCostNanoUsd: (
        BigInt(previous?.estimatedCostNanoUsd ?? '0') + parseSqliteInteger(row.estimatedCostNanoUsd)
      ).toString(),
    });
  }
  return [...totals.values()];
}
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
