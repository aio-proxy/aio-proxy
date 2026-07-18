import { describe, expect, test } from "bun:test";
import {
  aiSdkProvider,
  responsesRequest,
  textStream,
  unsupportedBeforeProviderInvocationCases,
  unsupportedEnvelope,
} from "../../_test/openai-responses.test-support";
import { createServer } from "../server";

describe("OpenAI Responses routes", () => {
  for (const scenario of unsupportedBeforeProviderInvocationCases) {
    test(`Given ${scenario.name} When POST is requested Then unsupported feature is returned before provider invocation`, async () => {
      let invoked = false;
      const provider = aiSdkProvider(() => {
        invoked = true;
        return textStream([]);
      });
      const app = await createServer({
        config: { providers: {} },
        providerInstances: [provider],
      });

      const response = await app.request("/v1/responses", {
        body: JSON.stringify(scenario.body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual(unsupportedEnvelope(scenario.feature));
      expect(invoked).toBe(false);
    });
  }

  test("Given forbidden built-in tool When POST is requested Then unsupported feature is returned", async () => {
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: "web_search_preview" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope("web_search_preview"));
    expect(invoked).toBe(false);
  });

  test("Given stored response id When GET is requested Then retrieval is unsupported", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request("/v1/responses/resp-1");

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope("response_retrieval"));
  });

  test("Given malformed JSON When POST is requested Then invalid request is returned before provider invocation", async () => {
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    const response = await app.request("/v1/responses", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

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
