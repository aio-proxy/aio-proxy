import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    localDay: text('local_day').notNull(),
    modelDimension: text('model_dimension').notNull(),
    requestCount: integer('request_count').notNull().default(0),
    successCount: integer('success_count').notNull().default(0),
    errorCount: integer('error_count').notNull().default(0),
    cancelledCount: integer('cancelled_count').notNull().default(0),
    interruptedCount: integer('interrupted_count').notNull().default(0),
    usageRequestCount: integer('usage_request_count').notNull().default(0),
    pricedRequestCount: integer('priced_request_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    estimatedCostNanoUsd: integer('estimated_cost_nano_usd').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.localDay, table.modelDimension] })],
);
