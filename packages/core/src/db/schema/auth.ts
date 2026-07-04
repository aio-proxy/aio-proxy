import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auth = sqliteTable(
  "auth",
  {
    vendor: text("vendor").notNull(),
    providerId: text("provider_id").notNull(),
    accountFingerprint: text("account_fingerprint"),
    payload: text("payload").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.vendor, table.providerId] })],
);
