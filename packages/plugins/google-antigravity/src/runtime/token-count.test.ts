import type { LogicalRequestContext, TokenCountInput } from "@aio-proxy/plugin-sdk";

import { jsonSchema } from "ai";
import { expect, test } from "bun:test";

import type { GoogleAntigravityCredential } from "../schema";

import { wireSessionId } from "./envelope";
import { createAntigravityTokenCount } from "./token-count";
import { AntigravityTransport } from "./transport";

test("uses the Google codec and count endpoint for the CCA token count", async () => {
  const seen: Request[] = [];
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async (input, init) => {
      seen.push(new Request(input, init));
      return Response.json({ totalTokens: 17 });
    },
  });
  const counter = createAntigravityTokenCount(transport, () => ({ antigravity: { supportsWebSearch: true } }));

  const result = await counter.countTokens(
    countInput({
      invocation: {
        messages: [{ role: "user", content: "what is the weather?" }],
        settings: {
          providerOptions: { aioProxy: { thinking: { mode: "fixed", budgetTokens: 512 } } },
        },
        tools: {
          weather: {
            description: "Forecast",
            inputSchema: jsonSchema({ type: "object", properties: { days: { const: 3 } } }),
          },
        },
        providerTools: [{ type: "web-search", name: "web_search", maxUses: 2 }],
      },
    }),
  );

  expect(result).toEqual({ inputTokens: 17 });
  expect(seen).toHaveLength(1);
  expect(new URL(seen[0]?.url ?? "").pathname).toBe("/v1internal:countTokens");
  const envelope = await seen[0]?.clone().json();
  expect(envelope).toMatchObject({
    model: "claude-sonnet-4-6",
    project: "project-1",
    requestId: "agent-00000000-0000-4000-8000-000000000001",
    request: {
      sessionId: wireSessionId(logicalContext().session.key),
      contents: [{ role: "user", parts: [{ text: "what is the weather?" }] }],
      generationConfig: { thinkingConfig: { thinkingBudget: 512, includeThoughts: true } },
      systemInstruction: {
        parts: [{ text: "Use Google Search when current or external information would improve the answer." }],
      },
      tools: expect.arrayContaining([
        {
          functionDeclarations: [
            {
              name: "weather",
              description: "Forecast",
              parameters: {
                type: "object",
                properties: { days: { type: "string", enum: ["3"] } },
              },
            },
          ],
        },
        { googleSearch: { enhancedContent: { imageSearch: { maxResultCount: 2 } } } },
      ]),
      toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
    },
  });
  expect(JSON.stringify(envelope)).not.toContain("input_tokens");
});

test("reuses daily to prod fallback, one auth refresh, and stable endpoint identity", async () => {
  const seen: Request[] = [];
  let refreshes = 0;
  const transport = new AntigravityTransport({
    credentials: {
      current: async () => credentialFixture(),
      forceRefresh: async () => {
        refreshes += 1;
        return credentialFixture({ accessToken: "access-2" });
      },
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      if (seen.length === 1) {
        return Response.json({ error: { message: "No capacity is available" } }, { status: 503 });
      }
      if (seen.length === 2) return Response.json({}, { status: 401 });
      return Response.json({ totalTokens: 23 });
    },
  });

  const result = await createAntigravityTokenCount(transport).countTokens(countInput());

  expect(result).toEqual({ inputTokens: 23 });
  expect(refreshes).toBe(1);
  expect(seen.map((request) => new URL(request.url).origin)).toEqual([
    "https://daily-cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]);
  expect(seen.map((request) => new URL(request.url).pathname)).toEqual([
    "/v1internal:countTokens",
    "/v1internal:countTokens",
    "/v1internal:countTokens",
  ]);
  expect(seen.map((request) => request.headers.get("authorization"))).toEqual([
    "Bearer access-1",
    "Bearer access-1",
    "Bearer access-2",
  ]);
  expect(new Set(await Promise.all(seen.map((request) => request.clone().text()))).size).toBe(1);
});

test("rejects an invalid CCA token count", async () => {
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => Response.json({ totalTokens: -1 }),
  });

  await expect(createAntigravityTokenCount(transport).countTokens(countInput())).rejects.toThrow("valid token count");
});

test("preserves the exact caller cancellation reason", async () => {
  const abort = new AbortController();
  const reason = { kind: "count-cancelled" };
  let requests = 0;
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () => {
      requests += 1;
      return Response.json({ totalTokens: 1 });
    },
  });
  abort.abort(reason);

  await expect(createAntigravityTokenCount(transport).countTokens(countInput({ signal: abort.signal }))).rejects.toBe(
    reason,
  );
  expect(requests).toBe(0);
});

test("preserves caller cancellation while reading the CCA count response", async () => {
  const abort = new AbortController();
  const reason = { kind: "count-response-cancelled" };
  const transport = new AntigravityTransport({
    credentials: credentialSource(),
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            abort.abort(reason);
            controller.error(new Error("reader failed after cancellation"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });

  await expect(createAntigravityTokenCount(transport).countTokens(countInput({ signal: abort.signal }))).rejects.toBe(
    reason,
  );
});

function countInput(
  overrides: { readonly invocation?: TokenCountInput["invocation"]; readonly signal?: AbortSignal } = {},
): TokenCountInput {
  return {
    protocol: "anthropic",
    modelId: "claude-sonnet-4-6",
    request: new Request("https://proxy.test/v1/messages/count_tokens", {
      method: "POST",
      signal: overrides.signal,
    }),
    context: logicalContext(),
    invocation: overrides.invocation ?? { messages: [{ role: "user", content: "hello" }] },
  };
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:count-session", source: "claude-code" },
  };
}

function credentialSource() {
  return { current: async () => credentialFixture(), forceRefresh: async () => credentialFixture() };
}

function credentialFixture(overrides: Partial<GoogleAntigravityCredential> = {}): GoogleAntigravityCredential {
  return {
    accessToken: "access-1",
    refreshToken: "refresh-1",
    expiresAt: 1_900_000_000_000,
    email: "person@example.com",
    projectId: "project-1",
    ...overrides,
  };
}
