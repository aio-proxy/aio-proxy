import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const usage = sqliteTable("usage", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull().unique(),
  providerId: text("provider_id").notNull(),
  modelId: text("model_id").notNull(),
  priceModelId: text("price_model_id"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  totalTokens: integer("total_tokens"),
  cacheReadTokens: integer("cache_read_tokens"),
  cacheWriteTokens: integer("cache_write_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  estimatedCostUsd: real("estimated_cost_usd"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
