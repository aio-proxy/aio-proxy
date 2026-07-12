import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestLogStore, openDb, requestLog, usage } from "@aio-proxy/core/db";
import { DashboardUsageOverviewResponseSchema, ProviderKind } from "@aio-proxy/types";
import { eq } from "drizzle-orm";

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
  test("returns a schema-valid zero summary for an empty database", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const overview = createRequestLogStore(handle.db).overview({
        range: "24h",
        metric: "requests",
        groupBy: "model",
        now,
      });

      expect(overview.summary).toEqual({
        estimatedCostUsd: 0,
        pricingCoverage: null,
        pricedRequestCount: 0,
        usageRequestCount: 0,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        cancelledCount: 0,
        successRate: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        averageRpm: 0,
        averageTpm: 0,
      });
      expect(DashboardUsageOverviewResponseSchema.parse(overview)).toEqual(overview);
    } finally {
      handle.close();
    }
  });

  test("migrates duplicate legacy trace IDs deterministically before enforcing uniqueness", () => {
    const home = tempHome();
    const sqlite = new Database(join(home, "aio-proxy.db"));
    sqlite.exec(`
      CREATE TABLE usage (
        id text PRIMARY KEY NOT NULL,
        trace_id text NOT NULL,
        provider_id text NOT NULL,
        model_id text NOT NULL,
        price_model_id text,
        input_tokens integer,
        output_tokens integer,
        total_tokens integer,
        cache_read_tokens integer,
        cache_write_tokens integer,
        reasoning_tokens integer,
        estimated_cost_usd real,
        created_at integer NOT NULL
      );
      INSERT INTO usage (id, trace_id, provider_id, model_id, created_at) VALUES
        ('older', 'duplicate-by-time', 'older-provider', 'older-model', 1000),
        ('newer', 'duplicate-by-time', 'newer-provider', 'newer-model', 2000),
        ('earlier-rowid', 'duplicate-by-rowid', 'earlier-provider', 'earlier-model', 3000),
        ('later-rowid', 'duplicate-by-rowid', 'later-provider', 'later-model', 3000);
      PRAGMA user_version = 2;
    `);
    sqlite.close();

    const handle = openDb({ home });
    try {
      expect(handle.sqlite.query("SELECT request_id, id FROM usage ORDER BY request_id").all()).toEqual([
        { request_id: "duplicate-by-rowid", id: "later-rowid" },
        { request_id: "duplicate-by-time", id: "newer" },
      ]);
      expect(handle.sqlite.query("SELECT request_id FROM request_log ORDER BY request_id").all()).toEqual([
        { request_id: "duplicate-by-rowid" },
        { request_id: "duplicate-by-time" },
      ]);
      expect(
        handle.sqlite
          .query("SELECT name, [unique] FROM pragma_index_list('usage') WHERE name = 'usage_request_id_unique'")
          .get(),
      ).toEqual({ name: "usage_request_id_unique", unique: 1 });
    } finally {
      handle.close();
    }
  });

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
      expect(overview.buckets[0]).toEqual({
        key: "2026-07-10T08:00:00.000Z",
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
      expect(
        handle.db.select().from(requestLog).where(eq(requestLog.requestId, rows[0].requestId)).get()?.attempts,
      ).toEqual(rows[0].attempts);
    } finally {
      handle.close();
    }
  });

  test("rejects usage for non-success outcomes without persisting either row", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      expect(() =>
        store.insertFinal({
          ...rows[1],
          usage: { providerId: "provider", modelId: "model" },
        }),
      ).toThrow("Only successful requests can include usage");
      expect(handle.sqlite.query("SELECT COUNT(*) AS count FROM request_log").get()).toEqual({ count: 0 });
      expect(handle.sqlite.query("SELECT COUNT(*) AS count FROM usage").get()).toEqual({ count: 0 });
    } finally {
      handle.close();
    }
  });

  test("rejects successful usage whose provider or model differs from the terminal route", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      expect(() =>
        store.insertFinal({
          ...rows[0],
          usage: { providerId: "different-provider", modelId: rows[0].finalModelId },
        }),
      ).toThrow("Usage provider and model must match the final route");
      expect(() =>
        store.insertFinal({
          ...rows[0],
          usage: { providerId: rows[0].finalProviderId, modelId: "different-model" },
        }),
      ).toThrow("Usage provider and model must match the final route");
      expect(handle.sqlite.query("SELECT COUNT(*) AS count FROM request_log").get()).toEqual({ count: 0 });
      expect(handle.sqlite.query("SELECT COUNT(*) AS count FROM usage").get()).toEqual({ count: 0 });
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

  test("keeps reserved and path-like model ids separate with chart-safe keys", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      for (const [index, modelId] of ["__failed__", "__cancelled__", "__other__", "gpt-4.1"].entries()) {
        store.insertFinal({
          requestId: `reserved-model-${index}`,
          inboundProtocol: "openai-compatible",
          requestedModelId: modelId,
          outcome: "success",
          finalProviderId: "provider",
          finalModelId: modelId,
          attempts: [],
          startedAt: new Date(now.getTime() - 1_000),
          completedAt: now,
          durationMs: 1_000,
        });
      }
      store.insertFinal({ ...rows[1], requestId: "reserved-failure" });
      store.insertFinal({ ...rows[2], requestId: "reserved-cancelled" });

      const overview = store.overview({ range: "24h", metric: "requests", groupBy: "model", now });

      expect(overview.series).toEqual([
        { key: "dimension:__cancelled__", kind: "dimension" },
        { key: "dimension:__failed__", kind: "dimension" },
        { key: "dimension:__other__", kind: "dimension" },
        { key: "dimension:gpt-4%2E1", kind: "dimension" },
        { key: "__failed__", kind: "failed" },
        { key: "__cancelled__", kind: "cancelled" },
      ]);
      expect(overview.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(6);
    } finally {
      handle.close();
    }
  });

  test("uses server-local calendar days and actual elapsed minutes for multi-day ranges", () => {
    const { handle, store } = seedBase();
    try {
      const expectedStart = new Date(now);
      expectedStart.setHours(0, 0, 0, 0);
      expectedStart.setDate(expectedStart.getDate() - 6);
      const expectedBucketKeys = Array.from({ length: 7 }, (_, index) => {
        const day = new Date(expectedStart);
        day.setDate(day.getDate() + index);
        return day.toISOString();
      });
      const elapsedMinutes = (now.getTime() - expectedStart.getTime()) / 60_000;
      const overview = store.overview({ range: "7d", metric: "requests", groupBy: "provider", now });
      expect(overview.rangeStart).toBe(expectedStart.toISOString());
      expect(overview.rangeEnd).toBe(now.toISOString());
      expect(overview.bucketUnit).toBe("day");
      expect(overview.buckets).toHaveLength(7);
      expect(overview.buckets.map(({ key }) => key)).toEqual(expectedBucketKeys);
      expect(overview.summary.averageRpm).toBe(3 / elapsedMinutes);
      expect(overview.summary.averageTpm).toBe(150 / elapsedMinutes);
    } finally {
      handle.close();
    }
  });

  test("anchors rolling hourly buckets at a non-hour range start without losing boundary rows", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      const rollingNow = new Date("2026-07-11T08:30:00.000Z");
      const rollingStart = new Date("2026-07-10T08:30:00.000Z");
      store.insertFinal({
        requestId: "rolling-early",
        inboundProtocol: "openai-compatible",
        requestedModelId: "mini",
        outcome: "failure",
        attempts: [],
        startedAt: new Date(rollingStart.getTime() + 14 * 60_000),
        completedAt: new Date(rollingStart.getTime() + 15 * 60_000),
        durationMs: 60_000,
      });
      store.insertFinal({
        requestId: "rolling-end",
        inboundProtocol: "openai-compatible",
        requestedModelId: "mini",
        outcome: "success",
        finalProviderId: "openrouter",
        finalModelId: "openai/gpt-5",
        attempts: [],
        startedAt: new Date(rollingNow.getTime() - 1_000),
        completedAt: rollingNow,
        durationMs: 1_000,
        usage: {
          providerId: "openrouter",
          modelId: "openai/gpt-5",
          inputTokens: 10,
          outputTokens: 5,
        },
      });

      const requests = store.overview({ range: "24h", metric: "requests", groupBy: "model", now: rollingNow });
      const tokens = store.overview({ range: "24h", metric: "tokens", groupBy: "model", now: rollingNow });
      expect(requests.buckets).toHaveLength(24);
      expect(requests.buckets[0]?.key).toBe("2026-07-10T08:30:00.000Z");
      expect(requests.buckets.at(-1)?.key).toBe("2026-07-11T07:30:00.000Z");
      expect(requests.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(
        requests.summary.requestCount,
      );
      expect(tokens.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(
        tokens.summary.totalTokens,
      );
    } finally {
      handle.close();
    }
  });

  test("keeps rolling hourly buckets unique across a DST rollback", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      const rollbackNow = new Date("2026-11-01T17:30:00.000Z");
      for (const [requestId, completedAt] of [
        ["rollback-edt", new Date("2026-11-01T05:45:00.000Z")],
        ["rollback-est", new Date("2026-11-01T06:45:00.000Z")],
      ] as const) {
        store.insertFinal({
          requestId,
          inboundProtocol: "openai-compatible",
          requestedModelId: "mini",
          outcome: "success",
          finalProviderId: "openrouter",
          finalModelId: "openai/gpt-5",
          attempts: [],
          startedAt: new Date(completedAt.getTime() - 1_000),
          completedAt,
          durationMs: 1_000,
          usage: {
            providerId: "openrouter",
            modelId: "openai/gpt-5",
            inputTokens: 10,
            outputTokens: 5,
          },
        });
      }

      const requests = store.overview({ range: "24h", metric: "requests", groupBy: "model", now: rollbackNow });
      const tokens = store.overview({ range: "24h", metric: "tokens", groupBy: "model", now: rollbackNow });
      const expectedKeys = Array.from({ length: 24 }, (_, index) =>
        new Date(rollbackNow.getTime() - (24 - index) * 60 * 60 * 1_000).toISOString(),
      );
      const requestChartTotal = requests.buckets
        .flatMap(({ values }) => Object.values(values))
        .reduce((a, b) => a + b, 0);
      const tokenChartTotal = tokens.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0);

      expect({
        uniqueKeyCount: new Set(requests.buckets.map(({ key }) => key)).size,
        requestChartTotal,
        tokenChartTotal,
      }).toEqual({
        uniqueKeyCount: 24,
        requestChartTotal: requests.summary.requestCount,
        tokenChartTotal: tokens.summary.totalTokens,
      });
      expect(requests.buckets.map(({ key }) => key)).toEqual(expectedKeys);
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

  test("lists terminal requests newest first with deterministic pagination and joined usage", () => {
    const { handle, store } = seedBase();
    try {
      store.insertFinal({
        requestId: "request-same-time-z",
        inboundProtocol: "anthropic",
        requestedModelId: "sonnet",
        outcome: "failure",
        finalProviderId: "backup",
        finalModelId: "claude-sonnet",
        finalStatusCode: 503,
        errorCode: "upstream_unavailable",
        attempts: [],
        startedAt: new Date("2026-07-11T07:44:59.000Z"),
        completedAt: rows[2].completedAt,
        durationMs: 1_010,
      });

      const firstPage = store.list({
        page: 1,
        pageSize: 2,
        startedAfter: new Date("2026-07-11T06:00:00.000Z"),
        completedBefore: new Date("2026-07-11T08:00:00.000Z"),
      });
      expect(firstPage).toMatchObject({ page: 1, pageSize: 2, total: 4, pageCount: 2 });
      expect(firstPage.items.map((item) => item.requestId)).toEqual(["request-same-time-z", "request-cancelled"]);
      expect(firstPage.items[0]?.usage).toBeUndefined();

      const success = store.list({ page: 1, pageSize: 10, requestId: "request-success-a" });
      expect(success.items[0]).toMatchObject({
        requestId: "request-success-a",
        completedAt: "2026-07-11T07:00:00.100Z",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.25 },
      });
    } finally {
      handle.close();
    }
  });

  test("filters terminal request columns and returns empty out-of-range pages", () => {
    const { handle, store } = seedBase();
    try {
      const cases = [
        [{ outcome: "success" as const }, "request-success-a"],
        [{ inboundProtocol: "openai-compatible" }, "request-cancelled"],
        [{ requestedModelId: "mini", outcome: "failure" as const }, "request-failure"],
        [{ finalProviderId: "openrouter" }, "request-success-a"],
        [{ finalModelId: "openai/gpt-5" }, "request-success-a"],
        [{ finalStatusCode: 200 }, "request-success-a"],
      ] as const;

      for (const [filter, expectedFirst] of cases) {
        expect(store.list({ page: 1, pageSize: 10, ...filter }).items[0]?.requestId).toBe(expectedFirst);
      }

      expect(store.list({ page: 99, pageSize: 10 })).toEqual({
        items: [],
        page: 99,
        pageSize: 10,
        total: 3,
        pageCount: 1,
      });
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
