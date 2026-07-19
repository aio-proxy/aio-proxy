import { createRequestLogStore, openDb, requestLog, usage } from "@aio-proxy/core/db";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRequestRecorder } from "../request-recorder";
import { createUsageCapture } from "./index";
import { settle } from "./test-support";

const homes: string[] = [];
const fixedNow = new Date("2026-07-11T08:00:00.000Z");

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-usage-capture-"));
  homes.push(home);
  return home;
}

describe("usage capture passthrough lifecycle", () => {
  test("oversized JSON passthrough stays byte-identical and skips usage observation", async () => {
    const body = JSON.stringify({
      padding: "x".repeat(2 * 1024 * 1024),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(body, { headers: { "content-type": "application/json" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: "success", statusCode: 200 });
  });

  test("oversized SSE event disables observation without interrupting passthrough", async () => {
    const body =
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
      `data: ${"x".repeat(2 * 1024 * 1024)}\n\n`;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: "success", statusCode: 200 });
  });

  test("SSE observation handles UTF-8 and CRLF split across chunks", async () => {
    const body = 'data:{"content":"🙂","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\n';
    const bytes = new TextEncoder().encode(body);
    const emojiStart = bytes.indexOf(0xf0);
    const carriageReturn = bytes.indexOf(0x0d);
    const chunks = [
      bytes.slice(0, emojiStart + 2),
      bytes.slice(emojiStart + 2, carriageReturn + 1),
      bytes.slice(carriageReturn + 1),
    ];
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    });
  });

  test("passthrough consumer cancellation forwards the reason and completes as cancelled", async () => {
    const firstChunk = new TextEncoder().encode("first");
    const cleanupError = new Error("test cleanup");
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelledReason: unknown;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            sourceController = controller;
            controller.enqueue(firstChunk);
          },
          cancel(reason) {
            cancelledReason = reason;
          },
        }),
        { headers: { "x-upstream": "yes" }, status: 200, statusText: "Good" },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });
    const body = captured.value.body;
    if (body === null) {
      throw new Error("expected passthrough response body");
    }
    const reader = body.getReader();
    const reason = new Error("consumer stopped");

    expect(captured.value.status).toBe(200);
    expect(captured.value.statusText).toBe("Good");
    expect(captured.value.headers.get("x-upstream")).toBe("yes");
    expect(await reader.read()).toEqual({ done: false, value: firstChunk });
    const cancellation = reader.cancel(reason);
    await Promise.resolve();
    if (cancelledReason === undefined) {
      sourceController.error(cleanupError);
    }
    await cancellation.catch(() => undefined);

    expect(cancelledReason).toBe(reason);
    await expect(captured.completion).resolves.toEqual({ outcome: "cancelled", statusCode: 200 });
  });

  test("passthrough body errors remain visible and complete as failure", async () => {
    const expected = new Error("upstream body broke");
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(expected);
          },
        }),
        { status: 200 },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    await expect(captured.value.text()).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: "failure", statusCode: 200 });
  });

  test("non-success passthrough completes immediately as failure without consuming the body", async () => {
    const response = new Response("rate limited", { status: 429 });
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response,
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(captured.value).toBe(response);
    expect(await captured.value.text()).toBe("rate limited");
    await expect(captured.completion).resolves.toEqual({ outcome: "failure", statusCode: 429 });
  });

  test("empty or unparseable passthrough usage does not create a usage row", async () => {
    for (const body of [JSON.stringify({ usage: {} }), "data: {not-json}\n\n"]) {
      const handle = openDb({ home: tempHome() });
      const recorder = createRequestRecorder({ store: createRequestLogStore(handle.db), now: () => fixedNow });
      const session = recorder.begin({ inboundProtocol: "openai-compatible", requestedModelId: "mini" });
      const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
        response: new Response(body),
        protocol: ProviderProtocol.OpenAICompatible,
        providerId: "provider",
        modelId: "model",
      });
      session.finishFrom(
        {
          providerId: "provider",
          modelId: "model",
          providerKind: ProviderKind.Api,
          protocol: ProviderProtocol.OpenAICompatible,
          durationMs: 1,
        },
        captured.completion,
      );

      await captured.value.text();
      await captured.completion;
      await settle();

      expect(handle.db.select().from(requestLog).all()).toHaveLength(1);
      expect(handle.db.select().from(usage).all()).toEqual([]);
      handle.close();
    }
  });
});
