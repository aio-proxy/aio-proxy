import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkProviderError, type AiSdkProviderInstance, type ApiProviderInstance } from "@aio-proxy/core";
import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, JSONValue, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { asSchema } from "ai";

const generateRequest = {
  contents: [{ role: "user", parts: [{ text: "Hello proxy" }] }],
};
const jsonHeaders = { "content-type": "application/json" } as const;
const homes: string[] = [];
type ProviderSeenSettings = CallSettings & {
  readonly providerOptions?: {
    readonly google: {
      readonly safetySettings: JSONValue;
    };
  };
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-gemini-usage-"));
  homes.push(home);
  return home;
}

async function recorded(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    const requests = handle.db.select().from(requestLog).all();
    const usages = handle.db.select().from(usage).all();
    handle.close();
    if (requests.length > 0) return { requests, usages };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("request row was not recorded");
}

function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

function appWith(
  provider?: ApiProviderInstance | AiSdkProviderInstance,
  dbHome?: string,
): ReturnType<typeof createServer> {
  return createServer({
    config: { providers: {} },
    ...(dbHome === undefined ? {} : { dbHome }),
    providerInstances: provider === undefined ? [] : [provider],
  });
}

function googleNativeProvider(passthrough: ApiProviderInstance["passthrough"]): ApiProviderInstance {
  return {
    id: "google",
    kind: "api",
    models: ["gemini-2.5-flash"],
    alias: { "gemini-2.5-flash": { model: "gemini-2.5-flash", preserve: false } },
    protocol: ProviderProtocol.Gemini,
    passthrough,
  };
}

function aiSdkProvider(invoke: AiSdkProviderInstance["invoke"]): AiSdkProviderInstance {
  return {
    id: "mock-ai",
    kind: "ai-sdk",
    models: ["gemini-2.5-flash"],
    alias: { "gemini-2.5-flash": { model: "gemini-2.5-flash", preserve: false } },
    invoke,
  };
}

function postGenerate(
  app: ReturnType<typeof createServer>,
  body: string | object = generateRequest,
  model = "gemini-2.5-flash",
): Promise<Response> {
  return app.request(`/v1beta/models/${model}:generateContent`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: jsonHeaders,
    method: "POST",
  });
}

function postStream(app: ReturnType<typeof createServer>): Promise<Response> {
  return app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
    body: JSON.stringify(generateRequest),
    headers: jsonHeaders,
    method: "POST",
  });
}

