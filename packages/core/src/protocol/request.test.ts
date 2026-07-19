import { expect, test } from "bun:test";
import { RequestBodyTooLargeError, readJsonRequest, rewriteJsonRequestModel } from "./request";

test("rewriteJsonRequestModel preserves unknown fields and removes content-length", async () => {
  const rewritten = await rewriteJsonRequestModel(
    new Request("https://proxy.test/v1/responses", {
      method: "POST",
      headers: { "content-length": "99", "content-type": "application/json" },
      body: JSON.stringify({ model: "client-model", beta_field: { enabled: true } }),
    }),
    "upstream-model",
  );

  expect(rewritten.headers.get("content-length")).toBeNull();
  expect(await rewritten.json()).toEqual({
    model: "upstream-model",
    beta_field: { enabled: true },
  });
});

test("readJsonRequest rejects a chunked body before retaining bytes beyond the limit", async () => {
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        controller.enqueue(new TextEncoder().encode("true}"));
        controller.close();
      },
    }),
  });

  await expect(readJsonRequest(request, 8)).rejects.toBeInstanceOf(RequestBodyTooLargeError);
});

test("readJsonRequest cancels every retained branch when a chunked body exceeds the limit", async () => {
  let resolveCancellation: (reason: unknown) => void = () => {};
  const cancellation = new Promise<unknown>((resolve) => {
    resolveCancellation = resolve;
  });
  let chunks = 0;
  const request = new Request("https://proxy.test/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks < 9) {
          chunks += 1;
          controller.enqueue(new Uint8Array(1_024 * 1_024));
        }
      },
      cancel(reason) {
        resolveCancellation(reason);
      },
    }),
  });

  const result = await settleWithin(readJsonRequest(request), 1_000);
  if (!request.bodyUsed) await request.body?.cancel("test cleanup");

  expect(result).toBeInstanceOf(RequestBodyTooLargeError);
  expect(await settleWithin(cancellation, 100)).not.toBeInstanceOf(TimeoutError);
  expect(request.bodyUsed).toBe(true);
});

class TimeoutError extends Error {}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.catch((error: unknown) => error),
      new Promise<TimeoutError>((resolve) => {
        timeout = setTimeout(() => resolve(new TimeoutError("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
