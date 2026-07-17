import { afterEach, describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";

import { createTempHomes, messagesRequest, recorded, textStream } from "./anthropic-messages.test-support";

const homes = createTempHomes("aio-proxy-anthropic-usage-");
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe("POST /v1/messages", () => {
  test("Given a chunked body above 8 MiB When message is posted Then returns Anthropic 413 before provider invocation", async () => {
    let invoked = false;
    const provider = {
      id: "anthropic",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      async passthrough() {
        invoked = true;
        return Response.json({ unexpected: true });
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });
    let chunks = 0;

    const response = await app.request(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(new Uint8Array(1_024 * 1_024));
            if (chunks === 9) controller.close();
          },
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Request body too large" },
    });
    expect(invoked).toBe(false);
  });

  test("Given anthropic api provider When message is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "anthropic",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "anthropic" },
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
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("anthropic");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toEqual(messagesRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.Anthropic,
          requestedModelId: "claude-sonnet-4-5",
          finalProviderId: "anthropic",
          finalModelId: "claude-sonnet-4-5",
          outcome: "success",
          attempts: [expect.objectContaining({ index: 0, providerId: "anthropic", outcome: "success" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given first native provider throws When message is posted Then next provider is used and attempts are ordered", async () => {
    const first = {
      id: "offline",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      passthrough: async () => {
        throw new Error("connection refused");
      },
    } satisfies ApiProviderInstance;
    const second = {
      ...first,
      id: "ok",
      passthrough: async () => Response.json({ fallback: true }),
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(await response.json()).toEqual({ fallback: true });
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          attempts: [
            expect.objectContaining({ index: 0, providerId: "offline", outcome: "failure" }),
            expect.objectContaining({ index: 1, providerId: "ok", outcome: "success" }),
          ],
          outcome: "success",
        }),
      ],
      usages: [],
    });
  });

  test("Given first model provider fails before its first event When message is posted Then next provider is used", async () => {
    const first = {
      id: "broken-model",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () => new ReadableStream({ start: (controller) => controller.error(new Error("preflight failed")) }),
    } satisfies AiSdkProviderInstance;
    const second = {
      ...first,
      id: "fallback-model",
      invoke: () =>
        textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "fallback" },
          { type: "text-end", id: "text-1" },
        ]),
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"text":"fallback"');
  });
});
