import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "@aio-proxy/server";

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

describe("GET /dashboard/api/usage", () => {
  test("returns an empty usage summary", async () => {
    const app = createServer({ config: { providers: {} }, dbHome: tempHome() });
    const response = await app.request("/dashboard/api/usage");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      summary: {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        estimatedCostUsd: 0,
      },
      rows: [],
    });
  });
});
