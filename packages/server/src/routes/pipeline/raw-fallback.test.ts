import { describe, expect, test } from "bun:test";

import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from "../../../_test/pipeline-helpers";
import { attemptsOf, pipeline } from "./test-support";

describe("shared protocol routing pipeline", () => {
  test.each([429, 503])("falls back after raw status %d", async (status) => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => Response.json({ provider: "primary" }, { status }),
    });
    const backup = rawProvider({
      id: "backup",
      invoke: async () => Response.json({ provider: "backup" }),
    });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: status },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "backup", outcome: "success" }),
    );
  });

  test("cancels a raw fallback body even when cleanup rejects", async () => {
    let cancelCalls = 0;
    const primary = rawProvider({
      id: "primary",
      invoke: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalls += 1;
              throw new Error("cleanup failed");
            },
          }),
          { status: 503 },
        ),
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(cancelCalls).toBe(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 503 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });

  test("does not fall back after an ordinary raw 400 response", async () => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => Response.json({ provider: "primary" }, { status: 400 }),
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ provider: "primary" });
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(0);
    expect(attemptsOf(harness.recording)).toEqual([{ outcome: "failure", providerId: "primary", statusCode: 400 }]);
    expect(harness.recording.finals[0]).toEqual(
      expect.objectContaining({ finalProviderId: "primary", finalStatusCode: 400, outcome: "failure" }),
    );
  });

  test("falls back after a raw network throw", async () => {
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw new Error("network down");
      },
    });
    const backup = rawProvider({ id: "backup" });
    const harness = pipeline([primary, backup]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(primary.calls.raw).toHaveLength(1);
    expect(backup.calls.raw).toHaveLength(1);
    expect(attemptsOf(harness.recording)).toEqual([
      { outcome: "failure", providerId: "primary", statusCode: 502 },
      { outcome: "success", providerId: "backup", statusCode: 200 },
    ]);
  });
});
