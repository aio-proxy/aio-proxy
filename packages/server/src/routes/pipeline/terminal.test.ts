import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from "../../../_test/pipeline-helpers";
import { attemptsOf, pipeline } from "./test-support";

describe("shared protocol routing pipeline", () => {
  test("records inbound abort as cancelled and does not fall back", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new Error("client aborted");
    abortError.name = "AbortError";
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw abortError;
      },
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }, { signal: controller.signal }));

    expect(response.status).toBe(502);
    expect(backup.calls.raw).toHaveLength(0);
    expect(attemptsOf(harness.recording)).toEqual([{ outcome: "cancelled", providerId: "primary", statusCode: 502 }]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "primary", outcome: "cancelled" }),
    );
  });

  test("records an unsupported candidate and continues to the next provider", async () => {
    const unsupported = rawProvider({ id: "unsupported", protocol: ProviderProtocol.Anthropic });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([unsupported, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(unsupported.calls.raw).toHaveLength(0);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "unsupported", statusCode: 501 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });

  test("returns and records the final failure after every candidate fails", async () => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => Response.json({ provider: "primary" }, { status: 503 }),
    });
    const final = rawProvider({
      id: "final",
      invoke: async () => Response.json({ provider: "final" }, { status: 429 }),
    });
    const harness = pipeline([primary, final]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ provider: "final" });
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 503 },
      { outcome: "failure", providerId: "final", statusCode: 429 },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "final", finalStatusCode: 429, outcome: "failure" }),
    );
  });

  test("rethrows an unknown provider value without calling the next candidate", async () => {
    const unknown = { source: "provider" };
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw unknown;
      },
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    await expect(harness.run(jsonRequest({ model: REQUESTED_MODEL }))).rejects.toBe(unknown);

    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(0);
    expect(harness.recording.begins).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: undefined },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ errorCode: "internal_error", outcome: "failure" }),
    );
    expect(harness.recording.finals[0]).not.toHaveProperty("finalProviderId");
    expect(harness.recording.finals[0]).not.toHaveProperty("finalModelId");
  });
});
