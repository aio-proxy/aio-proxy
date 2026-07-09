import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageLedger, openDb } from "@aio-proxy/core/db";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-usage-"));
  homes.push(home);
  return home;
}

describe("usage ledger", () => {
  test("stores rows and computes summaries", () => {
    const handle = openDb({ home: tempHome() });
    try {
      const ledger = createUsageLedger(handle.db);
      ledger.insert({
        id: "usage-1",
        traceId: "trace-1",
        providerId: "openrouter",
        modelId: "gpt-5.5",
        priceModelId: "openai/gpt-5.5",
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 20,
        estimatedCostUsd: 0.001,
        createdAt: new Date(0),
      });

      expect(ledger.list(10)).toHaveLength(1);
      expect(ledger.summary(10)).toEqual({
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 20,
        estimatedCostUsd: 0.001,
      });
    } finally {
      handle.close();
    }
  });
});
