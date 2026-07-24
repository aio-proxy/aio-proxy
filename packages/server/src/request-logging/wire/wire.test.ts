import { expect, test } from "bun:test";

import type { ServerLog } from "../../server-log";

import { createObservedFetch } from ".";
import { captureFetch, type FetchCall, inDebugAttempt, reconstructed, terminals } from "../test-support";

test("non-debug fetch preserves the original input and init", async () => {
  const calls: FetchCall[] = [];
  const originalRequest = new Request("https://upstream.test/v1/responses");
  const init = { headers: { "x-test": "value" } };

  await createObservedFetch(captureFetch(calls, () => new Response(null, { status: 204 })))(originalRequest, init);

  expect(calls).toEqual([{ input: originalRequest, init }]);
});

test("debug fetch logs complete delegated request and consumed response", async () => {
  const logs: ServerLog[] = [];
  const delegatedBodies: string[] = [];
  const fetcher = createObservedFetch((async (input, init) => {
    if (!(input instanceof Request)) throw new TypeError("expected observed Request");
    expect(init).toEqual({ decompress: false });
    delegatedBodies.push(await input.text());
    return new Response('{"output":"response-visible"}', {
      headers: { "content-type": "application/json", "x-result": "visible-header" },
    });
  }) as typeof globalThis.fetch);

  const response = await inDebugAttempt(logs, () =>
    fetcher(
      new Request("https://upstream.test/v1/responses?token=visible-query", {
        method: "POST",
        headers: {
          authorization: "Bearer hidden",
          "content-type": "application/json",
          "x-observable": "visible-header",
        },
        body: '{"input":"request-visible","token":"body-visible"}',
      }),
      { decompress: false } as RequestInit & { readonly decompress: false },
    ),
  );

  expect(await response.text()).toBe('{"output":"response-visible"}');
  expect(delegatedBodies).toEqual(['{"input":"request-visible","token":"body-visible"}']);
  expect(reconstructed(logs, "upstream_request")).toBe('{"input":"request-visible","token":"body-visible"}');
  expect(reconstructed(logs, "upstream_response")).toBe('{"output":"response-visible"}');
  expect(terminals(logs, "upstream_request")).toEqual([
    expect.objectContaining({ outcome: "complete", attemptIndex: 2 }),
  ]);
  expect(terminals(logs, "upstream_response")).toEqual([
    expect.objectContaining({ outcome: "complete", attemptIndex: 2 }),
  ]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_snapshot",
      url: "https://upstream.test/v1/responses?token=visible-query",
      headers: expect.objectContaining({ authorization: "[REDACTED]", "x-observable": "visible-header" }),
    }),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_result",
      outcome: "response",
      headers: expect.objectContaining({ "x-result": "visible-header" }),
    }),
  );
});

test("debug fetch preserves the thrown transport error", async () => {
  const logs: ServerLog[] = [];
  const failure = Object.assign(new Error("offline"), { code: "ConnectionRefused" });

  await expect(
    inDebugAttempt(logs, () =>
      createObservedFetch((async () => {
        throw failure;
      }) as typeof globalThis.fetch)("https://upstream.test/v1/responses"),
    ),
  ).rejects.toBe(failure);

  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_result",
      outcome: "exception",
      exceptionCode: "ConnectionRefused",
    }),
  );
});
