import { and, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { traceSpan } from '../../schema';
import type { ProviderWindowCostQuery } from '../types';

// ponytail: SQLite SUM then CAST TEXT. Per-row bigint fold if a window exceeds int64.
export function providerWindowCost(db: BunSQLiteDatabase, query: ProviderWindowCostQuery): string | undefined {
  const row = db
    .select({
      cost: sql<string | null>`cast(sum(${traceSpan.estimatedCostNanoUsd}) as text)`.as('cost'),
    })
    .from(traceSpan)
    .where(
      and(
        isNull(traceSpan.parentSpanId),
        isNull(traceSpan.terminationReason),
        eq(traceSpan.finalProviderId, query.providerId),
        gte(traceSpan.endedAt, query.start),
        lte(traceSpan.endedAt, query.end),
        isNotNull(traceSpan.estimatedCostNanoUsd),
      ),
    )
    .get();
  if (row?.cost == null) return undefined;
  return parseSqliteInteger(row.cost).toString();
}
