import { eq, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import { usageDaily } from '../../schema';
import { usageLocalDate } from '../usage-range';

export type TodayUsageResult = {
  readonly inputTokens: bigint;
  readonly outputTokens: bigint;
  readonly estimatedCostNanoUsd: bigint;
};

export function todayUsage(db: BunSQLiteDatabase, now: Date): TodayUsageResult {
  const rows = db
    .select({
      inputTokens: sql<string>`cast(${usageDaily.inputTokens} as text)`,
      outputTokens: sql<string>`cast(${usageDaily.outputTokens} as text)`,
      estimatedCostNanoUsd: sql<string>`cast(${usageDaily.estimatedCostNanoUsd} as text)`,
    })
    .from(usageDaily)
    .where(eq(usageDaily.localDay, usageLocalDate(now)))
    .all();

  let inputTokens = 0n;
  let outputTokens = 0n;
  let estimatedCostNanoUsd = 0n;
  // SQLite numeric aggregation would lose precision or overflow for decimal TEXT totals.
  for (const row of rows) {
    inputTokens += parseSqliteInteger(row.inputTokens);
    outputTokens += parseSqliteInteger(row.outputTokens);
    estimatedCostNanoUsd += parseSqliteInteger(row.estimatedCostNanoUsd);
  }
  return { inputTokens, outputTokens, estimatedCostNanoUsd };
}
