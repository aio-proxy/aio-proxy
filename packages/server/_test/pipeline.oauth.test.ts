import { describe, expect, test } from "bun:test";
import { PluginRawResolverError, PluginRawTransportError } from "../src/plugin-runtime";
import { attemptsOf, pipeline } from "./pipeline.oauth.test-support";
import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from "./pipeline-helpers";

describe("OAuth plugin raw pipeline", () => {
  test.each(["resolver", "response"] as const)("falls back after a malformed plugin raw %s failure", async (stage) => {
    const base = rawProvider({
      id: "primary",
      invoke: async () => {
        throw new PluginRawTransportError();
      },
    });
    const primary =
      stage === "resolver"
        ? {
            ...base,
            provider: {
              ...base.provider,
              raw: {
                resolve() {
                  throw new PluginRawResolverError();
                },
              },
            },
          }
        : base;
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });
});
