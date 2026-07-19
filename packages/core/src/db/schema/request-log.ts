import type { ProviderKind, ProviderProtocol, RequestOutcome } from "@aio-proxy/types";

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export type RequestAttemptLog = {
  readonly index: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  readonly protocol?: ProviderProtocol;
  readonly outcome: "success" | "failure" | "cancelled";
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly durationMs: number;
};

export const requestLog = sqliteTable(
  "request_log",
  {
    requestId: text("request_id").primaryKey(),
    inboundProtocol: text("inbound_protocol").notNull(),
    requestedModelId: text("requested_model_id").notNull(),
    outcome: text("outcome").$type<RequestOutcome>().notNull(),
    finalProviderId: text("final_provider_id"),
    finalModelId: text("final_model_id"),
    finalStatusCode: integer("final_status_code"),
    errorCode: text("error_code"),
    attempts: text("attempts_json", { mode: "json" }).$type<RequestAttemptLog[]>().notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (table) => [
    index("request_log_completed_at_idx").on(table.completedAt),
    index("request_log_outcome_completed_at_idx").on(table.outcome, table.completedAt),
    index("request_log_final_provider_completed_at_idx").on(table.finalProviderId, table.completedAt),
    index("request_log_requested_model_completed_at_idx").on(table.requestedModelId, table.completedAt),
    index("request_log_final_model_completed_at_idx").on(table.finalModelId, table.completedAt),
    index("request_log_protocol_completed_at_idx").on(table.inboundProtocol, table.completedAt),
    index("request_log_status_completed_at_idx").on(table.finalStatusCode, table.completedAt),
  ],
);
