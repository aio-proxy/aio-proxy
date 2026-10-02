import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const providerModelCatalog = sqliteTable('provider_model_catalog', {
  providerId: text('provider_id').primaryKey(),
  sourceDigest: text('source_digest').notNull(),
  modelsJson: text('models_json'),
  refreshedAt: integer('refreshed_at'),
  failureCode: text('failure_code'),
  failedAt: integer('failed_at'),
});
