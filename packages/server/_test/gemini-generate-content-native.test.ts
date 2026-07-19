import type { TextStreamPart, ToolSet } from "ai";

import { AiSdkProviderError, type ApiProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { afterEach, describe, expect, test } from "bun:test";

import {
  AbortStreamError,
  aiSdkProvider,
  appWith,
  createTempHomes,
  generateRequest,
  googleNativeProvider,
  jsonHeaders,
  postGenerate,
  postStream,
  recorded,
} from "./gemini-generate-content.test-support";

const homes = createTempHomes("aio-proxy-gemini-usage-");
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

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
    const app = await appWith(provider, dbHome);

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
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

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
    const app = await appWith(provider, dbHome);

    const response = await postStream(app);
    await response.text();
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: "failure", attempts: [expect.objectContaining({ outcome: "failure" })] }),
      ],
      usages: [],
    });
  });

  test.each([false, true])(
    "Given an aborted inbound signal and wrapped AbortError When Gemini stream is %s Then request is cancelled",
    async (stream) => {
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
      const app = await appWith(provider, dbHome);
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

      expect(response.status).toBe(stream ? 200 : 499);
      expect(await recorded(dbHome)).toEqual({
        requests: [
          expect.objectContaining({
            outcome: "cancelled",
            attempts: [expect.objectContaining({ outcome: "cancelled" })],
          }),
        ],
        usages: [],
      });
    },
  );

  test.each(["provider rejected", null, { message: "provider rejected" }])(
    "Given final provider rejects %p When generateContent is posted Then one failed request is recorded",
    async (reason) => {
      const provider = aiSdkProvider(() => new ReadableStream({ pull: (controller) => controller.error(reason) }));
      const dbHome = tempHome();
      const app = await appWith(provider, dbHome);

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
    },
  );

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
    const app = await appWith(provider);
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
    const app = await appWith(provider);
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
});
