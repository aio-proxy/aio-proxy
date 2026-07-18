import { describe, expect, test } from "bun:test";
import { openAICompletionsAdapter } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { defineProviderRouteSource, jsonRequest, REQUESTED_MODEL, rawProvider } from "../../../_test/pipeline-helpers";
import { handleProtocolRequest } from "./index";
import { MAX_BODY_BYTES, pipeline } from "./test-support";

describe("shared protocol pipeline rejection lifecycle", () => {
  test("finishes a request session when Content-Length is rejected", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest("{}", { contentLength: MAX_BODY_BYTES + 1 }));

    expect(response.status).toBe(413);
    expect(harness.context.parseCalls).toBe(0);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.attempts).toEqual([]);
    expect(harness.recording.finals).toEqual([
      { outcome: "failure", finalStatusCode: 413, errorCode: "request_too_large" },
    ]);
    expect(harness.logs).toEqual([
      {
        event: "request.rejected",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        path: "/v1/test",
        statusCode: 413,
        errorCode: "request_too_large",
        errorType: "RequestBodyTooLargeError",
      },
    ]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("finishes a request session when parsing is rejected", async () => {
    const sensitiveMarker = "secret-marker-must-not-be-logged";
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(
      new Request(`http://localhost/v1/test?token=${sensitiveMarker}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `{"secret":"${sensitiveMarker}"`,
      }),
    );

    expect(response.status).toBe(400);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.attempts).toEqual([]);
    expect(harness.recording.finals).toEqual([
      { outcome: "failure", finalStatusCode: 400, errorCode: "invalid_request" },
    ]);
    expect(harness.logs).toEqual([
      {
        event: "request.rejected",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        path: "/v1/test",
        statusCode: 400,
        errorCode: "invalid_request",
        errorType: "SyntaxError",
      },
    ]);
    expect(JSON.stringify(harness.logs)).not.toContain(sensitiveMarker);
    expect(provider.calls.raw).toEqual([]);
  });

  test("identifies and finishes a request session when the model is not found", async () => {
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: "missing" }));

    expect(response.status).toBe(404);
    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([{ requestedModelId: "missing" }]);
    expect(harness.recording.attempts).toEqual([]);
    expect(harness.recording.finals).toEqual([
      { outcome: "failure", finalStatusCode: 404, errorCode: "model_not_found" },
    ]);
    expect(harness.logs).toEqual([
      {
        event: "request.rejected",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        requestedModelId: "missing",
        path: "/v1/test",
        statusCode: 404,
        errorCode: "model_not_found",
        errorType: "RouterModelNotFoundError",
      },
    ]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("finishes a request session when streamed parsing exceeds the body limit", async () => {
    const provider = rawProvider({ id: "raw", modelId: REQUESTED_MODEL });
    const route = defineProviderRouteSource([provider]);
    let chunks = 0;

    const response = await handleProtocolRequest({
      adapter: openAICompletionsAdapter,
      context: {},
      rawRequest: new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(new Uint8Array(1_024 * 1_024));
            if (chunks === 9) controller.close();
          },
        }),
      }),
      source: route.source,
    });

    expect(response.status).toBe(413);
    expect(route.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(route.recording.attempts).toEqual([]);
    expect(route.recording.finals).toEqual([
      { outcome: "failure", finalStatusCode: 413, errorCode: "request_too_large" },
    ]);
    expect(route.logs).toEqual([
      {
        event: "request.rejected",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        path: "/v1/chat/completions",
        statusCode: 413,
        errorCode: "request_too_large",
        errorType: "RequestBodyTooLargeError",
      },
    ]);
    expect(provider.calls.raw).toEqual([]);
  });
});
