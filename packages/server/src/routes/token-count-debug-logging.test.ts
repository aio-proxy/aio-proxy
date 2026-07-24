import { expect, test } from "bun:test";

import { currentRequestLogContext } from "../request-logging";
import { waitFor } from "../request-logging/wire.test-support";
import { anthropicRequest, countFixture, provider } from "./token-count.test-support";

test("correlates a token-count provider attempt with its inbound request", async () => {
  let seen: ReturnType<typeof currentRequestLogContext>;
  const fixture = countFixture(
    [
      provider({
        id: "counter",
        tokenCount: async () => {
          seen = currentRequestLogContext();
          return { inputTokens: 4 };
        },
      }),
    ],
    { debugLogging: true },
  );

  await fixture.anthropic();

  expect(seen).toEqual({
    requestId: "request-1",
    attemptIndex: 0,
    providerId: "counter",
    modelId: "counter-wire",
  });
  await waitFor(() => fixture.logs.some(({ event }) => event === "request.inbound_snapshot"));
  expect(fixture.logs).toContainEqual(
    expect.objectContaining({ event: "request.inbound_snapshot", requestId: "request-1" }),
  );
});

test("keeps concurrent token-count request contexts isolated", async () => {
  const bothStarted = deferred<void>();
  const seen = new Map<string, ReturnType<typeof currentRequestLogContext>[]>();
  let started = 0;
  const fixture = countFixture([
    provider({
      id: "counter",
      tokenCount: async ({ request }) => {
        const marker = request.headers.get("x-call") ?? "missing";
        const contexts = [currentRequestLogContext()];
        seen.set(marker, contexts);
        started += 1;
        if (started === 2) bothStarted.resolve(undefined);
        await bothStarted.promise;
        contexts.push(currentRequestLogContext());
        return { inputTokens: 4 };
      },
    }),
  ]);

  await Promise.all([fixture.anthropic(markedRequest("first")), fixture.anthropic(markedRequest("second"))]);

  expect(seen.get("first")).toEqual([
    expect.objectContaining({ requestId: "request-1" }),
    expect.objectContaining({ requestId: "request-1" }),
  ]);
  expect(seen.get("second")).toEqual([
    expect.objectContaining({ requestId: "request-2" }),
    expect.objectContaining({ requestId: "request-2" }),
  ]);
  expect(currentRequestLogContext()).toBeUndefined();
});

function markedRequest(marker: string): Request {
  const request = anthropicRequest();
  request.headers.set("x-call", marker);
  return request;
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