describe("POST /v1beta/models/:model::generateContent", () => {
  test("Given gemini api provider When generateContent is posted Then passthrough receives original bytes", async () => {
    // Given
    const requestBody = JSON.stringify(generateRequest);
    let bodySeen = "";
    const provider = googleNativeProvider(async (req) => {
      bodySeen = await req.text();
      return new Response("provider-bytes", {
        headers: { "x-provider": "google" },
        status: 202,
      });
    });
    const dbHome = tempHome();
    const app = appWith(provider, dbHome);

    // When
    const response = await postGenerate(app, requestBody);

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("google");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toBe(requestBody);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.Gemini,
          requestedModelId: "gemini-2.5-flash",
          finalProviderId: "google",
          finalModelId: "gemini-2.5-flash",
          outcome: "success",
          attempts: [expect.objectContaining({ index: 0, providerId: "google", outcome: "success" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given first native provider throws When generateContent is posted Then next provider is used", async () => {
    const first = googleNativeProvider(async () => {
      throw new Error("connection refused");
    });
    const second = {
      ...googleNativeProvider(async () => Response.json({ fallback: true })),
      id: "google-fallback",
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await postGenerate(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fallback: true });
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          attempts: [
            expect.objectContaining({ index: 0, providerId: "google", outcome: "failure" }),
            expect.objectContaining({ index: 1, providerId: "google-fallback", outcome: "success" }),
          ],
          outcome: "success",
        }),
      ],
      usages: [],
    });
  });

  test("Given stream emits data then errors When streamGenerateContent runs Then request is failure", async () => {
    const provider = aiSdkProvider(
      () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            controller.error(new Error("stream broke"));
          },
        }),
    );
    const dbHome = tempHome();
    const app = appWith(provider, dbHome);

    const response = await postStream(app);
    await response.text();
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: "failure", attempts: [expect.objectContaining({ outcome: "failure" })] }),
      ],
      usages: [],
    });
  });

  test.each([
    false,
    true,
  ])("Given an aborted inbound signal and wrapped AbortError When Gemini stream is %s Then request is cancelled", async (stream) => {
    const provider = aiSdkProvider(() => {
      let sent = false;
      return new ReadableStream<TextStreamPart<ToolSet>>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
          } else {
            controller.error(new AiSdkProviderError("mock-ai", new AbortStreamError("client closed request")));
          }
        },
      });
    });
    const dbHome = tempHome();
    const app = appWith(provider, dbHome);
    const abort = new AbortController();
    abort.abort();

    const response = stream
      ? await app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
          body: JSON.stringify(generateRequest),
          headers: jsonHeaders,
          method: "POST",
          signal: abort.signal,
        })
      : await app.request("/v1beta/models/gemini-2.5-flash:generateContent", {
          body: JSON.stringify(generateRequest),
          headers: jsonHeaders,
          method: "POST",
          signal: abort.signal,
        });
    await response.text().catch(() => undefined);

    expect(response.status).toBe(stream ? 200 : 500);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "cancelled",
          attempts: [expect.objectContaining({ outcome: "cancelled" })],
        }),
      ],
      usages: [],
    });
  });

  test.each([
    "provider rejected",
    null,
    { message: "provider rejected" },
  ])("Given final provider rejects %p When generateContent is posted Then one failed request is recorded", async (reason) => {
    const provider = aiSdkProvider(() => new ReadableStream({ pull: (controller) => controller.error(reason) }));
    const dbHome = tempHome();
    const app = appWith(provider, dbHome);

    const response = await postGenerate(app);

    expect(response.status).toBe(500);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          finalProviderId: "mock-ai",
          outcome: "failure",
          attempts: [expect.objectContaining({ index: 0, providerId: "mock-ai", outcome: "failure" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given an alias variant and native provider When generateContent is posted Then passthrough uses the variant path", async () => {
    // Given
    let pathnameSeen = "";
    let bodySeen = "";
    const provider = {
      id: "google",
      kind: "api",
      models: ["gemini-default", "gemini-high"],
      alias: {
        "gemini-alias": {
          model: "gemini-default",
          preserve: false,
          variants: { high: { model: "gemini-high", preserve: false } },
        },
      },
      protocol: ProviderProtocol.Gemini,
      async passthrough(req) {
        pathnameSeen = new URL(req.url).pathname;
        bodySeen = await req.text();
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = appWith(provider);
    const body = {
      ...generateRequest,
      generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
    };

    // When
    const response = await postGenerate(app, body, "gemini-alias");

    // Then
    expect(response.status).toBe(200);
    expect(pathnameSeen).toBe("/v1beta/models/gemini-high:generateContent");
    expect(JSON.parse(bodySeen)).toEqual(body);
  });

  test("Given gemini oversized inlineData When generateContent is posted Then returns 413 without passthrough", async () => {
    // Given
    let invoked = false;
    const provider = googleNativeProvider(async () => {
      invoked = true;
      return new Response("provider-invoked", { status: 202 });
    });
    const app = appWith(provider);
    const data = `${"A".repeat(27_962_028)}====`;

    // When
    const response = await postGenerate(app, {
      contents: [
        {
          parts: [{ inlineData: { mimeType: "image/png", data } }],
        },
      ],
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toMatchObject({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider When generateContent is posted Then Gemini JSON is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    let settingsSeen: ProviderSeenSettings | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      modelSeen = request.modelId;
      settingsSeen = request.settings;
      return textStream([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "Hel" },
        { type: "text-delta", id: "text-1", text: "lo" },
        { type: "text-end", id: "text-1" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "STOP",
          totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ]);
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app);
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(messagesSeen).toEqual([{ role: "user", content: [{ type: "text", text: "Hello proxy" }] }]);
    expect(modelSeen).toBe("gemini-2.5-flash");
    expect(settingsSeen).toEqual({});
    expect(body).toMatchObject({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
      modelVersion: "gemini-2.5-flash",
    });
    expect(body.responseId).toStartWith("resp_");
  });

  test("Given an alias variant and ai-sdk provider When generateContent is posted Then reasoning selects and configures it", async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: ProviderSeenSettings | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gemini-default", "gemini-high"],
      alias: {
        "gemini-alias": {
          model: "gemini-default",
          preserve: false,
          variants: { high: { model: "gemini-high", preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = appWith(provider);

    // When
    const response = await postGenerate(
      app,
      {
        ...generateRequest,
        generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
      },
      "gemini-alias",
    );
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe("gemini-high");
    expect(settingsSeen).toEqual({ reasoning: "high" });
  });

  test("Given tools and safetySettings When generateContent is posted Then provider receives them", async () => {
    // Given
    const parameters = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const safetySettings = [
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_ONLY_HIGH",
      },
    ];
    let settingsSeen: ProviderSeenSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((request) => {
      settingsSeen = request.settings;
      toolsSeen = request.tools;
      return textStream([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "ok" },
        { type: "text-end", id: "text-1" },
      ]);
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app, {
      contents: [{ role: "user", parts: [{ text: "Weather?" }] }],
      generationConfig: { temperature: 0.2 },
      safetySettings,
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Returns weather for a city.",
              parameters,
            },
          ],
        },
      ],
    });

    // Then
    const weatherTool = toolsSeen?.get_weather;
    if (weatherTool === undefined) {
      throw new Error("Expected provider to receive get_weather tool");
    }

    expect(response.status).toBe(200);
    expect(settingsSeen).toEqual({
      temperature: 0.2,
      providerOptions: { google: { safetySettings } },
    });
    expect(weatherTool.type).toBe("function");
    expect(weatherTool.description).toBe("Returns weather for a city.");
    expect(await asSchema(weatherTool.inputSchema).jsonSchema).toEqual(parameters);
  });

  test("Given no matching alias When generateContent is posted Then returns 404 Gemini error envelope", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app, generateRequest, "missing-model");
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: 404,
        message: "Model not found: missing-model",
        status: "NOT_FOUND",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given forged oversized Content-Length When generateContent is posted Then returns 413 before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = appWith(provider);

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash:generateContent", {
      body: JSON.stringify(generateRequest),
      headers: {
        ...jsonHeaders,
        "content-length": "8388609",
      },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: 413,
        message: "Request body too large",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given oversized inlineData When generateContent is posted Then returns 413 Gemini error envelope", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = appWith(provider);
    const data = `${"A".repeat(27_962_028)}====`;

    // When
    const response = await postGenerate(app, {
      contents: [
        {
          parts: [{ inlineData: { mimeType: "image/png", data } }],
        },
      ],
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });
});

describe("POST /v1beta/models/:model::streamGenerateContent", () => {
  test("Given gemini api provider When streamGenerateContent is posted Then passthrough preserves stream bytes", async () => {
    // Given
    const provider = googleNativeProvider(async () => {
      return new Response('data: {"upstream":true}\n\n', {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    });
    const app = appWith(provider);

    // When
    const response = await postStream(app);

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"upstream":true}\n\n');
  });

  test("Given gemini oversized inlineData When streamGenerateContent is posted Then returns 413 without passthrough", async () => {
    // Given
    let invoked = false;
    const provider = googleNativeProvider(async () => {
      invoked = true;
      return new Response('data: {"upstream":true}\n\n', { status: 200 });
    });
    const app = appWith(provider);
    const data = `${"A".repeat(27_962_028)}====`;

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
      body: JSON.stringify({
        contents: [
          {
            parts: [{ inlineData: { mimeType: "image/png", data } }],
          },
        ],
      }),
      headers: jsonHeaders,
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider When streamGenerateContent is posted Then exact Gemini SSE frames are returned", async () => {
    // Given
    const provider = aiSdkProvider(() => {
      return textStream([
        { type: "text-delta", id: "text-1", text: "Hel" },
        { type: "text-delta", id: "text-1", text: "lo" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "STOP",
          totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ]);
    });
    const app = appWith(provider);

    // When
    const response = await postStream(app);
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = text
      .trim()
      .split("\n\n")
      .map(
        (frame) =>
          JSON.parse(frame.slice("data: ".length)) as {
            readonly candidates: readonly {
              readonly content: { readonly parts: readonly unknown[] };
              readonly finishReason?: string;
            }[];
            readonly modelVersion: string;
            readonly responseId: string;
            readonly usageMetadata?: Record<string, number>;
          },
      );
    expect(frames.map((frame) => frame.candidates[0].content.parts)).toEqual([[{ text: "Hel" }], [{ text: "lo" }], []]);
    expect(new Set(frames.map((frame) => frame.responseId)).size).toBe(1);
    expect(frames.every((frame) => frame.modelVersion === "gemini-2.5-flash")).toBe(true);
    expect(frames[2]).toMatchObject({
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
  });
});

describe("Gemini generateContent route matching", () => {
  test("Given missing method suffix When model path is posted Then Hono returns 404", async () => {
    // Given
    const app = appWith();

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash", {
      body: JSON.stringify(generateRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
  });
});
