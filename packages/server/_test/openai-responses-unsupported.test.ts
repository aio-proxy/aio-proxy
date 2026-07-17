import { describe, expect, test } from "bun:test";
import { createServer } from "@aio-proxy/server";

import {
  aiSdkProvider,
  responsesRequest,
  textStream,
  unsupportedBeforeProviderInvocationCases,
  unsupportedEnvelope,
} from "./openai-responses.test-support";

describe("OpenAI Responses routes", () => {
  for (const scenario of unsupportedBeforeProviderInvocationCases) {
    test(`Given ${scenario.name} When POST is requested Then unsupported feature is returned before provider invocation`, async () => {
      // Given
      let invoked = false;
      const provider = aiSdkProvider(() => {
        invoked = true;
        return textStream([]);
      });
      const app = await createServer({
        config: { providers: {} },
        providerInstances: [provider],
      });

      // When
      const response = await app.request("/v1/responses", {
        body: JSON.stringify(scenario.body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      // Then
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual(unsupportedEnvelope(scenario.feature));
      expect(invoked).toBe(false);
    });
  }

  test("Given forbidden built-in tool When POST is requested Then unsupported feature is returned", async () => {
    // Given
    const app = await createServer({ config: { providers: {} } });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: "web_search_preview" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope("web_search_preview"));
  });

  test("Given stored response id When GET is requested Then retrieval is unsupported", async () => {
    // Given
    const app = await createServer({ config: { providers: {} } });

    // When
    const response = await app.request("/v1/responses/resp-1");

    // Then
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope("response_retrieval"));
  });

  test("Given malformed JSON When POST is requested Then invalid request is returned before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid OpenAI Responses request",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });
});
