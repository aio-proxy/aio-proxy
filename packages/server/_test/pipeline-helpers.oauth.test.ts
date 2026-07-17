import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import { pipeline } from "./pipeline.oauth.test-support";
import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording, textStream } from "./pipeline-helpers";

describe("OAuth pipeline helper capabilities", () => {
  test("uses model capability when the raw resolver returns undefined for a protocol mismatch", async () => {
    const provider = rawProvider({
      id: "hybrid",
      protocol: ProviderProtocol.Anthropic,
      invoke: async () => Response.json({ transport: "raw" }),
      model: { invoke: () => textStream("model") },
    });
    const harness = pipeline([provider]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ output: "model" });
    expect(provider.calls.raw).toHaveLength(0);
    expect(provider.calls.model).toHaveLength(1);
    expect(harness.context.modelInvocationCalls).toBe(1);
    expect(harness.usage.passthrough).toHaveLength(0);
    expect(harness.usage.stream).toHaveLength(1);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "hybrid", outcome: "success" }),
    );
  });
});
