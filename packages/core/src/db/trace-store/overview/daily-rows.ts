import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { parseSqliteInteger } from '../../../usage-numbers';
import type { ResolvedRange } from './range';
import type { RootRow } from './span-rows';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

const COLUMNS = [
  'requestCount',
  'successCount',
  'errorCount',
  'cancelledCount',
  'interruptedCount',
  'usageRequestCount',
  'pricedRequestCount',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'estimatedCostNanoUsd',
  'normalizedCacheReadTokens',
  'normalizedPromptTokens',
] as const;

type RawDailyRow = { readonly bucket: string; readonly dimension: string } & Record<(typeof COLUMNS)[number], string>;

const snakeCase = (name: string) => name.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const SELECT = `select local_day as bucket, model_dimension as dimension,
  ${COLUMNS.map((column) => `cast(${snakeCase(column)} as text) as ${column}`).join(',\n  ')}
  from usage_daily where local_day >= ? and local_day <= ?`;

/**
 * Pre-rolled day rows from `usage_daily`, which survives trace pruning and is
 * therefore the only source that covers the longer ranges.
 *
 * One rollup row mixes outcomes, but the aggregator keys off a single
 * `terminationReason`, so each row fans out into up to three. Tokens and cost
 * ride entirely on the success row: failed and cancelled requests are never
 * priced and carry no usage, so the rollup's mixed totals equal the success
 * totals. That also matches `aggregation.ts`, which drops non-null termination
 * reasons from the cost and token charts.
 */
export function dailyRows(db: BunSQLiteDatabase, range: ResolvedRange): readonly RootRow[] {
  const statement = (db as IterableDatabase).$client.query<RawDailyRow, SQLQueryBindings[]>(SELECT);
  const rows: RootRow[] = [];
  for (const row of statement.all(localDate(range.start), localDate(range.end))) {
    const value = (column: (typeof COLUMNS)[number]) => parseSqliteInteger(row[column]);
    const failureCount = value('errorCount') + value('interruptedCount');
    const shared = { bucket: row.bucket, dimension: row.dimension };
    const successCount = value('successCount');
    if (successCount > 0n) {
      rows.push({
        ...shared,
        terminationReason: null,
        requestCount: successCount,
        hasUsage: value('usageRequestCount'),
        priced: value('pricedRequestCount'),
        estimatedCostNanoUsd: value('estimatedCostNanoUsd'),
        inputTokens: value('inputTokens'),
        outputTokens: value('outputTokens'),
        totalTokens: value('totalTokens'),
        cacheReadTokens: value('cacheReadTokens'),
        cacheWriteTokens: value('cacheWriteTokens'),
        normalizedCacheReadTokens: value('normalizedCacheReadTokens'),
        normalizedPromptTokens: value('normalizedPromptTokens'),
      });
    }
    if (failureCount > 0n) rows.push(outcomeRow(shared, 'failure', failureCount));
    const cancelledCount = value('cancelledCount');
    if (cancelledCount > 0n) rows.push(outcomeRow(shared, 'cancelled', cancelledCount));
  }
  return rows;
}

function outcomeRow(
  shared: { readonly bucket: string; readonly dimension: string },
  terminationReason: 'failure' | 'cancelled',
  requestCount: bigint,
): RootRow {
  return {
    ...shared,
    terminationReason,
    requestCount,
    hasUsage: 0n,
    priced: 0n,
    estimatedCostNanoUsd: 0n,
    inputTokens: 0n,
    outputTokens: 0n,
    totalTokens: 0n,
    cacheReadTokens: 0n,
    cacheWriteTokens: 0n,
    normalizedCacheReadTokens: 0n,
    normalizedPromptTokens: 0n,
  };
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

const pad = (value: number) => String(value).padStart(2, '0');
