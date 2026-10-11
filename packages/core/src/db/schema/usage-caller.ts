import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const usageCaller = sqliteTable('usage_caller', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  kind: text('kind').notNull(),
});
export const usageCallerCredential = sqliteTable('usage_caller_credential', {
  fingerprint: text('fingerprint').primaryKey(),
  callerId: text('caller_id').notNull(),
});
export const usageIdentitySecret = sqliteTable('usage_identity_secret', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
});
