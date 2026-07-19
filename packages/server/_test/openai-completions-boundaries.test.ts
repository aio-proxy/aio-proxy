import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AiSdkProviderInstance, createAiSdkProvider, REQUEST_BODY_LIMITS } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";

import { chatRequest, mockModelsDevCatalog, restoreFetch, textStream } from "./openai-completions.test-support";

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe("POST /v1/chat/completions", () => {
  test("Given ai-sdk provider package is missing When non-stream completion is posted Then OpenAI error is actionable 503", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "provider_not_installed",
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy provider install @vendor/missing-provider',
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider package is missing When stream completion is posted Then OpenAI error is actionable 503", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "provider_not_installed",
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy provider install @vendor/missing-provider',
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider returns generic error When non-stream completion is posted Then OpenAI error hides provider id", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        throw new Error("model exploded");
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = JSON.parse(text);

    // Then
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "model exploded",
        type: "invalid_request_error",
      },
    });
    expect(text).not.toContain("mock-ai");
  });

  test("Given no matching alias When completion is posted Then returns 404 OpenAI error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, model: "missing-model" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "model_not_found",
        message: "Model not found: missing-model",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given oversized content-length When completion is posted Then rejects before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: "{}",
      headers: {
        "content-length": String(REQUEST_BODY_LIMITS.encoded + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: "request_too_large",
        message: "Request body too large",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });
});
