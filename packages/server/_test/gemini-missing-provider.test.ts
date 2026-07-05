import { describe, expect, test } from "bun:test";
import { createAiSdkProvider } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";

const generateRequest = {
  contents: [{ role: "user", parts: [{ text: "Hello proxy" }] }],
};

describe("Gemini missing provider boundary", () => {
  test("Given ai-sdk provider package is missing When streamGenerateContent is posted Then Gemini error is actionable 503 before SSE", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gemini-2.5-flash"],
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
      body: JSON.stringify(generateRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(body.error.status).toBe("UNAVAILABLE");
    expect(body.error.message).toContain("run aio-proxy provider install @vendor/missing-provider");
  });
});
