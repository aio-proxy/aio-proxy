import { describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";

import { messagesRequest, textStream } from "./anthropic-messages.test-support";

describe("POST /v1/messages/count_tokens", () => {
  test("Given message request When token count is posted Then returns input token count", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke() {
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({ input_tokens: 2 });
    expect(typeof body.input_tokens).toBe("number");
  });

  test("Given oversized Content-Length When token count is posted Then rejects before parsing", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify(messagesRequest),
      headers: {
        "content-length": String(8 * 1_024 * 1_024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
  });
});
