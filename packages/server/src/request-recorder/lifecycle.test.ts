import { expect, test } from "bun:test";
import type { RequestLogStore } from "@aio-proxy/core/db";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { createRequestRecorder, type RequestRecorder, type RequestSession } from "../request-recorder";
import type { UsageCompletion } from "../usage-capture";

type FinalRow = Parameters<RequestLogStore["insertFinal"]>[0];

function memoryStore(): { readonly rows: FinalRow[]; readonly store: RequestLogStore } {
  const rows: FinalRow[] = [];
  return {
    rows,
    store: {
      insertFinal(row) {
        rows.push(row);
      },
      overview() {
        throw new Error("unused");
      },
      prune() {},
    },
  };
}

function beginUnidentified(recorder: RequestRecorder): RequestSession {
  return (recorder.begin as (input: { readonly inboundProtocol: string }) => RequestSession)({
    inboundProtocol: "openai-response",
  });
}

test("uses the unparsed model sentinel when identification never succeeds", () => {
  const memory = memoryStore();
  const session = beginUnidentified(createRequestRecorder({ store: memory.store }));

  session.finish({ outcome: "failure", finalStatusCode: 400, errorCode: "invalid_request" });

  expect(memory.rows).toEqual([
    expect.objectContaining({ requestedModelId: "<unparsed>", outcome: "failure", finalStatusCode: 400 }),
  ]);
});

test("records the requested model identified after parsing", () => {
  const memory = memoryStore();
  const session = beginUnidentified(createRequestRecorder({ store: memory.store }));
  const identify = () =>
    (
      session as RequestSession & { readonly identify: (input: { readonly requestedModelId: string }) => void }
    ).identify({
      requestedModelId: "gpt-5.6-terra",
    });

  expect(identify).not.toThrow();
  session.finish({ outcome: "failure", finalStatusCode: 404, errorCode: "model_not_found" });

  expect(memory.rows).toEqual([
    expect.objectContaining({ requestedModelId: "gpt-5.6-terra", outcome: "failure", finalStatusCode: 404 }),
  ]);
});

test("keeps the first requested model and logs an identification conflict", () => {
  const memory = memoryStore();
  const logs: unknown[] = [];
  const session = beginUnidentified(
    createRequestRecorder({ store: memory.store, logger: (entry) => logs.push(entry) }),
  );

  session.identify({ requestedModelId: "first" });
  session.identify({ requestedModelId: "second" });
  session.finish({ outcome: "failure" });

  expect(memory.rows).toEqual([expect.objectContaining({ requestedModelId: "first" })]);
  expect(logs).toEqual([
    {
      event: "request.recorder_invariant",
      requestId: session.requestId,
      invariant: "requested_model_conflict",
    },
  ]);
});

test("finishFrom claims terminal ownership before asynchronous completion", async () => {
  const memory = memoryStore();
  const session = beginUnidentified(createRequestRecorder({ store: memory.store }));
  let resolveCompletion!: (value: UsageCompletion) => void;
  const completion = new Promise<UsageCompletion>((resolve) => {
    resolveCompletion = resolve;
  });

  session.finishFrom(
    {
      providerId: "provider",
      modelId: "model",
      providerKind: ProviderKind.Api,
      protocol: ProviderProtocol.OpenAIResponse,
      durationMs: 1,
    },
    completion,
  );

  expect(session.finish({ outcome: "failure", errorCode: "internal_error" })).toBe(false);
  expect(memory.rows).toEqual([]);

  resolveCompletion({ outcome: "success" });
  await completion;
  await Promise.resolve();

  expect(memory.rows).toEqual([
    expect.objectContaining({
      outcome: "success",
      finalProviderId: "provider",
      finalModelId: "model",
    }),
  ]);
});

test("logs a sanitized persistence failure without changing request completion", () => {
  const sensitiveMarker = "database-secret-must-not-be-logged";
  const logs: unknown[] = [];
  const store: RequestLogStore = {
    insertFinal() {
      throw new TypeError(sensitiveMarker);
    },
    overview() {
      throw new Error("unused");
    },
    prune() {},
  };
  const session = beginUnidentified(createRequestRecorder({ store, logger: (entry) => logs.push(entry) }));

  expect(session.finish({ outcome: "failure" })).toBe(true);

  expect(logs).toEqual([
    {
      event: "request.recorder_persistence_failed",
      operation: "insert_final",
      requestId: session.requestId,
      errorType: "TypeError",
    },
  ]);
  expect(JSON.stringify(logs)).not.toContain(sensitiveMarker);
});
