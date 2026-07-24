import { describe, expect, test } from "bun:test";

import { jsonRequest, rawProvider, REQUESTED_MODEL } from "../../../_test/pipeline-helpers";
import { createObservedFetch } from "../../request-logging";
import { waitFor } from "../../request-logging/wire.test-support";
import { pipeline } from "./test-support";

type ObservedCall = {
  delegated?: string | URL | Request;
  upstream?: Request;
};

function observedProvider(id: string, response: () => Response, call: ObservedCall) {
  const observedFetch = createObservedFetch((async (input) => {
    call.delegated = input;
    return response();
  }) as typeof globalThis.fetch);
  return rawProvider({
    id,
    invoke: async (request) => {
      call.upstream = request;
      return await observedFetch(request);
    },
  });
}

describe("shared protocol pipeline debug logging", () => {
  test("scopes inbound and fallback upstream snapshots without logging payloads", async () => {
    const inboundPrompt = "inbound-prompt-sentinel";
    const primaryBody = "primary-upstream-body-sentinel";
    const backupBody = "backup-upstream-body-sentinel";
    const primary = observedProvider(
      "primary",
      () => Response.json({ error: { message: primaryBody } }, { status: 503 }),
      {},
    );
    const backup = observedProvider("backup", () => Response.json({ provider: "backup", message: backupBody }), {});
    const harness = pipeline([primary, backup], { debugLogging: true });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL, prompt: inboundPrompt }));

    expect(await response.json()).toEqual({ provider: "backup", message: backupBody });
    await waitFor(() => harness.logs.filter(({ event }) => event.endsWith("_snapshot")).length === 3);
    expect(harness.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "request.inbound_snapshot", requestId: "request-1" }),
        expect.objectContaining({
          event: "request.upstream_snapshot",
          requestId: "request-1",
          attemptIndex: 0,
          providerId: "primary",
        }),
        expect.objectContaining({
          event: "request.upstream_snapshot",
          requestId: "request-1",
          attemptIndex: 1,
          providerId: "backup",
        }),
      ]),
    );
    const serialized = JSON.stringify(harness.logs);
    expect(serialized).not.toContain(inboundPrompt);
    expect(serialized).not.toContain(primaryBody);
    expect(serialized).not.toContain(backupBody);
  });

  test("info logging preserves fetch input identity and emits only the fallback warning", async () => {
    const primaryCall: ObservedCall = {};
    const backupCall: ObservedCall = {};
    const primary = observedProvider("primary", () => Response.json({ error: true }, { status: 503 }), primaryCall);
    const backup = observedProvider("backup", () => Response.json({ provider: "backup" }), backupCall);
    const harness = pipeline([primary, backup], { debugLogging: false });

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(primaryCall.delegated).toBe(primaryCall.upstream);
    expect(backupCall.delegated).toBe(backupCall.upstream);
    expect(harness.logs).toEqual([
      expect.objectContaining({
        event: "request.provider_attempt_failed",
        providerId: "primary",
        fallback: true,
      }),
    ]);
  });

  test("stalled failure diagnostics cannot delay fallback", async () => {
    let cancelReason: unknown;
    let resolveCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve;
    });
    const primary = observedProvider(
      "primary",
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel(reason) {
              cancelReason = reason;
              resolveCancelled();
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      {},
    );
    const backup = observedProvider("backup", () => Response.json({ provider: "backup" }), {});
    const harness = pipeline([primary, backup], { debugLogging: true });
    const pending = harness.run(jsonRequest({ model: REQUESTED_MODEL }));

    const response = await Promise.race([pending, Bun.sleep(50).then(() => undefined)]);
    const cleanupSettled = await Promise.race([cancelled.then(() => true), Bun.sleep(1_500).then(() => false)]);
    await waitFor(() =>
      harness.logs.some(({ event, statusCode }) => event === "request.upstream_result" && statusCode === 503),
    );

    expect(response).toBeInstanceOf(Response);
    expect(await response?.json()).toEqual({ provider: "backup" });
    expect(cleanupSettled).toBeTrue();
    expect(cancelReason).toEqual(expect.arrayContaining([undefined, "request snapshot deadline exceeded"]));
    expect(harness.logs).toContainEqual(expect.objectContaining({ event: "request.upstream_result", statusCode: 503 }));
  });
});
