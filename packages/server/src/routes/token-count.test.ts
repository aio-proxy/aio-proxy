import { geminiGenerateContentAdapter } from "@aio-proxy/core";
import { expect, test } from "bun:test";

import { createGeminiGenerateContentRoutes } from "./gemini-generate-content";
import {
  anthropicRequest,
  configOrderedProviders,
  countFixture,
  counter,
  geminiContext,
  geminiRequest,
  provider,
  requestedModel,
} from "./token-count.test-support";

test("uses routing order and falls through candidates without count support", async () => {
  const calls: string[] = [];
  const fixture = countFixture([
    provider({ id: "unsupported" }),
    provider({
      id: "real",
      tokenCount: async () => {
        calls.push("real");
        return { inputTokens: 42 };
      },
    }),
  ]);

  const response = await fixture.anthropic();

  expect(await response.json()).toEqual({ input_tokens: 42 });
  expect(response.headers.has("x-aio-proxy-token-count-estimated")).toBe(false);
  expect(calls).toEqual(["real"]);
  expect(fixture.recording.attempts).toEqual([
    expect.objectContaining({ outcome: "success", providerId: "real", statusCode: 200 }),
  ]);
  expect(fixture.releases()).toBe(1);
});

test("uses descending Provider weight before lower configured candidates", async () => {
  const calls: string[] = [];
  const fixture = countFixture(
    configOrderedProviders([
      { provider: provider({ id: "low", tokenCount: counter("low", 22, calls) }), weight: 1 },
      { provider: provider({ id: "high", tokenCount: counter("high", 11, calls) }), weight: 10 },
    ]),
  );

  expect(await (await fixture.gemini()).json()).toEqual({ totalTokens: 11 });
  expect(calls).toEqual(["high"]);
});

test("preserves config order for equal Provider weights", async () => {
  const calls: string[] = [];
  const fixture = countFixture(
    configOrderedProviders([
      { provider: provider({ id: "first", tokenCount: counter("first", 11, calls) }), weight: 5 },
      { provider: provider({ id: "second", tokenCount: counter("second", 22, calls) }), weight: 5 },
    ]),
  );

  expect(await (await fixture.gemini()).json()).toEqual({ totalTokens: 11 });
  expect(calls).toEqual(["first"]);
});

test("records failed and invalid counters before succeeding", async () => {
  const bodies: string[] = [];
  const fixture = countFixture([
    provider({
      id: "failed",
      tokenCount: async ({ request }) => {
        bodies.push(await request.text());
        throw new Error("counter unavailable");
      },
    }),
    provider({ id: "invalid", tokenCount: async () => ({ inputTokens: 1.5 }) }),
    provider({
      id: "real",
      tokenCount: async ({ request }) => {
        bodies.push(await request.text());
        return { inputTokens: 7 };
      },
    }),
  ]);

  expect(await (await fixture.anthropic()).json()).toEqual({ input_tokens: 7 });
  expect(bodies).toEqual([
    expect.stringContaining('"model":"count-model"'),
    expect.stringContaining('"model":"count-model"'),
  ]);
  expect(fixture.recording.attempts).toEqual([
    expect.objectContaining({ outcome: "failure", providerId: "failed", statusCode: 500 }),
    expect.objectContaining({ outcome: "failure", providerId: "invalid", statusCode: 500 }),
    expect.objectContaining({ outcome: "success", providerId: "real", statusCode: 200 }),
  ]);
});

test("returns a standard estimate with the estimate header after real attempts fail", async () => {
  const rawRequest = geminiRequest();
  const parsed = await geminiGenerateContentAdapter.parse(rawRequest.clone(), geminiContext());
  const expected = Math.max(1, Math.ceil(JSON.stringify(parsed).length / 64));
  const fixture = countFixture([
    provider({
      id: "failed",
      tokenCount: async () => {
        throw new Error("counter unavailable");
      },
    }),
  ]);

  const response = await fixture.gemini(rawRequest);

  expect(await response.json()).toEqual({ totalTokens: expected });
  expect(response.headers.get("x-aio-proxy-token-count-estimated")).toBe("true");
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: "success" })]);
});

test("skips provider-tool-incompatible counters before invoking them", async () => {
  let unsupportedCalls = 0;
  const fixture = countFixture([
    provider({
      id: "unsupported",
      supportsProviderTool: false,
      tokenCount: async () => {
        unsupportedCalls += 1;
        return { inputTokens: 1 };
      },
    }),
    provider({ id: "capable", supportsProviderTool: true, tokenCount: async () => ({ inputTokens: 9 }) }),
  ]);

  const response = await fixture.anthropic(
    anthropicRequest({
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    }),
  );

  expect(await response.json()).toEqual({ input_tokens: 9 });
  expect(unsupportedCalls).toBe(0);
});

test("maps model-not-found and releases the snapshot lease", async () => {
  const fixture = countFixture([]);

  const response = await fixture.anthropic();

  expect(response.status).toBe(404);
  expect(fixture.recording.begins).toEqual([]);
  expect(fixture.releases()).toBe(1);
});

test("routes Gemini countTokens and preserves a provider-qualified model resource", async () => {
  const modelIds: string[] = [];
  const fixture = countFixture([
    provider({
      id: "gemini",
      tokenCount: async ({ modelId }) => {
        modelIds.push(modelId);
        return { inputTokens: 17 };
      },
    }),
  ]);

  const response = await createGeminiGenerateContentRoutes(fixture.source).request(
    `/v1beta/models/gemini/${requestedModel}:countTokens`,
    { method: "POST", headers: { "content-type": "application/json" }, body: await geminiRequest().text() },
  );

  expect(await response.json()).toEqual({ totalTokens: 17 });
  expect(modelIds).toEqual(["gemini-wire"]);
});
