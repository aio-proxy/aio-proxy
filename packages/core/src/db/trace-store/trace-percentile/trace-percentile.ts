import type { DashboardTracePercentileResponse } from '@aio-proxy/types';
import { and, eq, gte, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import { traceSpan } from '../../schema';
import { SUCCEEDED } from '../trace-filters';

/** 样本窗口的半宽：锚点前后各取这么多，所以整个窗口是两倍宽。 */
const WINDOW_MS = 3_600_000;

/**
 * 少于这个数的样本说明不了任何事：一条比 4 条里的 3 条慢，画出来就是 p75，
 * 读者会当成一个结论。不够就整块不给，比给一个假的分位诚实。
 */
const MIN_SAMPLES = 30;

// 两列都是 timestamp_ms（底层就是整数），相减直接得到毫秒。
const DURATION_MS = sql<number>`(${traceSpan.endedAt} - ${traceSpan.startedAt})`;

// `aio_proxy.operation` 留在 JSON 里。计 token 和生成可以落到同一个 finalModelId，
// 时长差一个数量级；老数据没这个键，按生成（`model`）算。
const OPERATION = sql<string>`coalesce(json_extract(${traceSpan.attributes}, '$."aio_proxy.operation"'), 'model')`;

/** 排序后取第 n 条的时长。样本数已过门槛，offset 必然落在结果集里。 */
function durationAt(db: BunSQLiteDatabase, where: SQL, offset: number): number {
  const row = db
    .select({ durationMs: DURATION_MS.as('duration_ms') })
    .from(traceSpan)
    .where(where)
    .orderBy(DURATION_MS)
    .limit(1)
    .offset(offset)
    .get();
  return Number(row?.durationMs ?? 0);
}

/**
 * 把一条调用链的时长放到「它自己前后一小时里同模型成功调用链」的分布里。
 *
 * 窗口锚在目标自己的 `startedAt` 而不是当前时间：看一条昨天的调用链，要回答的是
 * 「它在当时那批流量里算快还是慢」，拿它和今天最近一小时比毫无意义 —— 那批样本里
 * 根本没有它，它的时长还可能整个落在 [min, max] 之外。
 *
 * 全程只看根 span：分位比的是整个请求的端到端时长，attempt 子 span 各自的耗时不是同一个量。
 * 同模型还要同操作：计 token 和生成不是一个分布。目标没结束、没有 `finalModelId`、
 * 或者本身失败时没有可比的口径，直接不给结论。
 */
export function percentile(db: BunSQLiteDatabase, traceId: string): DashboardTracePercentileResponse {
  const target = db
    .select({
      modelId: traceSpan.finalModelId,
      startedAt: traceSpan.startedAt,
      durationMs: DURATION_MS.as('duration_ms'),
      operation: OPERATION.as('operation'),
    })
    .from(traceSpan)
    .where(
      and(eq(traceSpan.traceId, traceId), isNull(traceSpan.parentSpanId), isNotNull(traceSpan.finalModelId), SUCCEEDED),
    )
    .get();
  const modelId = target?.modelId;
  if (modelId === undefined || modelId === null || target?.startedAt === undefined) return { comparison: null };
  const durationMs = Number(target.durationMs ?? 0);
  const anchorMs = target.startedAt.getTime();
  const operation = target.operation;

  const sample = and(
    isNull(traceSpan.parentSpanId),
    eq(traceSpan.finalModelId, modelId),
    eq(OPERATION, operation),
    gte(traceSpan.startedAt, new Date(anchorMs - WINDOW_MS)),
    lte(traceSpan.startedAt, new Date(anchorMs + WINDOW_MS)),
    SUCCEEDED,
  ) as SQL;

  const stats = db
    .select({
      sampleCount: sql<number>`count(*)`.as('sample_count'),
      minMs: sql<number>`min(${DURATION_MS})`.as('min_ms'),
      maxMs: sql<number>`max(${DURATION_MS})`.as('max_ms'),
      // 严格小于：跟目标同样快的调用链不算「比它快」，一堆并列的时长才不会被算成高分位。
      lower: sql<number>`sum(case when ${DURATION_MS} < ${durationMs} then 1 else 0 end)`.as('lower'),
    })
    .from(traceSpan)
    .where(sample)
    .get();

  const sampleCount = Number(stats?.sampleCount ?? 0);
  if (sampleCount < MIN_SAMPLES) return { comparison: null };

  const rank = (fraction: number) =>
    durationAt(db, sample, Math.min(sampleCount - 1, Math.floor(sampleCount * fraction)));

  return {
    comparison: {
      modelId,
      sampleCount,
      durationMs,
      percentile: Math.round((Number(stats?.lower ?? 0) / sampleCount) * 100),
      minMs: Number(stats?.minMs ?? 0),
      maxMs: Number(stats?.maxMs ?? 0),
      p50Ms: rank(0.5),
      p95Ms: rank(0.95),
    },
  };
}
