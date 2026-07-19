import { openAIResponsesAdapter } from "@aio-proxy/core";
import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import {
  defineProviderRouteSource,
  jsonRequest,
  REQUESTED_MODEL,
  rawProvider,
  settleRecording,
} from "../../../_test/pipeline-helpers";
import { handleProtocolRequest } from "./index";

describe("shared protocol pipeline diagnostics", () => {
  test("logs one safe diagnostic when background mode is downgraded", async () => {
    const provider = rawProvider({
      id: "responses",
      modelId: REQUESTED_MODEL,
      protocol: ProviderProtocol.OpenAIResponse,
    });
    const route = defineProviderRouteSource([provider]);

    const response = await handleProtocolRequest({
      adapter: openAIResponsesAdapter,
      context: {},
      rawRequest: jsonRequest({ model: REQUESTED_MODEL, input: "hello", background: true }),
      source: route.source,
    });
    await settleRecording();

    expect(response.status).toBe(200);
    expect(route.logs).toEqual([
      {
        event: "request.feature_downgraded",
        requestId: "request-1",
        inboundProtocol: ProviderProtocol.OpenAIResponse,
        requestedModelId: REQUESTED_MODEL,
        path: "/v1/test",
        feature: "background",
        action: "dropped",
        effectiveMode: "synchronous",
      },
    ]);
    expect(await provider.calls.raw[0]?.json()).toEqual({ model: REQUESTED_MODEL, input: "hello" });
    expect(route.recording.finals).toEqual([expect.objectContaining({ outcome: "success" })]);
  });
});
