import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { CcaTransport } from "./transport";

import { createAntigravityGoogleFetch } from "./google-fetch";
import { createAntigravityProviderV4 } from "./provider";
import { AntigravityTransport } from "./transport";

test.each(["models/foo", "tunedModels/foo"])(
  "preserves the codec-encoded model resource %s for CCA routing",
  async (modelId) => {
    const calls: Parameters<CcaTransport["execute"]>[0][] = [];
    const provider = createAntigravityProviderV4({
      call: (context: LogicalRequestContext) => ({
        context,
        transport: {
          async execute(input) {
            calls.push(input);
            return Response.json({
              response: {
                candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
              },
            });
          },
        },
      }),
    });

    await provider.languageModel(modelId).doGenerate(callOptions());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe(modelId);
  },
);

test("preserves downstream cancellation and CCA reader cleanup", async () => {
  const abort = new AbortController();
  let cancelled: unknown;
  let seenSignal: AbortSignal | undefined;
  const fetcher = createAntigravityGoogleFetch(
    {
      context: logicalContext(),
      transport: {
        async execute(input) {
          seenSignal = input.signal;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"response":{"candidates":[]}}\n\n'));
              },
              cancel(reason) {
                cancelled = reason;
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        },
      },
    },
    "gemini-3-flash-agent",
  );
  const response = await fetcher(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:streamGenerateContent?alt=sse",
    { method: "POST", body: "{}", signal: abort.signal },
  );
  const reader = response.body?.getReader();
  await reader?.read();
  const reason = { kind: "downstream-cancel" };
  await reader?.cancel(reason);

  expect(seenSignal?.aborted).toBe(false);
  expect(cancelled).toBe(reason);
});

test("propagates a non-Error caller reason while reading CCA JSON", async () => {
  const abort = new AbortController();
  const reason = { kind: "json-read-cancelled" };
  const fetcher = createAntigravityGoogleFetch(
    {
      context: logicalContext(),
      transport: {
        async execute() {
          return new Response(
            new ReadableStream({
              pull(controller) {
                abort.abort(reason);
                controller.error(new Error("reader failed after cancellation"));
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        },
      },
    },
    "gemini-3-flash-agent",
  );

  await expect(
    fetcher("https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:generateContent", {
      method: "POST",
      body: "{}",
      signal: abort.signal,
    }),
  ).rejects.toBe(reason);
});

test("returns a Google-shaped 400 for an invalid function declaration schema", async () => {
  let sent = false;
  const fetcher = createAntigravityGoogleFetch(
    {
      context: logicalContext(),
      transport: new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async () => {
          sent = true;
          return Response.json({ response: {} });
        },
      }),
    },
    "gemini-3-flash-agent",
  );

  const response = await fetcher(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-agent:generateContent",
    {
      method: "POST",
      body: JSON.stringify({
        tools: [{ functionDeclarations: [{ name: "invalid", parametersJsonSchema: null }] }],
      }),
    },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: { code: 400, message: "Google Antigravity request failed", status: "INVALID_ARGUMENT" },
  });
  expect(sent).toBe(false);
});

function callOptions() {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    providerOptions: {
      aioProxy: {
        logicalRequest: logicalContext(),
      },
    },
  } as never;
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}

function credentialSource() {
  const credential = {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
  };
  return { current: async () => credential, forceRefresh: async () => credential };
}
