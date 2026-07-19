import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { fetchJson } from "../../src/utils";

describe("fetchJson", () => {
  test("parses JSON with the provided schema", async () => {
    const result = await withFetchMock(
      async () => Response.json({ id: 1 }),
      async () => {
        return await fetchJson("https://example.test", undefined, z.object({ id: z.number() }));
      },
    );

    expect(result).toEqual({ id: 1 });
  });

  test("throws on non-2xx responses", async () => {
    await expect(
      withFetchMock(
        async () => Response.json({ error: "nope" }, { status: 500 }),
        async () => {
          return await fetchJson("https://example.test", undefined, z.unknown());
        },
      ),
    ).rejects.toThrow("Fetch JSON request failed: 500");
  });
});

async function withFetchMock<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
