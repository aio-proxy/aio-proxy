import { primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const usageDaily = sqliteTable(
  'usage_daily',
  {
    localDay: text('local_day').notNull(),
    modelDimension: text('model_dimension').notNull(),
    requestCount: text('request_count').notNull().default('0'),
    successCount: text('success_count').notNull().default('0'),
    errorCount: text('error_count').notNull().default('0'),
    cancelledCount: text('cancelled_count').notNull().default('0'),
    interruptedCount: text('interrupted_count').notNull().default('0'),
    usageRequestCount: text('usage_request_count').notNull().default('0'),
    pricedRequestCount: text('priced_request_count').notNull().default('0'),
    inputTokens: text('input_tokens').notNull().default('0'),
    outputTokens: text('output_tokens').notNull().default('0'),
    totalTokens: text('total_tokens').notNull().default('0'),
    cacheReadTokens: text('cache_read_tokens').notNull().default('0'),
    cacheWriteTokens: text('cache_write_tokens').notNull().default('0'),
    reasoningTokens: text('reasoning_tokens').notNull().default('0'),
    estimatedCostNanoUsd: text('estimated_cost_nano_usd').notNull().default('0'),
    // Cache accounting normalized at write time by the successful attempt's transport/protocol,
    // because those live on a child span and cannot become rollup dimensions.
    normalizedCacheReadTokens: text('normalized_cache_read_tokens').notNull().default('0'),
    normalizedPromptTokens: text('normalized_prompt_tokens').notNull().default('0'),
  },
  (table) => [primaryKey({ columns: [table.localDay, table.modelDimension] })],
);
