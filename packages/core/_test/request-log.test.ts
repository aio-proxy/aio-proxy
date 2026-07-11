import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestLogStore, openDb, usage } from "@aio-proxy/core/db";
import { ProviderKind } from "@aio-proxy/types";

const homes: string[] = [];
const now = new Date("2026-07-11T08:00:00.000Z");

const rows = [
  {
    requestId: "request-success-a",
    inboundProtocol: "openai-compatible",
    requestedModelId: "mini",
    outcome: "success",
    finalProviderId: "openrouter",
    finalModelId: "openai/gpt-5",
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

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-request-log-"));
  homes.push(home);
  return home;
}

function seedBase() {
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

describe("request log store", () => {
  test("stores terminal requests with optional successful usage and aggregates the summary", () => {
    const { handle, store } = seedBase();
    try {
      const overview = store.overview({ range: "24h", metric: "requests", groupBy: "model", now });

      expect(overview.summary).toEqual({
        estimatedCostUsd: 0.25,
        pricingCoverage: 1,
        pricedRequestCount: 1,
        usageRequestCount: 1,
        requestCount: 3,
        successCount: 1,
        failureCount: 1,
        cancelledCount: 1,
        successRate: 0.5,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        averageRpm: 3 / 1440,
        averageTpm: 150 / 1440,
      });
      expect(overview.buckets).toHaveLength(24);
      expect(overview.series.map(({ key }) => key)).toEqual(["openai/gpt-5", "__failed__", "__cancelled__"]);
      expect(overview.series.map(({ kind }) => kind)).toEqual(["dimension", "failed", "cancelled"]);
      expect(overview.buckets.at(-1)).toEqual({
        key: "2026-07-11 16:00",
        values: { "openai/gpt-5": 0, __failed__: 0, __cancelled__: 0 },
      });

      const storedUsage = handle.db.select().from(usage).all();
      expect(storedUsage).toHaveLength(1);
      expect(storedUsage[0]).toMatchObject({
        requestId: "request-success-a",
        providerId: "openrouter",
        modelId: "openai/gpt-5",
        createdAt: rows[0].completedAt,
      });
    } finally {
      handle.close();
    }
  });

  test("keeps the request and usage insert atomic and enforces one terminal row per request", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      handle.db
        .insert(usage)
        .values({
          id: "existing-usage",
          requestId: "atomic-request",
          providerId: "provider",
          modelId: "model",
          createdAt: now,
        })
        .run();

      expect(() =>
        store.insertFinal({
          requestId: "atomic-request",
          inboundProtocol: "openai-compatible",
          requestedModelId: "model",
          outcome: "success",
          finalProviderId: "provider",
          finalModelId: "model",
          attempts: [],
          startedAt: now,
          completedAt: now,
          durationMs: 0,
          usage: { providerId: "provider", modelId: "model" },
        }),
      ).toThrow();
      expect(handle.sqlite.query("SELECT COUNT(*) AS count FROM request_log").get()).toEqual({ count: 0 });

      store.insertFinal(rows[1]);
      expect(() => store.insertFinal(rows[1])).toThrow();
    } finally {
      handle.close();
    }
  });

  test("token and cost charts only include successful requests with usage and omit cache and reasoning from TPM", () => {
    const { handle, store } = seedBase();
    try {
      const tokens = store.overview({ range: "24h", metric: "tokens", groupBy: "model", now });
      const cost = store.overview({ range: "24h", metric: "cost", groupBy: "model", now });

      expect(tokens.series).toEqual([{ key: "openai/gpt-5", kind: "dimension" }]);
      expect(tokens.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(150);
      expect(cost.series).toEqual([{ key: "openai/gpt-5", kind: "dimension" }]);
      expect(cost.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(0.25);
      expect(tokens.summary.averageTpm).toBe(150 / 1440);
    } finally {
      handle.close();
    }
  });

  test("uses server-local calendar days and actual elapsed minutes for multi-day ranges", () => {
    const { handle, store } = seedBase();
    try {
      const overview = store.overview({ range: "7d", metric: "requests", groupBy: "provider", now });
      expect(overview.rangeStart).toBe("2026-07-04T16:00:00.000Z");
      expect(overview.rangeEnd).toBe(now.toISOString());
      expect(overview.bucketUnit).toBe("day");
      expect(overview.buckets.map(({ key }) => key)).toEqual([
        "2026-07-05",
        "2026-07-06",
        "2026-07-07",
        "2026-07-08",
        "2026-07-09",
        "2026-07-10",
        "2026-07-11",
      ]);
      expect(overview.summary.averageRpm).toBe(3 / 9600);
      expect(overview.summary.averageTpm).toBe(150 / 9600);
    } finally {
      handle.close();
    }
  });

  test("keeps the top five dimensions and folds remaining successful models into Other", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      for (let index = 0; index < 6; index += 1) {
        store.insertFinal({
          requestId: `top-${index}`,
          inboundProtocol: "openai-compatible",
          requestedModelId: `alias-${index}`,
          outcome: "success",
          finalProviderId: `provider-${index}`,
          finalModelId: `model-${index}`,
          attempts: [],
          startedAt: new Date(now.getTime() - 60_000),
          completedAt: new Date(now.getTime() - 1_000),
          durationMs: 59_000,
          usage: {
            providerId: `provider-${index}`,
            modelId: `model-${index}`,
            inputTokens: 6 - index,
            outputTokens: 0,
            totalTokens: 6 - index,
          },
        });
      }

      const overview = store.overview({ range: "24h", metric: "tokens", groupBy: "model", now });
      expect(overview.series).toEqual([
        { key: "model-0", kind: "dimension" },
        { key: "model-1", kind: "dimension" },
        { key: "model-2", kind: "dimension" },
        { key: "model-3", kind: "dimension" },
        { key: "model-4", kind: "dimension" },
        { key: "__other__", kind: "other" },
      ]);
      expect(overview.buckets.flatMap(({ values }) => [values.__other__]).reduce((a, b) => a + b, 0)).toBe(1);
    } finally {
      handle.close();
    }
  });

  test("prunes usage before terminal requests older than the cutoff", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      const old = new Date(now.getTime() - 46 * 24 * 60 * 60 * 1000);
      const retained = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
      for (const [requestId, completedAt] of [
        ["old", old],
        ["retained", retained],
      ] as const) {
        store.insertFinal({
          requestId,
          inboundProtocol: "openai-compatible",
          requestedModelId: "model",
          outcome: "success",
          finalProviderId: "provider",
          finalModelId: "model",
          attempts: [],
          startedAt: completedAt,
          completedAt,
          durationMs: 0,
          usage: { providerId: "provider", modelId: "model" },
        });
      }

      store.prune(retained);
      expect(handle.sqlite.query("SELECT request_id FROM request_log ORDER BY request_id").all()).toEqual([
        { request_id: "retained" },
      ]);
      expect(handle.sqlite.query("SELECT request_id FROM usage ORDER BY request_id").all()).toEqual([
        { request_id: "retained" },
      ]);
    } finally {
      handle.close();
    }
  });
});
