import { REQUEST_BODY_LIMITS } from "@aio-proxy/core";
import { expect, test } from "bun:test";

import { snapshotRequest } from "./snapshot";

const BLOCKED = Symbol("blocked");

test("known oversized request bodies are metadata-only without reading", async () => {
  let read = false;
  const request = {
    method: "POST",
    url: "https://upstream.test/v1/responses",
    headers: new Headers({
      "content-length": String(REQUEST_BODY_LIMITS.encoded + 1),
      "content-type": "application/json",
    }),
    body: {},
    async arrayBuffer() {
      read = true;
      return new ArrayBuffer(0);
    },
  } as unknown as Request;

  const snapshot = await snapshotRequest(request);

  expect(read).toBeFalse();
  expect(snapshot.body).toEqual({
    mediaType: "application/json",
    atLeastByteLength: REQUEST_BODY_LIMITS.encoded + 1,
    omitted: "oversized",
  });
});

test("unknown-length request bodies stop at the proxy ceiling and cancel", async () => {
  let cancelled = false;
  const oversized = new Uint8Array(REQUEST_BODY_LIMITS.encoded + 123);
  let emitted = false;
  let releasePull: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted) {
        return new Promise<void>((resolve) => {
          releasePull = () => {
            if (!cancelled) controller.close();
            resolve();
          };
        });
      }
      emitted = true;
      controller.enqueue(oversized);
    },
    cancel() {
      cancelled = true;
    },
  });

  const pending = snapshotRequest(
    new Request("https://upstream.test/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
  const snapshot = await Promise.race([pending, Bun.sleep(1_500).then(() => BLOCKED)]);
  releasePull?.();

  expect(snapshot).not.toBe(BLOCKED);
  expect(cancelled).toBeTrue();
  expect(snapshot).toMatchObject({
    body: {
      mediaType: "application/json",
      atLeastByteLength: REQUEST_BODY_LIMITS.encoded + 1,
      omitted: "oversized",
    },
  });
  expect(JSON.stringify(snapshot)).not.toContain(String(oversized.byteLength));
});

test("stalled request snapshots expire and cancel their owned body", async () => {
  let cancelled = false;
  let releasePull: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
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
  });
  const pending = snapshotRequest(new Request("https://upstream.test/v1/responses", { method: "POST", body }));

  const result = await Promise.race([pending, Bun.sleep(1_500).then(() => BLOCKED)]);
  releasePull?.();

  expect(result).not.toBe(BLOCKED);
  expect(cancelled).toBeTrue();
  expect(result).toMatchObject({ body: { omitted: "unreadable" } });
});
