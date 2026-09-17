import type { DashboardTraceSummaryBucketSize, DashboardTraceSummaryResponse } from '@aio-proxy/types';
import { and, isNull, sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { traceSpan } from '../schema';
import { traceFilterConditions } from './trace-filters';
import type { TracesSummaryQuery } from './types';

const BUCKET_SIZES: readonly (readonly [DashboardTraceSummaryBucketSize, number])[] = [
  ['1m', 60_000],
  ['5m', 300_000],
  ['30m', 1_800_000],
  ['1h', 3_600_000],
  ['1d', 86_400_000],
];

// 桶数的上界。选最细的、且桶数不超过它的那一档，得到的就是设计稿要的
// 1h→1m / 24h→30m / 7d→1h / 45d→1d，同时任何离谱的时间范围都不会炸出几万个桶。
const MAX_BUCKETS = 180;

function resolveBucket(spanMs: number): readonly [DashboardTraceSummaryBucketSize, number] {
  return BUCKET_SIZES.find(([, size]) => spanMs / size <= MAX_BUCKETS) ?? BUCKET_SIZES[BUCKET_SIZES.length - 1]!;
}

export function summary(db: BunSQLiteDatabase, query: TracesSummaryQuery): DashboardTraceSummaryResponse {
  const startMs = query.startedAfter.getTime();
  const endMs = query.startedBefore.getTime();
  const [bucket, bucketMs] = resolveBucket(Math.max(0, endMs - startMs));
  const count = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));

  // 桶对齐到范围起点而不是 epoch：时间范围是用户在本地时区选的，按 epoch 取整会让
  // 1d 的桶界落在 UTC 零点上，跟图上标的起点对不齐。减去起点就没有时区这回事了。
  const index = sql<number>`(${traceSpan.startedAt} - ${startMs}) / ${bucketMs}`.as('bucket_index');
  const rows = db
    .select({
      index,
      success: sql<number>`sum(case when ${traceSpan.statusCode} = 1 then 1 else 0 end)`.as('success'),
      error: sql<number>`sum(case when ${traceSpan.statusCode} = 2 then 1 else 0 end)`.as('error'),
    })
    .from(traceSpan)
    .where(and(isNull(traceSpan.parentSpanId), ...traceFilterConditions(query)))
    .groupBy(sql`bucket_index`)
    .all();

  const buckets = Array.from({ length: count }, (_, slot) => ({
    at: new Date(startMs + slot * bucketMs).toISOString(),
    success: 0,
    error: 0,
  }));
  for (const row of rows) {
    // startedBefore 是闭区间，正好落在末端的那条会算出 count，收进最后一个桶
    const slot = buckets[Math.min(Number(row.index), count - 1)];
    if (slot === undefined) continue;
    slot.success += Number(row.success);
    slot.error += Number(row.error);
  }

  return {
    bucket,
    buckets,
    totals: buckets.reduce(
      (totals, slot) => ({ success: totals.success + slot.success, error: totals.error + slot.error }),
      { success: 0, error: 0 },
    ),
  };
}
