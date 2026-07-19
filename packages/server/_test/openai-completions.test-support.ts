import type { createServer } from "@aio-proxy/server";
import type { TextStreamPart, ToolSet } from "ai";

import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import { expect } from "bun:test";

export { createTempHomes } from "./temporary-homes.test-support";

export const chatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};
const nativeFetch = globalThis.fetch;

export function mockModelsDevCatalog(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "https://models.dev/api.json"
      ? Promise.resolve(Response.json({ openrouter: { models: {} } }))
      : nativeFetch(input, init)) as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = nativeFetch;
}

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export function errorStream(
  error: unknown,
  beforeError: readonly TextStreamPart<ToolSet>[] = [],
): ReadableStream<TextStreamPart<ToolSet>> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = beforeError[index++];
      if (part === undefined) controller.error(error);
      else controller.enqueue(part);
    },
  });
}

export class UpstreamStatusError extends Error {
  readonly statusCode = 401;
}

export class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

async function usageJson(app: ReturnType<typeof createServer>): Promise<unknown> {
  const usageResponse = await app.request("/dashboard/api/usage?range=24h&metric=tokens&groupBy=provider");
  expect(usageResponse.status).toBe(200);
  return usageResponse.json();
}

export async function waitForUsageRow(app: ReturnType<typeof createServer>): Promise<unknown> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = await usageJson(app);
    if (
      typeof body === "object" &&
      body !== null &&
      "summary" in body &&
      typeof body.summary === "object" &&
      body.summary !== null &&
      "requestCount" in body.summary &&
      body.summary.requestCount === 1
    ) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return usageJson(app);
}

export async function recorded(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    const requests = handle.db.select().from(requestLog).all();
    const usages = handle.db.select().from(usage).all();
    handle.close();
    if (requests.length > 0) return { requests, usages };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("request row was not recorded");
}
