import { describe, expect, test } from "bun:test";
import type { LogicalRequestContext, RawResolver } from "@aio-proxy/plugin-sdk";
import { createGeminiRawResolver } from "./raw";
import { AntigravityTransport } from "./transport";

describe("Gemini raw resolver", () => {
  test("returns a transport only for Gemini", () => {
    const resolver = createGeminiRawResolver({ execute: async () => Response.json({ response: {} }) });

    expect(resolve(resolver, "gemini")).toBeDefined();
    expect(resolve(resolver, "anthropic")).toBeUndefined();
    expect(resolve(resolver, "openai-compatible")).toBeUndefined();
    expect(resolve(resolver, "openai-response")).toBeUndefined();
  });

  test("wraps the rewritten Gemini request and unwraps CCA JSON", async () => {
    let upstream: Request | undefined;
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input, init) => {
          upstream = new Request(input, init);
          return Response.json({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } });
        },
      }),
    );
    const transport = resolve(resolver, "gemini");
    const image = { inlineData: { mimeType: "image/png", data: "image-base64-marker" } };
    const request = geminiRequest("generateContent", {
      contents: [{ role: "user", parts: [image] }],
      generationConfig: { thinkingConfig: { thinkingLevel: "HIGH", vendorMarker: true } },
      safetySettings: [{ category: "unsafe-marker" }],
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    });

    const response = await transport?.invoke(request, logicalContext());
    const body = (await upstream?.clone().json()) as Record<string, unknown>;

    expect(await response?.json()).toEqual({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    expect(body).toMatchObject({
      model: "gemini-3-flash-agent",
      request: {
        contents: [{ role: "user", parts: [image] }],
        generationConfig: {
          thinkingConfig: { vendorMarker: true, thinkingBudget: 10000, includeThoughts: true },
        },
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      },
    });
    expect(JSON.stringify(body)).not.toContain("unsafe-marker");
    expect(upstream?.url).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent");
  });

  test("unwraps CCA SSE frames and falls back before the first model frame", async () => {
    const origins: string[] = [];
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input) => {
          const origin = new URL(String(input)).origin;
          origins.push(origin);
          if (origins.length === 1) {
            return sseResponse(['data: {"error":{"code":503,"message":"no capacity","status":"UNAVAILABLE"}}\n\n']);
          }
          return sseResponse(['data: {"response":{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}}\n\n']);
        },
      }),
    );

    const response = await resolve(resolver, "gemini")?.invoke(
      geminiRequest("streamGenerateContent", {}),
      logicalContext(),
    );

    expect(await response?.text()).toBe('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}\n\n');
    expect(origins).toEqual(["https://daily-cloudcode-pa.googleapis.com", "https://cloudcode-pa.googleapis.com"]);
  });

  test("never replays after a model stream frame is committed", async () => {
    const origins: string[] = [];
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input) => {
          origins.push(new URL(String(input)).origin);
          return sseResponse([
            'data: {"response":{"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}}\n\n',
            'data: {"error":{"code":503,"message":"late failure","status":"UNAVAILABLE"}}\n\n',
          ]);
        },
      }),
    );

    const response = await resolve(resolver, "gemini")?.invoke(
      geminiRequest("streamGenerateContent", {}),
      logicalContext(),
    );
    const frames = await response?.text();

    expect(frames).toContain('data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}');
    expect(frames).toContain('data: {"error":{"code":503,"message":"late failure","status":"UNAVAILABLE"}}');
    expect(origins).toEqual(["https://daily-cloudcode-pa.googleapis.com"]);
  });

  test("returns standard Gemini errors without upstream body disclosure", async () => {
    const resolver = createGeminiRawResolver({
      execute: async () => Response.json({ raw: "upstream-secret" }, { status: 400 }),
    });

    const response = await resolve(resolver, "gemini")?.invoke(geminiRequest("generateContent", {}), logicalContext());

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: { code: 400, message: "Google Antigravity request failed", status: "INVALID_ARGUMENT" },
    });
  });

  test("returns a protocol-shaped 400 without sending an invalid function declaration", async () => {
    let sent = false;
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async () => {
          sent = true;
          return Response.json({ response: {} });
        },
      }),
    );

    const response = await resolve(resolver, "gemini")?.invoke(
      geminiRequest("generateContent", {
        tools: [{ functionDeclarations: [{ name: "invalid", parametersJsonSchema: null }] }],
      }),
      logicalContext(),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: { code: 400, message: "Google Antigravity request failed", status: "INVALID_ARGUMENT" },
    });
    expect(sent).toBe(false);
  });

  test("does not forward inbound cookies, request IDs, or fingerprints", async () => {
    let headers = new Headers();
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input, init) => {
          headers = new Request(input, init).headers;
          return Response.json({ response: {} });
        },
      }),
    );
    const request = geminiRequest(
      "generateContent",
      {},
      {
        Cookie: "session=inbound-secret",
        "X-Client-Request-Id": "client-request-secret",
        "X-Stainless-Runtime": "browser-fingerprint",
      },
    );

    await resolve(resolver, "gemini")?.invoke(request, logicalContext());

    expect([...headers.keys()]).not.toContain("cookie");
    expect([...headers.keys()]).not.toContain("x-client-request-id");
    expect([...headers.keys()]).not.toContain("x-stainless-runtime");
  });

  test("propagates non-Error caller cancellation without provider replay", async () => {
    const reason = { kind: "caller-cancelled" };
    const abort = new AbortController();
    abort.abort(reason);
    const resolver = createGeminiRawResolver({
      execute: async () => {
        throw reason;
      },
    });
    const request = new Request("http://localhost/v1beta/models/gemini-3-flash-agent:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });

    await expect(resolve(resolver, "gemini")?.invoke(request, logicalContext())).rejects.toBe(reason);
  });

  test("propagates caller cancellation while reading the request body", async () => {
    const reason = { kind: "body-read-cancelled" };
    const abort = new AbortController();
    let executions = 0;
    const resolver = createGeminiRawResolver({
      execute: async () => {
        executions += 1;
        return Response.json({ response: {} });
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        abort.abort(reason);
        controller.error(reason);
      },
    });
    const request = new Request("http://localhost/v1beta/models/gemini-3-flash-agent:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: abort.signal,
    });

    await expect(resolve(resolver, "gemini")?.invoke(request, logicalContext())).rejects.toBe(reason);
    expect(executions).toBe(0);
  });

  test("propagates caller cancellation while reading a successful upstream JSON body", async () => {
    const reason = { kind: "response-body-cancelled" };
    const abort = new AbortController();
    const resolver = createGeminiRawResolver({
      execute: async () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            abort.abort(reason);
            controller.error(reason);
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const request = new Request("http://localhost/v1beta/models/gemini-3-flash-agent:generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: abort.signal,
    });

    await expect(resolve(resolver, "gemini")?.invoke(request, logicalContext())).rejects.toBe(reason);
  });
});

function resolve(resolver: RawResolver, protocol: Parameters<RawResolver>[0]["protocol"]) {
  return resolver({ protocol, modelId: "gemini-3-flash-agent" });
}

function geminiRequest(
  method: "generateContent" | "streamGenerateContent",
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(`http://localhost/v1beta/models/gemini-3-flash-agent:${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  });
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
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

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}
