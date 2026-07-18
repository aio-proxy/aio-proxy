import { expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { createGeminiRawResolver } from "./raw";

test.each([
  ["null", null],
  ["string", "invalid"],
  ["array", []],
] as const)("rejects malformed Gemini thinkingConfig %s locally", async (_label, value) => {
  let executions = 0;
  const resolver = createGeminiRawResolver({
    execute: async () => {
      executions += 1;
      return Response.json({ response: {} });
    },
  });
  const transport = resolver({ protocol: "gemini", modelId: "gemini-3-flash-agent" });

  const response = await transport?.invoke(request({ generationConfig: { thinkingConfig: value } }), context());

  expect(response?.status).toBe(400);
  expect(await response?.json()).toEqual({
    error: { code: 400, message: "Google Antigravity request failed", status: "INVALID_ARGUMENT" },
  });
  expect(executions).toBe(0);
});

test("forwards generationConfig without an own thinkingConfig unchanged", async () => {
  const body = { generationConfig: { temperature: 0.4 } };
  let executedBody: Record<string, unknown> | undefined;
  const resolver = createGeminiRawResolver({
    execute: async (request) => {
      executedBody = request.body;
      return Response.json({ response: {} });
    },
  });
  const transport = resolver({ protocol: "gemini", modelId: "gemini-3-flash-agent" });

  const response = await transport?.invoke(request(body), context());

  expect(response?.status).toBe(200);
  expect(executedBody).toEqual(body);
});

function request(body: unknown): Request {
  return new Request("http://localhost/v1beta/models/gemini-3-flash-agent:generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function context(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}
