import type {
  DashboardUsageOverviewResponse,
  UsageOverviewGroupBy,
  UsageOverviewMetric,
  UsageOverviewRange,
  UsageRow,
} from "@aio-proxy/types";
import { and, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { requestLog } from "./schema/request-log";
import { usage } from "./schema/usage";

export type RequestLogInsert = typeof requestLog.$inferInsert;

type RequestLogFinalBase = Omit<RequestLogInsert, "outcome">;

export type RequestLogFinal =
  | (RequestLogFinalBase & { readonly outcome: "success"; readonly usage?: undefined })
  | (RequestLogFinalBase & {
      readonly outcome: "success";
      readonly finalProviderId: string;
      readonly finalModelId: string;
      readonly usage: UsageRow;
    })
  | (RequestLogFinalBase & { readonly outcome: "failure" | "cancelled"; readonly usage?: never });

export type UsageOverviewQuery = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly now?: Date;
};

export type RequestLogStore = {
  readonly insertFinal: (input: RequestLogFinal) => void;
  readonly overview: (query: UsageOverviewQuery) => DashboardUsageOverviewResponse;
  readonly prune: (cutoff: Date) => void;
};

type ChartRow = {
  readonly bucket: string;
  readonly dimension: string;
  readonly value: number;
};

export function createRequestLogStore(db: BunSQLiteDatabase): RequestLogStore {
  return {
    insertFinal(input) {
      if (input.usage !== undefined && input.outcome !== "success") {
        throw new Error("Only successful requests can include usage");
      }
      if (
        input.usage !== undefined &&
        (input.usage.providerId !== input.finalProviderId || input.usage.modelId !== input.finalModelId)
      ) {
        throw new Error("Usage provider and model must match the final route");
      }
      db.transaction((tx) => {
        const { usage: usageRow, ...terminal } = input;
        tx.insert(requestLog).values(terminal).run();
        if (usageRow !== undefined) {
          tx.insert(usage)
            .values({
              id: input.requestId,
              requestId: input.requestId,
              ...usageRow,
              createdAt: input.completedAt,
            })
            .run();
        }
      });
    },
    overview(query) {
      const now = query.now ?? new Date();
      const { start, end, bucketUnit } = resolveRange(query.range, now);
      const rangeFilter = and(gte(requestLog.completedAt, start), lte(requestLog.completedAt, end));
      const summaryRow = db
        .select({
          estimatedCostUsd: sql<number>`coalesce(sum(${usage.estimatedCostUsd}), 0)`.mapWith(Number),
          pricedRequestCount:
            sql<number>`sum(case when ${usage.estimatedCostUsd} is not null then 1 else 0 end)`.mapWith(Number),
          usageRequestCount: sql<number>`sum(case when ${usage.requestId} is not null then 1 else 0 end)`.mapWith(
            Number,
          ),
          requestCount: sql<number>`count(*)`.mapWith(Number),
          successCount: sql<number>`sum(case when ${requestLog.outcome} = 'success' then 1 else 0 end)`.mapWith(Number),
          failureCount: sql<number>`sum(case when ${requestLog.outcome} = 'failure' then 1 else 0 end)`.mapWith(Number),
          cancelledCount: sql<number>`sum(case when ${requestLog.outcome} = 'cancelled' then 1 else 0 end)`.mapWith(
            Number,
          ),
          inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`.mapWith(Number),
          outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`.mapWith(Number),
        })
        .from(requestLog)
        .leftJoin(usage, and(eq(usage.requestId, requestLog.requestId), eq(requestLog.outcome, "success")))
        .where(rangeFilter)
        .get() ?? {
        estimatedCostUsd: 0,
        pricedRequestCount: 0,
        usageRequestCount: 0,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        cancelledCount: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

      const elapsedMinutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000);
      const successRate =
        summaryRow.successCount + summaryRow.failureCount === 0
          ? null
          : summaryRow.successCount / (summaryRow.successCount + summaryRow.failureCount);
      const pricingCoverage =
        summaryRow.usageRequestCount === 0 ? null : summaryRow.pricedRequestCount / summaryRow.usageRequestCount;
      const totalTokens = summaryRow.inputTokens + summaryRow.outputTokens;
      const rows = chartRows(db, query.metric, query.groupBy, bucketUnit, start, rangeFilter);
      const { series, buckets } = buildChart(rows, query.metric, bucketKeys(query.range, start, end));

      return {
        range: query.range,
        metric: query.metric,
        groupBy: query.groupBy,
        rangeStart: start.toISOString(),
        rangeEnd: end.toISOString(),
        bucketUnit,
        summary: {
          estimatedCostUsd: summaryRow.estimatedCostUsd,
          pricingCoverage,
          pricedRequestCount: summaryRow.pricedRequestCount,
          usageRequestCount: summaryRow.usageRequestCount,
          requestCount: summaryRow.requestCount,
          successCount: summaryRow.successCount,
          failureCount: summaryRow.failureCount,
          cancelledCount: summaryRow.cancelledCount,
          successRate,
          inputTokens: summaryRow.inputTokens,
          outputTokens: summaryRow.outputTokens,
          totalTokens,
          averageRpm: summaryRow.requestCount / elapsedMinutes,
          averageTpm: totalTokens / elapsedMinutes,
        },
        series,
        buckets,
      };
    },
    prune(cutoff) {
      db.transaction((tx) => {
        tx.delete(usage).where(lt(usage.createdAt, cutoff)).run();
        tx.delete(requestLog).where(lt(requestLog.completedAt, cutoff)).run();
      });
    },
  };
}

