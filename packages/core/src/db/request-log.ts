import type {
  DashboardRequestLogsPageSize,
  DashboardRequestLogsResponse,
  DashboardUsageOverviewResponse,
  RequestOutcome,
  UsageOverviewGroupBy,
  UsageOverviewMetric,
  UsageOverviewRange,
  UsageRow,
} from "@aio-proxy/types";
import { and, desc, eq, gte, lt, lte, sql } from "drizzle-orm";
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

export type RequestLogsQuery = {
  readonly page: number;
  readonly pageSize: DashboardRequestLogsPageSize;
  readonly startedAfter?: Date;
  readonly completedBefore?: Date;
  readonly requestId?: string;
  readonly outcome?: RequestOutcome;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
};

export type RequestLogStore = {
  readonly insertFinal: (input: RequestLogFinal) => void;
  readonly list: (query: RequestLogsQuery) => DashboardRequestLogsResponse;
  readonly overview: (query: UsageOverviewQuery) => DashboardUsageOverviewResponse;
  readonly prune: (cutoff: Date) => void;
};

type ChartRow = {
  readonly bucket: string | number;
  readonly dimension: string;
  readonly kind: "dimension" | "failed" | "cancelled";
  readonly value: number;
};

type ChartBucket = {
  readonly identity: string | number;
  readonly key: string;
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
    list(query) {
      const filter = and(
        query.startedAfter === undefined ? undefined : gte(requestLog.startedAt, query.startedAfter),
        query.completedBefore === undefined ? undefined : lte(requestLog.completedAt, query.completedBefore),
        query.requestId === undefined ? undefined : eq(requestLog.requestId, query.requestId),
        query.outcome === undefined ? undefined : eq(requestLog.outcome, query.outcome),
        query.inboundProtocol === undefined ? undefined : eq(requestLog.inboundProtocol, query.inboundProtocol),
        query.requestedModelId === undefined ? undefined : eq(requestLog.requestedModelId, query.requestedModelId),
        query.finalProviderId === undefined ? undefined : eq(requestLog.finalProviderId, query.finalProviderId),
        query.finalModelId === undefined ? undefined : eq(requestLog.finalModelId, query.finalModelId),
        query.finalStatusCode === undefined ? undefined : eq(requestLog.finalStatusCode, query.finalStatusCode),
      );
      const total = db
        .select({ value: sql<number>`count(*)`.mapWith(Number) })
        .from(requestLog)
        .where(filter)
        .get()!.value;
      const rows = db
        .select({ request: requestLog, usage })
        .from(requestLog)
        .leftJoin(usage, eq(usage.requestId, requestLog.requestId))
        .where(filter)
        .orderBy(desc(requestLog.completedAt), desc(requestLog.requestId))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .all();

      return {
        items: rows.map(({ request, usage: usageRow }) => ({
          requestId: request.requestId,
          inboundProtocol: request.inboundProtocol,
          requestedModelId: request.requestedModelId,
          outcome: request.outcome,
          ...(request.finalProviderId === null ? {} : { finalProviderId: request.finalProviderId }),
          ...(request.finalModelId === null ? {} : { finalModelId: request.finalModelId }),
          ...(request.finalStatusCode === null ? {} : { finalStatusCode: request.finalStatusCode }),
          ...(request.errorCode === null ? {} : { errorCode: request.errorCode }),
          attempts: request.attempts,
          startedAt: request.startedAt.toISOString(),
          completedAt: request.completedAt.toISOString(),
          durationMs: request.durationMs,
          ...(usageRow === null
            ? {}
            : {
                usage: {
                  providerId: usageRow.providerId,
                  modelId: usageRow.modelId,
                  ...(usageRow.priceModelId === null ? {} : { priceModelId: usageRow.priceModelId }),
                  ...(usageRow.inputTokens === null ? {} : { inputTokens: usageRow.inputTokens }),
                  ...(usageRow.outputTokens === null ? {} : { outputTokens: usageRow.outputTokens }),
                  ...(usageRow.totalTokens === null ? {} : { totalTokens: usageRow.totalTokens }),
                  ...(usageRow.cacheReadTokens === null ? {} : { cacheReadTokens: usageRow.cacheReadTokens }),
                  ...(usageRow.cacheWriteTokens === null ? {} : { cacheWriteTokens: usageRow.cacheWriteTokens }),
                  ...(usageRow.reasoningTokens === null ? {} : { reasoningTokens: usageRow.reasoningTokens }),
                  ...(usageRow.estimatedCostUsd === null ? {} : { estimatedCostUsd: usageRow.estimatedCostUsd }),
                },
              }),
        })),
        page: query.page,
        pageSize: query.pageSize,
        total,
        pageCount: Math.ceil(total / query.pageSize),
      };
    },
    overview(query) {
      const now = query.now ?? new Date();
      const { start, end, bucketUnit } = resolveRange(query.range, now);
      const rangeFilter = and(gte(requestLog.completedAt, start), lte(requestLog.completedAt, end));
      const summaryRow = db
        .select({
          estimatedCostUsd: sql<number>`coalesce(sum(${usage.estimatedCostUsd}), 0)`.mapWith(Number),
          pricedRequestCount:
            sql<number>`coalesce(sum(case when ${usage.estimatedCostUsd} is not null then 1 else 0 end), 0)`.mapWith(
              Number,
            ),
          usageRequestCount:
            sql<number>`coalesce(sum(case when ${usage.requestId} is not null then 1 else 0 end), 0)`.mapWith(Number),
          requestCount: sql<number>`count(*)`.mapWith(Number),
          successCount:
            sql<number>`coalesce(sum(case when ${requestLog.outcome} = 'success' then 1 else 0 end), 0)`.mapWith(
              Number,
            ),
          failureCount:
            sql<number>`coalesce(sum(case when ${requestLog.outcome} = 'failure' then 1 else 0 end), 0)`.mapWith(
              Number,
            ),
          cancelledCount:
            sql<number>`coalesce(sum(case when ${requestLog.outcome} = 'cancelled' then 1 else 0 end), 0)`.mapWith(
              Number,
            ),
          inputTokens: sql<number>`coalesce(sum(${usage.inputTokens}), 0)`.mapWith(Number),
          outputTokens: sql<number>`coalesce(sum(${usage.outputTokens}), 0)`.mapWith(Number),
        })
        .from(requestLog)
        .leftJoin(usage, and(eq(usage.requestId, requestLog.requestId), eq(requestLog.outcome, "success")))
        .where(rangeFilter)
        .get()!;

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
      ? sql<number>`min(23, cast((${requestLog.completedAt} - ${start.getTime()}) / 3600000 as integer))`.mapWith(
          Number,
        )
      : sql<string>`strftime('%Y-%m-%d', ${requestLog.completedAt} / 1000, 'unixepoch', 'localtime')`;
  const normalDimension =
    groupBy === "model"
      ? sql<string>`coalesce(${requestLog.finalModelId}, ${requestLog.requestedModelId})`
      : sql<string>`coalesce(${requestLog.finalProviderId}, ${usage.providerId}, 'unknown')`;

  if (metric === "requests") {
    const kind = sql<ChartRow["kind"]>`case
      when ${requestLog.outcome} = 'failure' then 'failed'
      when ${requestLog.outcome} = 'cancelled' then 'cancelled'
      else 'dimension'
    end`;
    return db
      .select({ bucket, dimension: normalDimension, kind, value: sql<number>`count(*)`.mapWith(Number) })
      .from(requestLog)
      .leftJoin(usage, eq(usage.requestId, requestLog.requestId))
      .where(rangeFilter)
      .groupBy(bucket, normalDimension, kind)
      .all();
  }

  const value =
    metric === "cost"
      ? sql<number>`coalesce(sum(${usage.estimatedCostUsd}), 0)`.mapWith(Number)
      : sql<number>`coalesce(sum(coalesce(${usage.inputTokens}, 0) + coalesce(${usage.outputTokens}, 0)), 0)`.mapWith(
          Number,
        );
  return db
    .select({ bucket, dimension: normalDimension, kind: sql<"dimension">`'dimension'`, value })
    .from(requestLog)
    .innerJoin(usage, eq(usage.requestId, requestLog.requestId))
    .where(and(rangeFilter, eq(requestLog.outcome, "success")))
    .groupBy(bucket, normalDimension)
    .all();
}

function buildChart(rows: readonly ChartRow[], metric: UsageOverviewMetric, chartBuckets: readonly ChartBucket[]) {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.kind === "dimension") {
      totals.set(row.dimension, (totals.get(row.dimension) ?? 0) + row.value);
    }
  }
  const ranked = [...totals]
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .map(([key]) => key);
  const retained = ranked.slice(0, 5);
  const hasOther = ranked.length > retained.length;
  const series = [
    ...retained.map((dimension) => ({ key: chartDimensionKey(dimension), kind: "dimension" as const })),
    ...(hasOther ? [{ key: "__other__", kind: "other" as const }] : []),
    ...(metric === "requests"
      ? [
          { key: "__failed__", kind: "failed" as const },
          { key: "__cancelled__", kind: "cancelled" as const },
        ]
      : []),
  ];
  const retainedSet = new Set(retained);
  const valuesByBucket = new Map<string | number, Record<string, number>>();
  for (const row of rows) {
    const dimension =
      row.kind === "failed"
        ? "__failed__"
        : row.kind === "cancelled"
          ? "__cancelled__"
          : retainedSet.has(row.dimension)
            ? chartDimensionKey(row.dimension)
            : "__other__";
    const values = valuesByBucket.get(row.bucket) ?? {};
    values[dimension] = (values[dimension] ?? 0) + row.value;
    valuesByBucket.set(row.bucket, values);
  }

  return {
    series,
    buckets: chartBuckets.map(({ identity, key }) => ({
      key,
      values: Object.fromEntries(
        series.map(({ key: seriesKey }) => [seriesKey, valuesByBucket.get(identity)?.[seriesKey] ?? 0]),
      ),
    })),
  };
}

const dimensionKeyPrefix = "dimension:";
const reservedSeriesKeys = new Set(["__failed__", "__cancelled__", "__other__"]);

function chartDimensionKey(dimension: string): string {
  const needsEncoding =
    reservedSeriesKeys.has(dimension) ||
    dimension.startsWith(dimensionKeyPrefix) ||
    dimension.includes(".") ||
    dimension.includes("[") ||
    dimension.includes("]");
  return needsEncoding ? `${dimensionKeyPrefix}${encodeURIComponent(dimension).replaceAll(".", "%2E")}` : dimension;
}

function bucketKeys(range: UsageOverviewRange, start: Date, end: Date): readonly ChartBucket[] {
  if (range === "24h") {
    return Array.from({ length: 24 }, (_, index) => ({
      identity: index,
      key: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    }));
  }

  const keys: ChartBucket[] = [];
  const day = new Date(start);
  while (day <= end) {
    keys.push({ identity: localDate(day), key: day.toISOString() });
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
