import { and, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { traceSpan } from '../../schema';
import { consumedUsageRows } from '../consumed-usage';
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
  const consumed = consumedUsageRows(db, query.start, query.end).filter(
    (row) => row.usage.providerId === query.providerId && row.usage.estimatedCostUsd !== undefined,
  );
  if (row?.cost == null && consumed.length === 0) return undefined;
  return consumed
    .reduce((sum, item) => sum + item.estimatedCostNanoUsd, row?.cost == null ? 0n : parseSqliteInteger(row.cost))
    .toString();
}
