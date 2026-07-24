import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionResponse = sqliteTable(
  "session_response",
  {
    responseIdSha256: text("response_id_sha256").primaryKey(),
    sessionSource: text("session_source").notNull(),
    sessionId: text("session_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("session_response_expires_idx").on(table.expiresAt)],
);
