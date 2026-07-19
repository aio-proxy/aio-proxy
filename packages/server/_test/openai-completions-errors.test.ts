import { AiSdkProviderError, type AiSdkProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  AbortStreamError,
  chatRequest,
  createTempHomes,
  errorStream,
  mockModelsDevCatalog,
  recorded,
  restoreFetch,
  UpstreamStatusError,
} from "./openai-completions.test-support";

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);
const homes = createTempHomes("aio-proxy-openai-usage-");
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe("POST /v1/chat/completions", () => {
  test("Given ai-sdk provider returns upstream status error When non-stream completion is posted Then OpenAI error hides provider id", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return errorStream(new UpstreamStatusError("upstream denied"));
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = JSON.parse(text);

    // Then
    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "upstream_error",
        message: "upstream denied",
        type: "invalid_request_error",
      },
    });
    expect(text).not.toContain("mock-ai");
  });

  test("Given ai-sdk provider returns abort error When non-stream completion is posted Then OpenAI error uses 499", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return errorStream(new AbortStreamError("client closed request"));
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(499);
    expect(body).toEqual({
      error: {
        code: "aborted",
        message: "client closed request",
        type: "invalid_request_error",
      },
    });
  });

  test.each([false, true])(
    "Given an aborted inbound signal and wrapped AbortError When stream is %s Then request is cancelled",
    async (stream) => {
      const provider = {
        id: "mock-ai",
        kind: "ai-sdk",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
        invoke: () =>
          errorStream(new AiSdkProviderError("mock-ai", new AbortStreamError("client closed request")), [
            { type: "text-delta", id: "text-1", text: "partial" },
          ]),
      } satisfies AiSdkProviderInstance;
      const dbHome = tempHome();
      const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
      const abort = new AbortController();
      abort.abort();

      const response = await app.request("/v1/chat/completions", {
        body: JSON.stringify({ ...chatRequest, stream }),
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
    },
  );
});
