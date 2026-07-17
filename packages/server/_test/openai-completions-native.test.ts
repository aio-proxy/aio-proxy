import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AiSdkProviderError, type ApiProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";

import {
  AbortStreamError,
  chatRequest,
  createTempHomes,
  mockModelsDevCatalog,
  recorded,
  restoreFetch,
} from "./openai-completions.test-support";

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);
const homes = createTempHomes("aio-proxy-openai-usage-");
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe("POST /v1/chat/completions", () => {
  test("Given openai-compatible api provider When completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "openai" },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({
      config: { providers: {} },
      dbHome,
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("openai");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toEqual(chatRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.OpenAICompatible,
          requestedModelId: "gpt-4o-mini",
          finalProviderId: "openai",
          finalModelId: "gpt-4o-mini",
          outcome: "success",
          attempts: [expect.objectContaining({ index: 0, providerId: "openai", outcome: "success" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given native response body wraps an inbound AbortError When body fails after headers Then request is cancelled", async () => {
    // Given
    const abort = new AbortController();
    const expected = new AiSdkProviderError("openai", new AbortStreamError("client closed request"));
    let pull = 0;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pull++ === 0) {
                controller.enqueue(new TextEncoder().encode("partial"));
                abort.abort();
              } else {
                controller.error(expected);
              }
            },
          }),
          { status: 200 },
        );
      },
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: abort.signal,
    });

    // Then
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toBe(expected);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "cancelled",
          finalStatusCode: 200,
          attempts: [expect.objectContaining({ outcome: "cancelled", statusCode: 200 })],
        }),
      ],
      usages: [],
    });
  });

  test("Given native response body wraps an AbortError without inbound cancellation Then request is failure", async () => {
    const expected = new AiSdkProviderError("openai", new AbortStreamError("upstream aborted"));
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(expected);
            },
          }),
          { status: 200 },
        ),
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(response.text()).rejects.toBe(expected);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "failure",
          finalStatusCode: 200,
          attempts: [expect.objectContaining({ outcome: "failure", statusCode: 200 })],
        }),
      ],
      usages: [],
    });
  });

  test("Given an alias variant and native provider When completion is posted Then passthrough receives the variant model", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-default", "gpt-high"],
      alias: {
        mini: {
          model: "gpt-default",
          preserve: false,
          variants: { high: { model: "gpt-high", preserve: false } },
        },
      },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, model: "mini", reasoning_effort: "high" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(200);
    expect(bodySeen).toEqual({ ...chatRequest, model: "gpt-high", reasoning_effort: "high" });
  });

  test("Given openai-compatible api provider When non-stream completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json(
          {
            id: "chatcmpl-upstream",
            object: "chat.completion",
            choices: [],
          },
          { status: 200 },
        );
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });
    const request = { ...chatRequest, stream: false };

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "chatcmpl-upstream",
      object: "chat.completion",
      choices: [],
    });
    expect(bodySeen).toEqual(request);
  });
});
