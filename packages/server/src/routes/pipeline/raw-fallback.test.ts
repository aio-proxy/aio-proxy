import { describe, expect, test } from "bun:test";

import { jsonRequest, REQUESTED_MODEL, rawProvider, settleRecording } from "../../../_test/pipeline-helpers";
import { attemptsOf, pipeline } from "./test-support";

describe("shared protocol routing pipeline", () => {
  test.each([429, 503])("falls back after raw status %d", async (status) => {
    const bodySecret = `upstream-body-must-not-be-logged-${status}`;
    const primary = rawProvider({
      id: "primary",
      invoke: async () =>
        Response.json({ error: { message: bodySecret } }, { status, headers: { "x-request-id": "upstream-primary" } }),
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
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: "request.provider_attempt_failed",
        requestId: "request-1",
        providerId: "primary",
        statusCode: status,
        failureKind: "response",
        fallback: true,
        upstreamRequestId: "upstream-primary",
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain(bodySecret);
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
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: "request.provider_attempt_failed",
        providerId: "primary",
        statusCode: 400,
        failureKind: "response",
        fallback: false,
      }),
    );
  });

  test("falls back after a raw network throw", async () => {
    const cause = Object.assign(new Error("cause-message-sentinel"), { code: "ECONNREFUSED" });
    const failure = Object.assign(new Error("exception-message-sentinel"), {
      code: "ConnectionRefused",
      cause,
      errno: -61,
      syscall: "connect",
    });
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw failure;
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
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: "request.provider_attempt_failed",
        attemptIndex: 0,
        providerId: "primary",
        statusCode: 502,
        failureKind: "exception",
        fallback: true,
        errorType: "Error",
        exceptionCode: "ConnectionRefused",
        causeCode: "ECONNREFUSED",
        errno: -61,
        syscall: "connect",
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain("exception-message-sentinel");
    expect(JSON.stringify(harness.logs)).not.toContain("cause-message-sentinel");
  });

  test("safe exception logging never invokes code accessors", async () => {
    let getterCalls = 0;
    const failure = new Error("exception-message-sentinel");
    Object.defineProperty(failure, "code", {
      get() {
        getterCalls += 1;
        return "accessor-code-sentinel";
      },
    });
    const primary = rawProvider({
      id: "primary",
      invoke: async () => {
        throw failure;
      },
    });
    const harness = pipeline([primary, rawProvider({ id: "backup" })]);

    const response = await harness.run(jsonRequest({ model: REQUESTED_MODEL }));
    await settleRecording();

    expect(await response.json()).toEqual({ provider: "backup" });
    expect(getterCalls).toBe(0);
    expect(harness.logs).toContainEqual(
      expect.objectContaining({
        event: "request.provider_attempt_failed",
        attemptIndex: 0,
        providerId: "primary",
        failureKind: "exception",
      }),
    );
    expect(JSON.stringify(harness.logs)).not.toContain("exception-message-sentinel");
    expect(JSON.stringify(harness.logs)).not.toContain("accessor-code-sentinel");
  });
});