function resolveRange(range: UsageOverviewRange, now: Date) {
  if (range === "24h") {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: "hour" as const };
  }

  const days = range === "7d" ? 7 : range === "14d" ? 14 : 30;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: "day" as const };
}

function chartRows(
  db: BunSQLiteDatabase,
  metric: UsageOverviewMetric,
  groupBy: UsageOverviewGroupBy,
  bucketUnit: "hour" | "day",
  start: Date,
  rangeFilter: ReturnType<typeof and>,
): readonly ChartRow[] {
  const bucket =
    bucketUnit === "hour"
      ? sql<string>`strftime(
          '%Y-%m-%d %H:%M',
          (${start.getTime()} + min(23, cast((${requestLog.completedAt} - ${start.getTime()}) / 3600000 as integer)) * 3600000) / 1000,
          'unixepoch',
          'localtime'
        )`
      : sql<string>`strftime('%Y-%m-%d', ${requestLog.completedAt} / 1000, 'unixepoch', 'localtime')`;
  const normalDimension =
    groupBy === "model"
      ? sql<string>`coalesce(${requestLog.finalModelId}, ${requestLog.requestedModelId})`
      : sql<string>`coalesce(${requestLog.finalProviderId}, ${usage.providerId}, 'unknown')`;

  if (metric === "requests") {
    const dimension = sql<string>`case
      when ${requestLog.outcome} = 'failure' then '__failed__'
      when ${requestLog.outcome} = 'cancelled' then '__cancelled__'
      else ${normalDimension}
    end`;
    return db
      .select({ bucket, dimension, value: sql<number>`count(*)`.mapWith(Number) })
      .from(requestLog)
      .leftJoin(usage, eq(usage.requestId, requestLog.requestId))
      .where(rangeFilter)
      .groupBy(bucket, dimension)
      .all();
  }

  const value =
    metric === "cost"
      ? sql<number>`coalesce(sum(${usage.estimatedCostUsd}), 0)`.mapWith(Number)
      : sql<number>`coalesce(sum(coalesce(${usage.inputTokens}, 0) + coalesce(${usage.outputTokens}, 0)), 0)`.mapWith(
          Number,
        );
  return db
    .select({ bucket, dimension: normalDimension, value })
    .from(requestLog)
    .innerJoin(usage, eq(usage.requestId, requestLog.requestId))
    .where(and(rangeFilter, eq(requestLog.outcome, "success")))
    .groupBy(bucket, normalDimension)
    .all();
}

function buildChart(rows: readonly ChartRow[], metric: UsageOverviewMetric, keys: readonly string[]) {
  const pinned = new Set(["__failed__", "__cancelled__"]);
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (!pinned.has(row.dimension)) {
      totals.set(row.dimension, (totals.get(row.dimension) ?? 0) + row.value);
    }
  }
  const ranked = [...totals]
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .map(([key]) => key);
  const retained = ranked.slice(0, 5);
  const hasOther = ranked.length > retained.length;
  const series = [
    ...retained.map((key) => ({ key, kind: "dimension" as const })),
    ...(hasOther ? [{ key: "__other__", kind: "other" as const }] : []),
    ...(metric === "requests"
      ? [
          { key: "__failed__", kind: "failed" as const },
          { key: "__cancelled__", kind: "cancelled" as const },
        ]
      : []),
  ];
  const retainedSet = new Set(retained);
  const valuesByBucket = new Map<string, Record<string, number>>();
  for (const row of rows) {
    const dimension = pinned.has(row.dimension) || retainedSet.has(row.dimension) ? row.dimension : "__other__";
    const values = valuesByBucket.get(row.bucket) ?? {};
    values[dimension] = (values[dimension] ?? 0) + row.value;
    valuesByBucket.set(row.bucket, values);
  }

  return {
    series,
    buckets: keys.map((key) => ({
      key,
      values: Object.fromEntries(
        series.map(({ key: seriesKey }) => [seriesKey, valuesByBucket.get(key)?.[seriesKey] ?? 0]),
      ),
    })),
  };
}

function bucketKeys(range: UsageOverviewRange, start: Date, end: Date): readonly string[] {
  if (range === "24h") {
    return Array.from({ length: 24 }, (_, index) => {
      const value = new Date(start.getTime() + index * 60 * 60 * 1000);
      return `${localDate(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
    });
  }

  const keys: string[] = [];
  const day = new Date(start);
  while (day <= end) {
    keys.push(localDate(day));
    day.setDate(day.getDate() + 1);
  }
  return keys;
}

function localDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
