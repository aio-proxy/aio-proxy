import { describe, expect, test } from "bun:test";
import { createAiSdkProvider } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";

const responsesRequest = {
  model: "gpt-4.1-mini",
  input: "Say pong.",
  stream: true,
};

describe("OpenAI Responses missing provider boundary", () => {
  test("Given ai-sdk provider package is missing When POST streams Then OpenAI error is actionable 503 before SSE", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4.1-mini"],
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(responsesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(body.error.code).toBe("provider_not_installed");
    expect(body.error.message).toContain("run aio-proxy provider install @vendor/missing-provider");
  });
});
