import { describe, expect, test } from "bun:test";

import {
  aiSdkProvider,
  appWith,
  googleNativeProvider,
  jsonHeaders,
  postStream,
  textStream,
} from "./gemini-generate-content.test-support";

describe("POST /v1beta/models/:model::streamGenerateContent", () => {
  test("Given gemini api provider When streamGenerateContent is posted Then passthrough preserves stream bytes", async () => {
    // Given
    const provider = googleNativeProvider(async () => {
      return new Response('data: {"upstream":true}\n\n', {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    });
    const app = await appWith(provider);

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
    const app = await appWith(provider);
    const data = "A".repeat(27_962_028);

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
    const app = await appWith(provider);

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

describe("Gemini generateContent route matching", () => {});
