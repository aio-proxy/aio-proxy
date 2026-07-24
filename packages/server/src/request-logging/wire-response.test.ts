import { expect, test } from "bun:test";

import type { ServerLog } from "../server-log";

import { withAttemptLogContext, withRequestLogContext } from "./context";
import { createObservedFetch } from "./wire";
import { captureFetch, inDebugAttempt, waitFor } from "./wire.test-support";

const ONE_MIB = 1024 * 1024;

test("hostile response status cannot change fetch behavior", async () => {
  const logs: ServerLog[] = [];
  const response = new Response(null, { status: 204 });
  Object.defineProperty(response, "status", {
    get() {
      throw new Error("status-accessor-sentinel");
    },
  });

  const returned = await inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch([], () => response))("https://upstream.test/v1/responses"),
  );

  expect(returned).toBe(response);
  expect(logs).toContainEqual(expect.objectContaining({ event: "request.upstream_result", outcome: "response" }));
  expect(logs.filter(({ event }) => event === "request.upstream_result")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain("status-accessor-sentinel");
});

test("debug non-2xx bounds the cloned snapshot and leaves the returned body readable", async () => {
  const calls = [];
  const logs: ServerLog[] = [];
  const sentinel = "failure-response-sentinel";
  const upstreamFailureBody = `${sentinel}${"x".repeat(ONE_MIB)}`;
  const response = new Response(upstreamFailureBody, {
    status: 502,
    headers: { "content-type": "application/json", "x-error": sentinel },
  });
  const originalClone = response.clone.bind(response);
  let responseCloneCalls = 0;
  Object.defineProperty(response, "clone", {
    value: () => {
      responseCloneCalls += 1;
      return originalClone();
    },
  });

  const returned = await inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch(calls, () => response))("https://upstream.test/v1/responses"),
  );

  expect(returned).toBe(response);
  expect(responseCloneCalls).toBe(1);
  expect(await returned.text()).toBe(upstreamFailureBody);
  await waitFor(() => logs.some(({ event }) => event === "request.upstream_result"));
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_result",
      outcome: "response",
      statusCode: 502,
      headers: { "content-type": "application/json", "x-error": "[REDACTED]" },
      body: { mediaType: "application/json", atLeastByteLength: ONE_MIB + 1, omitted: "oversized" },
    }),
  );
  expect(JSON.stringify(logs)).not.toContain(sentinel);
});

test("debug non-2xx retains no diagnostic bytes beyond the limit", async () => {
  const logs: ServerLog[] = [];
  const sentinel = "oversized-chunk-sentinel";
  const oversized = new TextEncoder().encode(JSON.stringify({ message: `${sentinel}${"x".repeat(ONE_MIB)}` }));
  let cancelled = false;
  const cloneBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oversized);
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response("returned-body", { status: 502 });
  Object.defineProperty(response, "clone", {
    value: () =>
      ({ status: 502, headers: new Headers({ "content-type": "application/json" }), body: cloneBody }) as Response,
  });

  const returned = await inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch([], () => response))("https://upstream.test/v1/responses"),
  );

  expect(cancelled).toBeTrue();
  expect(await returned.text()).toBe("returned-body");
  await waitFor(() => logs.some(({ event }) => event === "request.upstream_result"));
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_result",
      outcome: "response",
      body: { mediaType: "application/json", atLeastByteLength: ONE_MIB + 1, omitted: "oversized" },
    }),
  );
  expect(JSON.stringify(logs)).not.toContain(sentinel);
  expect(JSON.stringify(logs)).not.toContain(String(oversized.byteLength));
});

test("slow non-2xx diagnostics do not delay the returned response", async () => {
  const logs: ServerLog[] = [];
  let releasePull: (() => void) | undefined;
  const response = new Response("returned-body", { status: 503 });
  Object.defineProperty(response, "clone", {
    value: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => {
              releasePull = () => {
                controller.close();
                resolve();
              };
            });
          },
        }),
        { status: 503 },
      ),
  });

  const pending = inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch([], () => response))("https://upstream.test/v1/responses"),
  );
  const returned = await Promise.race([pending, Bun.sleep(50).then(() => undefined)]);
  releasePull?.();

  expect(returned).toBe(response);
});

test("stalled non-2xx diagnostics emit one correlated metadata result and cancel", async () => {
  const logs: ServerLog[] = [];
  let cancelled = false;
  let releasePull: (() => void) | undefined;
  const response = new Response("returned-body", { status: 503 });
  Object.defineProperty(response, "clone", {
    value: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            return new Promise<void>((resolve) => {
              releasePull = () => {
                if (!cancelled) controller.close();
                resolve();
              };
            });
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      ),
  });
  let resolveResult!: () => void;
  const resultLogged = new Promise<void>((resolve) => {
    resolveResult = resolve;
  });
  const release = () => {
    const current = releasePull;
    releasePull = undefined;
    current?.();
  };

  const pending = withRequestLogContext(
    {
      requestId: "request-eventual",
      debug: true,
      logger: (entry) => {
        logs.push(entry);
        if (entry.event === "request.upstream_result") resolveResult();
      },
    },
    () =>
      withAttemptLogContext({ attemptIndex: 4, providerId: "slow", modelId: "slow-model" }, () =>
        createObservedFetch(captureFetch([], () => response))("https://upstream.test/v1/responses"),
      ),
  );
  const returned = await Promise.race([pending, Bun.sleep(50).then(() => undefined)]);
  if (returned === undefined) release();
  const completed = await Promise.race([resultLogged.then(() => true), Bun.sleep(1_500).then(() => false)]);
  release();

  expect(returned).toBe(response);
  expect(completed).toBeTrue();
  expect(cancelled).toBeTrue();
  expect(logs.filter(({ event }) => event === "request.upstream_result")).toEqual([
    expect.objectContaining({
      requestId: "request-eventual",
      attemptIndex: 4,
      providerId: "slow",
      modelId: "slow-model",
      outcome: "response",
      statusCode: 503,
      body: { mediaType: "application/json", omitted: "unreadable" },
    }),
  ]);
});
