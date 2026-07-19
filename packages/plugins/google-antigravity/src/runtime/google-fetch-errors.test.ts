import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { CcaTransport } from "./transport";

import { createAntigravityLanguageModel } from "./google-model";

test("masks non-OK CCA response bodies before the Google codec sees them", async () => {
  const marker = "hostile-upstream-tool-argument";
  const model = createAntigravityLanguageModel(
    "gemini-3-flash-agent",
    fixtureRuntime({
      execute: async () =>
        Response.json(
          { error: { code: 503, message: marker, status: "UNAVAILABLE" }, detail: marker },
          { status: 503 },
        ),
    }),
  );

  const error = await rejected(model.doGenerate(callOptions()));

  expect(Reflect.get(error as object, "statusCode")).toBe(503);
  expect(errorSurface(error)).not.toContain(marker);
  expect(errorSurface(error)).toContain("Google Antigravity request failed");
});

test("preserves a safe 302 status while masking the CCA response body", async () => {
  const marker = "hostile-redirect-location";
  const model = createAntigravityLanguageModel(
    "gemini-3-flash-agent",
    fixtureRuntime({
      execute: async () =>
        Response.json({ error: { code: 302, message: marker, status: "FOUND" }, location: marker }, { status: 302 }),
    }),
  );

  const error = await rejected(model.doGenerate(callOptions()));

  expect(Reflect.get(error as object, "statusCode")).toBe(302);
  expect(errorSurface(error)).not.toContain(marker);
  expect(errorSurface(error)).toContain("Google Antigravity request failed");
});

test.each([204, 304])("maps a null-body CCA stream status %i to a safe 500 failure", async (status) => {
  let calls = 0;
  const model = createAntigravityLanguageModel(
    "gemini-3-flash-agent",
    fixtureRuntime({
      execute: async () => {
        calls += 1;
        return new Response(null, { status });
      },
    }),
  );

  const error = await rejected(model.doStream(callOptions()));

  expect(Reflect.get(error as object, "statusCode")).toBe(500);
  expect(errorSurface(error)).toContain("Google Antigravity request failed");
  expect(calls).toBe(1);
});

test.each([200, 204, 302, 304])("maps a null-body CCA generate status %i to a safe 500 failure", async (status) => {
  let calls = 0;
  const model = createAntigravityLanguageModel(
    "gemini-3-flash-agent",
    fixtureRuntime({
      execute: async () => {
        calls += 1;
        return new Response(null, { status });
      },
    }),
  );

  const error = await rejected(model.doGenerate(callOptions()));

  expect(Reflect.get(error as object, "statusCode")).toBe(500);
  expect(errorSurface(error)).toContain("Google Antigravity request failed");
  expect(calls).toBe(1);
});

test("terminates a Google model stream when CCA errors after model bytes", async () => {
  const marker = "late-stream-secret";
  let cancelled: unknown;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(
        encoder.encode(
          'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ error: { code: 503, message: marker, status: "UNAVAILABLE" } })}\n\n`),
      );
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  const model = createAntigravityLanguageModel(
    "gemini-3-flash-agent",
    fixtureRuntime({
      execute: async () => new Response(source, { headers: { "Content-Type": "text/event-stream" } }),
    }),
  );

  const result = await model.doStream(callOptions());
  const observed = await readUntilFailure(result.stream);

  expect(observed.parts).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "partial" }));
  expect(errorSurface(observed.failure)).not.toContain(marker);
  expect(errorSurface(observed.failure)).toContain("Google Antigravity stream failed");
  expect(cancelled).toBe(observed.failure);
});

test("propagates the exact non-Error caller reason when CCA reading fails after abort", async () => {
  const abort = new AbortController();
  const reason = { kind: "codec-stream-cancelled" };
  const internalFailure = new Error("internal-reader-failure-secret");
  const cancellations: unknown[] = [];
  let releases = 0;
  let calls = 0;
  const source = new ReadableStream<Uint8Array>();
  Object.defineProperty(source, "getReader", {
    value: () => ({
      async read() {
        abort.abort(reason);
        throw internalFailure;
      },
      async cancel(cancelReason?: unknown) {
        cancellations.push(cancelReason);
      },
      releaseLock() {
        releases += 1;
      },
    }),
  });
  const model = createAntigravityLanguageModel(
    "gemini-3-flash-agent",
    fixtureRuntime({
      execute: async () => {
        calls += 1;
        return new Response(source, { headers: { "Content-Type": "text/event-stream" } });
      },
    }),
  );

  const result = await model.doStream({ ...callOptions(), abortSignal: abort.signal });
  const observed = await readUntilFailure(result.stream);

  expect(observed.failure).toBe(reason);
  expect(cancellations).toEqual([reason]);
  expect(releases).toBe(1);
  expect(calls).toBe(1);
  expect(errorSurface(observed.failure)).not.toContain(internalFailure.message);
});

function fixtureRuntime(transport: CcaTransport) {
  return { call: (context: LogicalRequestContext) => ({ context, transport }) };
}

function callOptions() {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    providerOptions: { aioProxy: { logicalRequest: logicalContext() } },
  } as never;
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}

async function rejected(promise: PromiseLike<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to reject");
}

async function readUntilFailure<T>(
  stream: ReadableStream<T>,
): Promise<{ readonly parts: T[]; readonly failure: unknown }> {
  const reader = stream.getReader();
  const parts: T[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const reading = (async () => {
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) throw new Error("Google model stream completed instead of failing");
        parts.push(next.value);
      }
    } catch (failure) {
      return { parts, failure };
    }
  })();
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const reason = new Error("Google model stream did not fail");
      void reader.cancel(reason);
      reject(reason);
    }, 100);
  });
  try {
    return await Promise.race([reading, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function errorSurface(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  return [String(error), Reflect.get(error, "message"), Reflect.get(error, "responseBody"), JSON.stringify(error)].join(
    " ",
  );
}
