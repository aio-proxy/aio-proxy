import { expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { createGeminiRawResolver } from "./raw";

test.each([302, 304])("maps raw upstream status %i to a safe 500 error response", async (status) => {
  const marker = "raw-redirect-secret";
  const resolver = createGeminiRawResolver({
    execute: async () =>
      status === 304 ? new Response(null, { status }) : Response.json({ location: marker }, { status }),
  });
  const transport = resolver({ protocol: "gemini", modelId: "gemini-3-flash-agent" });

  const response = await transport?.invoke(geminiRequest(), logicalContext());
  const body = await response?.text();

  expect(response?.status).toBe(500);
  expect(body).toContain("Google Antigravity request failed");
  expect(body).not.toContain(marker);
});

function geminiRequest(): Request {
  return new Request("http://localhost/v1beta/models/gemini-3-flash-agent:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}
