import { afterEach, describe, expect, test } from "bun:test";
import { AiSdkProviderError, type AiSdkProviderInstance, createAiSdkProvider } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import type { TextStreamPart, ToolSet } from "ai";

import {
  AbortStreamError,
  createTempHomes,
  messagesRequest,
  recorded,
  textStream,
} from "./anthropic-messages.test-support";

const homes = createTempHomes("aio-proxy-anthropic-usage-");
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe("POST /v1/messages", () => {
  test("Given stream emits data then errors When message streams Then request is failure", async () => {
    const provider = {
      id: "broken-after-data",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            controller.error(new Error("stream broke"));
          },
        }),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text().catch(() => undefined);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: "failure", attempts: [expect.objectContaining({ outcome: "failure" })] }),
      ],
      usages: [],
    });
  });

  test.each([
    false,
    true,
  ])("Given an aborted inbound signal and wrapped AbortError When Anthropic stream is %s Then request is cancelled", async (stream) => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () => {
        let sent = false;
        return new ReadableStream<TextStreamPart<ToolSet>>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            } else {
              controller.error(new AiSdkProviderError("mock-ai", new AbortStreamError("client closed request")));
            }
          },
        });
      },
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
    const abort = new AbortController();
    abort.abort();

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, stream }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: abort.signal,
    });
    await response.text().catch(() => undefined);

    expect(response.status).toBe(stream ? 200 : 499);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "cancelled",
          attempts: [expect.objectContaining({ outcome: "cancelled" })],
        }),
      ],
      usages: [],
    });
  });

  test.each([
    "provider rejected",
    null,
    { message: "provider rejected" },
  ])("Given final provider rejects %p When non-stream message is posted Then one failed request is recorded", async (reason) => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () => new ReadableStream({ pull: (controller) => controller.error(reason) }),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          finalProviderId: "mock-ai",
          outcome: "failure",
          attempts: [expect.objectContaining({ index: 0, providerId: "mock-ai", outcome: "failure" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given no matching alias When message is posted Then returns 404 Anthropic error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, model: "missing-model" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Model not found: missing-model",
      },
    });
    expect(invoked).toBe(false);
  });

  test.each([
    { thinking: { type: "enabled", budget_tokens: 1023 }, max_tokens: 8192 },
    { thinking: { type: "enabled", budget_tokens: 8192 }, max_tokens: 8192 },
    { thinking: { type: "adaptive" }, max_tokens: 8192 },
    { thinking: { type: "disabled" }, output_config: { effort: "high" }, max_tokens: 8192 },
  ])("Given invalid thinking %# When message is posted Then it fails before a provider attempt", async (invalid) => {
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, ...invalid }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Invalid Anthropic Messages request" },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider package is missing When stream message is posted Then Anthropic error is actionable 503 before SSE", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["claude-sonnet-4-5"],
        alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("run aio-proxy provider install @vendor/missing-provider");
  });
});

describe("POST /v1/messages/count_tokens", () => {});
