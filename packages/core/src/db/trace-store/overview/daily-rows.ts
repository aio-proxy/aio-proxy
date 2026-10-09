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
  'cacheHitRateAvailable',
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
 * A rollup mixes outcomes, so request counts fan out by terminal state.
 * Consumption remains independent of outcome: when only billed failures exist,
 * the usage row has requestCount zero and the failure row carries the requests.
 */
export function dailyRows(db: BunSQLiteDatabase, range: ResolvedRange, callerId?: string): readonly RootRow[] {
  const statement = (db as IterableDatabase).$client.query<RawDailyRow, SQLQueryBindings[]>(
    callerId === undefined
      ? SELECT
      : SELECT.replace('from usage_daily', 'from usage_caller_daily') + ' and caller_id = ?',
  );
  const rows: RootRow[] = [];
  for (const row of statement.all(
    localDate(range.start),
    localDate(range.end),
    ...(callerId === undefined ? [] : [callerId]),
  )) {
    const value = (column: (typeof COLUMNS)[number]) => parseSqliteInteger(row[column]);
    const cacheHitRateKnown = value('cacheHitRateAvailable') === 1n;
    const failureCount = value('errorCount') + value('interruptedCount');
    const shared = { bucket: row.bucket, peakBucket: row.bucket, dimension: row.dimension, cacheHitRateKnown };
    const successCount = value('successCount');
    if (successCount > 0n || value('usageRequestCount') > 0n) {
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
  shared: {
    readonly bucket: string;
    readonly peakBucket: string;
    readonly dimension: string;
    readonly cacheHitRateKnown: boolean;
  },
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
