import { describe, expect, test } from "bun:test";
import { type AiSdkProviderInstance, REQUEST_BODY_LIMITS } from "@aio-proxy/core";
import { messagesRequest, textStream } from "../../_test/anthropic-messages.test-support";
import { createServer } from "../server";

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
    expect(response.headers.get("x-aio-proxy-token-count-estimated")).toBe("true");
  });

  test("Given oversized Content-Length When token count is posted Then rejects before parsing", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify(messagesRequest),
      headers: {
        "content-length": String(REQUEST_BODY_LIMITS.encoded + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
  });
});
