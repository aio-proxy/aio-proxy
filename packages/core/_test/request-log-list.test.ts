import { describe, expect, test } from "bun:test";

import { createRequestLogStore, now, openDb, rows, seedBase, tempHome } from "./request-log.test-support";

describe("request log store", () => {
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
