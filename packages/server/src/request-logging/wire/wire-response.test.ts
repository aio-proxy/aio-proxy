import { expect, test } from "bun:test";

import type { ServerLog } from "../../server-log";

import { createObservedFetch } from ".";
import { captureFetch, inDebugAttempt, reconstructed, terminals } from "../test-support";

test("consumed response emits complete terminal and preserves response metadata", async () => {
  const logs: ServerLog[] = [];
  const source = new Response("complete", { headers: { "content-type": "application/json" }, status: 201 });
  Object.defineProperties(source, {
    redirected: { configurable: true, value: true },
    type: { configurable: true, value: "cors" },
    url: { configurable: true, value: "https://upstream.test/final" },
  });
  const response = await inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch([], () => source))("https://upstream.test/v1"),
  );

  expect(await response.text()).toBe("complete");
  expect(response).not.toBe(source);
  expect(response.status).toBe(201);
  expect(response.redirected).toBeTrue();
  expect(response.type).toBe("cors");
  expect(response.url).toBe("https://upstream.test/final");
  expect(reconstructed(logs, "upstream_response")).toBe("complete");
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "complete", byteLength: 8, sequence: 1 }),
  ]);
});

test("response cancellation reaches the source and emits cancelled", async () => {
  const logs: ServerLog[] = [];
  let reason: unknown;
  const source = new ReadableStream<Uint8Array>({
    cancel(value) {
      reason = value;
    },
  });
  const response = await inDebugAttempt(logs, () =>
    createObservedFetch(
      captureFetch([], () => new Response(source, { headers: { "content-type": "application/json" } })),
    )("https://upstream.test/v1"),
  );

  await response.body?.cancel("client-left");

  expect(reason).toBe("client-left");
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "cancelled", byteLength: 0, sequence: 0 }),
  ]);
});

test("response errors remain observable and emit error terminal", async () => {
  const logs: ServerLog[] = [];
  const failure = new Error("source failed");
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(failure);
    },
  });
  const response = await inDebugAttempt(logs, () =>
    createObservedFetch(
      captureFetch([], () => new Response(source, { headers: { "content-type": "application/json" } })),
    )("https://upstream.test/v1"),
  );

  await expect(response.text()).rejects.toBe(failure);
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "error", errorType: "Error", byteLength: 0, sequence: 0 }),
  ]);
});

test("null and never-consumed responses emit no body events", async () => {
  const logs: ServerLog[] = [];

  await inDebugAttempt(logs, () =>
    createObservedFetch(
      captureFetch([], () => new Response("not-consumed", { headers: { "content-type": "application/json" } })),
    )("https://upstream.test/v1"),
  );
  await inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch([], () => new Response(null, { status: 204 })))("https://upstream.test/v1"),
  );
  await Bun.sleep(0);

  expect(logs.filter((entry) => entry.event === "request.body_chunk")).toHaveLength(0);
  expect(logs.filter((entry) => entry.event === "request.body_terminal")).toHaveLength(0);
});
