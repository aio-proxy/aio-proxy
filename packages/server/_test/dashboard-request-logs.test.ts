import { createRequestLogStore, openDb } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { DashboardRequestLogsResponseSchema, ProviderKind } from "@aio-proxy/types";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loopbackServer } from "../src/dashboard-auth/test-support";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

async function seededApp() {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-logs-"));
  homes.push(home);
  const app = await createServer({
    config: {
      providers: {
        openrouter: {
          kind: "api",
          name: "OpenRouter",
          protocol: "openai-compatible",
          baseURL: "https://openrouter.example.com",
          models: ["openai/gpt-5"],
        },
      },
    },
    dbHome: home,
    modelsDevCatalogTask: async () => ({
      displayName: () => undefined,
      find: () => undefined,
      metadata: (modelId) =>
        ({
          mini: { displayName: "GPT Mini" },
          "openai/gpt-5": { displayName: "GPT-5" },
        })[modelId],
    }),
  });
  const handle = openDb({ home });
  const store = createRequestLogStore(handle.db);
  const completedAt = new Date("2026-07-12T08:00:00.000Z");
  store.insertFinal({
    requestId: "request-success",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "success",
    finalProviderId: "openrouter",
    finalModelId: "openai/gpt-5",
    finalStatusCode: 200,
    attempts: [
      {
        index: 0,
        providerId: "openrouter",
        modelId: "openai/gpt-5",
        providerKind: ProviderKind.Api,
        protocol: "openai-compatible",
        outcome: "success",
        statusCode: 200,
        durationMs: 100,
      },
    ],
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
    inboundProtocol: "anthropic",
    requestedModelId: "sonnet",
    outcome: "failure",
    finalProviderId: "backup",
    finalModelId: "claude-sonnet",
    finalStatusCode: 503,
    errorCode: "upstream_unavailable",
    attempts: [],
    startedAt: new Date(completedAt.getTime() + 900),
    completedAt: new Date(completedAt.getTime() + 1_000),
    durationMs: 100,
  });
  handle.close();
  return app;
}

describe("GET /dashboard/api/logs", () => {
  test("returns newest terminal requests with usage and attempts", async () => {
    const response = await (await seededApp()).request("/dashboard/api/logs", undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(DashboardRequestLogsResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 2,
      pageCount: 1,
      items: [
        { requestId: "request-failure", outcome: "failure" },
        {
          requestId: "request-success",
          attempts: [{ providerId: "openrouter", statusCode: 200 }],
          usage: { totalTokens: 150, estimatedCostUsd: 0.25 },
        },
      ],
    });
  });

  test("returns current display names while preserving stored ids", async () => {
    const response = await (await seededApp()).request("/dashboard/api/logs", undefined, loopbackServer);
    const body = await response.json();

    expect(body.items).toContainEqual(
      expect.objectContaining({
        requestId: "request-success",
        requestedModelId: "mini",
        requestedModelDisplayName: "GPT Mini",
        finalProviderId: "openrouter",
        finalProviderName: "OpenRouter",
        finalModelId: "openai/gpt-5",
        finalModelDisplayName: "GPT-5",
      }),
    );
  });

  test("applies combined terminal filters", async () => {
    const query = new URLSearchParams({
      page: "1",
      pageSize: "10",
      outcome: "success",
      inboundProtocol: "openai-compatible",
      requestedModelId: "mini",
      finalProviderId: "openrouter",
      finalModelId: "openai/gpt-5",
      finalStatusCode: "200",
      startedAfter: "2026-07-12T07:59:00.000Z",
      completedBefore: "2026-07-12T08:01:00.000Z",
    });
    const response = await (await seededApp()).request(`/dashboard/api/logs?${query}`, undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items.map((item: { requestId: string }) => item.requestId)).toEqual(["request-success"]);
  });

  test.each([
    "page=0",
    "page=1.5",
    "pageSize=25",
    "finalStatusCode=abc",
    "finalStatusCode=99",
    "outcome=unknown",
    "startedAfter=not-a-date",
    "completedBefore=not-a-date",
  ])("rejects invalid query %s", async (query) => {
    const response = await (await seededApp()).request(`/dashboard/api/logs?${query}`, undefined, loopbackServer);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "validation failed", details: expect.any(Array) });
  });
});
