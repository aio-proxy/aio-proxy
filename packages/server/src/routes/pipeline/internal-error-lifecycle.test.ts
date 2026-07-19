import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import { defineProtocolAdapter, jsonRequest, REQUESTED_MODEL, rawProvider } from "../../../_test/pipeline-helpers";
import { pipeline } from "./test-support";

describe("shared protocol pipeline internal-error lifecycle", () => {
  test("finishes a pending session before rethrowing an unmapped error", async () => {
    const failure = new Error("unexpected parse failure");
    const provider = rawProvider({ id: "raw" });
    const harness = pipeline([provider], {
      adapter: defineProtocolAdapter(ProviderProtocol.OpenAICompatible, { parseError: failure }),
    });

    await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL }))).rejects.toBe(failure);

    expect(harness.recording.begins).toEqual([{ inboundProtocol: ProviderProtocol.OpenAICompatible }]);
    expect(harness.recording.identities).toEqual([]);
    expect(harness.recording.attempts).toEqual([]);
    expect(harness.recording.finals).toEqual([{ outcome: "failure", errorCode: "internal_error" }]);
    expect(harness.logs).toEqual([
      {
        event: "request.failed",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        path: "/v1/test",
        errorCode: "internal_error",
        errorType: "Error",
      },
    ]);
    expect(provider.calls.raw).toEqual([]);
  });

  test("preserves the current attempt when an unmapped provider error is rethrown", async () => {
    const failure = Object.freeze({ kind: "unexpected-provider-failure" });
    const provider = rawProvider({
      id: "raw",
      invoke: async () => {
        throw failure;
      },
    });
    const harness = pipeline([provider]);

    await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL }))).rejects.toBe(failure);

    expect(harness.recording.attempts).toEqual([
      expect.objectContaining({
        providerId: "raw",
        modelId: "raw-model",
        outcome: "failure",
      }),
    ]);
    expect(harness.recording.finals).toEqual([{ outcome: "failure", errorCode: "internal_error" }]);
    expect(harness.logs).toEqual([
      {
        event: "request.failed",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAICompatible,
        requestedModelId: REQUESTED_MODEL,
        path: "/v1/test",
        errorCode: "internal_error",
        errorType: "Object",
      },
    ]);
  });
});
