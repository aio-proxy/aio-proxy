import { createRequestLogStore, openDb } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { DashboardUsageOverviewResponseSchema } from "@aio-proxy/types";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loopbackServer } from "../src/dashboard-auth/test-support";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-usage-dashboard-"));
  homes.push(home);
  return home;
}

async function seededApp() {
  const home = tempHome();
  const app = await createServer({ config: { providers: {} }, dbHome: home });
  const handle = openDb({ home });
  const store = createRequestLogStore(handle.db);
  const completedAt = new Date();

  store.insertFinal({
    requestId: "request-success",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "success",
    finalProviderId: "openrouter",
    finalModelId: "openai/gpt-5",
    attempts: [],
    startedAt: new Date(completedAt.getTime() - 100),
    completedAt,
    durationMs: 100,
    usage: {
      providerId: "openrouter",
      modelId: "openai/gpt-5",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      estimatedCostUsd: 0.25,
    },
  });
  store.insertFinal({
    requestId: "request-failure",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "failure",
    attempts: [],
    startedAt: new Date(completedAt.getTime() - 50),
    completedAt,
    durationMs: 50,
  });
  store.insertFinal({
    requestId: "request-cancelled",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "cancelled",
    attempts: [],
    startedAt: new Date(completedAt.getTime() - 10),
    completedAt,
    durationMs: 10,
  });
  handle.close();

  return app;
}

describe("GET /dashboard/api/usage", () => {
  test("returns the requested overview with pinned provider series", async () => {
    const response = await (
      await seededApp()
    ).request("/dashboard/api/usage?range=24h&metric=requests&groupBy=provider", undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(DashboardUsageOverviewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      range: "24h",
      metric: "requests",
      groupBy: "provider",
      rangeStart: expect.any(String),
      rangeEnd: expect.any(String),
      bucketUnit: "hour",
      summary: expect.objectContaining({
        requestCount: 3,
        successCount: 1,
        failureCount: 1,
        cancelledCount: 1,
        successRate: 0.5,
      }),
      series: [
        { key: "openrouter", kind: "dimension" },
        { key: "__failed__", kind: "failed" },
        { key: "__cancelled__", kind: "cancelled" },
      ],
      buckets: expect.any(Array),
    });
  });

  test("uses the default range, metric, and grouping", async () => {
    const response = await (await seededApp()).request("/dashboard/api/usage", undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ range: "24h", metric: "cost", groupBy: "model" });
  });

  test.each(["range=1h", "metric=latency", "groupBy=protocol"])("rejects invalid query %s", async (query) => {
    const response = await (await seededApp()).request(`/dashboard/api/usage?${query}`, undefined, loopbackServer);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "validation failed", details: expect.any(Array) });
  });
});
