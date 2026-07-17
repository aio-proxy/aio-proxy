import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestLogStore, openDb, requestLog, usage } from "@aio-proxy/core/db";
import { DashboardUsageOverviewResponseSchema, ProviderKind } from "@aio-proxy/types";
import { eq } from "drizzle-orm";

export { createRequestLogStore, DashboardUsageOverviewResponseSchema, eq, openDb, requestLog, usage };

const homes: string[] = [];
export const now = new Date("2026-07-11T08:00:00.000Z");

export const rows = [
  {
    requestId: "request-success-a",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "success",
    finalProviderId: "openrouter",
    finalModelId: "openai/gpt-5",
    finalStatusCode: 200,
    attempts: [
      {
        index: 0,
        providerId: "primary",
        modelId: "gpt-5",
        providerKind: ProviderKind.Api,
        protocol: "openai-compatible",
        outcome: "failure",
        statusCode: 429,
        durationMs: 20,
      },
      {
        index: 1,
        providerId: "openrouter",
        modelId: "openai/gpt-5",
        providerKind: ProviderKind.Api,
        protocol: "openai-compatible",
        outcome: "success",
        statusCode: 200,
        durationMs: 80,
      },
    ],
    startedAt: new Date("2026-07-11T07:00:00.000Z"),
    completedAt: new Date("2026-07-11T07:00:00.100Z"),
    durationMs: 100,
  },
  {
    requestId: "request-failure",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "failure",
    attempts: [],
    startedAt: new Date("2026-07-11T07:30:00.000Z"),
    completedAt: new Date("2026-07-11T07:30:00.050Z"),
    durationMs: 50,
  },
  {
    requestId: "request-cancelled",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "cancelled",
    attempts: [],
    startedAt: new Date("2026-07-11T07:45:00.000Z"),
    completedAt: new Date("2026-07-11T07:45:00.010Z"),
    durationMs: 10,
  },
] as const;

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

export function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-request-log-"));
  homes.push(home);
  return home;
}

export function seedBase() {
  const handle = openDb({ home: tempHome() });
  const store = createRequestLogStore(handle.db);
  store.insertFinal({
    ...rows[0],
    usage: {
      providerId: "openrouter",
      modelId: "openai/gpt-5",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 70,
      reasoningTokens: 30,
      priceModelId: "openai/gpt-5",
      estimatedCostUsd: 0.25,
    },
  });
  store.insertFinal(rows[1]);
  store.insertFinal(rows[2]);
  return { handle, store };
}
