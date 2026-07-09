import { desc, eq } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { usage } from "./schema/usage";

export type UsageLedgerInsert = {
  readonly id: string;
  readonly traceId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly priceModelId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly estimatedCostUsd?: number;
  readonly createdAt: Date;
};

export type UsageLedgerRow = UsageLedgerInsert;

export type UsageSummary = {
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  readonly estimatedCostUsd: number;
};

export type UsageLedger = {
  readonly insert: (row: UsageLedgerInsert) => void;
  readonly list: (limit: number) => readonly UsageLedgerRow[];
  readonly summary: (limit: number) => UsageSummary;
  readonly updateCost: (id: string, cost: { readonly estimatedCostUsd: number; readonly priceModelId: string }) => void;
};

export function createUsageLedger(db: BunSQLiteDatabase): UsageLedger {
  const list = (limit: number) =>
    db.select().from(usage).orderBy(desc(usage.createdAt)).limit(limit).all().map(rowFromDb);

  return {
    insert(row) {
      db.insert(usage).values(row).run();
    },
    list,
    summary(limit) {
      return list(limit).reduce<UsageSummary>(
        (acc, row) => ({
          requestCount: acc.requestCount + 1,
          inputTokens: acc.inputTokens + (row.inputTokens ?? 0),
          outputTokens: acc.outputTokens + (row.outputTokens ?? 0),
          totalTokens: acc.totalTokens + (row.totalTokens ?? 0),
          cacheReadTokens: acc.cacheReadTokens + (row.cacheReadTokens ?? 0),
          cacheWriteTokens: acc.cacheWriteTokens + (row.cacheWriteTokens ?? 0),
          reasoningTokens: acc.reasoningTokens + (row.reasoningTokens ?? 0),
          estimatedCostUsd: acc.estimatedCostUsd + (row.estimatedCostUsd ?? 0),
        }),
        emptySummary(),
      );
    },
    updateCost(id, cost) {
      db.update(usage).set(cost).where(eq(usage.id, id)).run();
    },
  };
}

export function emptyUsageSummary(): UsageSummary {
  return emptySummary();
}

function rowFromDb(row: typeof usage.$inferSelect): UsageLedgerRow {
  return {
    id: row.id,
    traceId: row.traceId,
    providerId: row.providerId,
    modelId: row.modelId,
    ...(row.priceModelId === null ? {} : { priceModelId: row.priceModelId }),
    ...(row.inputTokens === null ? {} : { inputTokens: row.inputTokens }),
    ...(row.outputTokens === null ? {} : { outputTokens: row.outputTokens }),
    ...(row.totalTokens === null ? {} : { totalTokens: row.totalTokens }),
    ...(row.cacheReadTokens === null ? {} : { cacheReadTokens: row.cacheReadTokens }),
    ...(row.cacheWriteTokens === null ? {} : { cacheWriteTokens: row.cacheWriteTokens }),
    ...(row.reasoningTokens === null ? {} : { reasoningTokens: row.reasoningTokens }),
    ...(row.estimatedCostUsd === null ? {} : { estimatedCostUsd: row.estimatedCostUsd }),
    createdAt: row.createdAt,
  };
}

function emptySummary(): UsageSummary {
  return {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 0,
  };
}
