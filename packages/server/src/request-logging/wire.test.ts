import { expect, test } from "bun:test";

import type { ServerLog } from "../server-log";

import { serverErrorDetails } from "../server-log";
import { withAttemptLogContext, withRequestLogContext } from "./context";
import { createObservedFetch, logInboundRequest } from "./wire";

type FetchCall = {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
};

const ONE_MIB = 1024 * 1024;

function captureFetch(calls: FetchCall[], result: () => Response | Promise<Response>): typeof globalThis.fetch {
  return (async (input, init) => {
    calls.push({ input, init });
    return await result();
  }) as typeof globalThis.fetch;
}

async function inDebugAttempt<T>(logs: ServerLog[], operation: () => Promise<T>): Promise<T> {
  return await withRequestLogContext({ requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) }, () =>
    withAttemptLogContext({ attemptIndex: 2, providerId: "provider-a", modelId: "model-a" }, operation),
  );
}

test("non-debug fetch preserves the original input and init", async () => {
  const calls: FetchCall[] = [];
  const originalRequest = new Request("https://upstream.test/v1/responses");
  const init = { headers: { "x-test": "value" } };

  await createObservedFetch(captureFetch(calls, () => new Response(null, { status: 204 })))(originalRequest, init);

  expect(calls).toEqual([{ input: originalRequest, init }]);
});

test("debug success snapshots the delegated request without cloning the response", async () => {
  const calls: FetchCall[] = [];
  const logs: ServerLog[] = [];
  const responseSentinel = "successful-response-sentinel";
  const response = Response.json(
    { message: responseSentinel },
    { headers: { "x-result": responseSentinel, "content-type": "application/json" } },
  );
  const originalClone = response.clone.bind(response);
  let responseCloneCalls = 0;
  Object.defineProperty(response, "clone", {
    value: () => {
      responseCloneCalls += 1;
      return originalClone();
    },
  });
  const originalRequest = new Request("https://upstream.test/v1/responses?token=request-query-sentinel", {
    method: "POST",
    headers: { authorization: "request-credential-sentinel", "content-type": "application/json" },
    body: JSON.stringify({ model: "model-a", prompt: "request-prompt-sentinel" }),
  });
  const init = { decompress: false } as RequestInit & { readonly decompress: false };

  const returned = await inDebugAttempt(logs, () =>
    createObservedFetch(captureFetch(calls, () => response))(originalRequest, init),
  );

  expect(returned).toBe(response);
  expect(responseCloneCalls).toBe(0);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.input).toBeInstanceOf(Request);
  expect(calls[0]?.input).not.toBe(originalRequest);
  expect(calls[0]?.init).toEqual({ decompress: false });
  expect(logs).toEqual([
    expect.objectContaining({
      event: "request.upstream_snapshot",
      requestId: "request-1",
      attemptIndex: 2,
      providerId: "provider-a",
      modelId: "model-a",
      method: "POST",
      url: "https://upstream.test/v1/responses?token=%5BREDACTED%5D",
    }),
    expect.objectContaining({
      event: "request.upstream_result",
      requestId: "request-1",
      attemptIndex: 2,
      providerId: "provider-a",
      modelId: "model-a",
      outcome: "response",
      statusCode: 200,
      durationMs: expect.any(Number),
      headers: { "content-type": "application/json", "x-result": "[REDACTED]" },
    }),
  ]);
  expect(logs[1]).not.toHaveProperty("body");
  expect(JSON.stringify(logs)).not.toContain(responseSentinel);
});

test("debug non-2xx bounds the cloned snapshot and leaves the returned body readable", async () => {
  const calls: FetchCall[] = [];
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

test("debug exceptions log only bounded own data properties", async () => {
  const logs: ServerLog[] = [];
  const messageSentinel = "exception-message-sentinel";
  const causeMessageSentinel = "cause-message-sentinel";
  const cause = Object.assign(new Error(causeMessageSentinel), { code: "CauseRefused" });
  const error = Object.assign(Object.create(Error.prototype) as Error & Record<string, unknown>, {
    code: "ConnectionRefused",
    cause,
    errno: -61,
    syscall: "connect",
  });
  Object.defineProperty(error, "message", { get: () => messageSentinel });

  await expect(
    inDebugAttempt(logs, () =>
      createObservedFetch(
        captureFetch([], () => {
          throw error;
        }),
      )("https://upstream.test/v1/responses"),
    ),
  ).rejects.toBe(error);

  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_result",
      outcome: "exception",
      errorType: "Error",
      exceptionCode: "ConnectionRefused",
      causeType: "Error",
      causeCode: "CauseRefused",
      errno: -61,
      syscall: "connect",
    }),
  );
  expect(logs.filter(({ event }) => event === "request.upstream_result")).toHaveLength(1);
  expect(JSON.stringify(logs)).not.toContain(messageSentinel);
  expect(JSON.stringify(logs)).not.toContain(causeMessageSentinel);
});

test("safe exception extraction never invokes accessors", () => {
  let getterCalls = 0;
  const error = new Error("accessor-message-sentinel");
  Object.defineProperty(error, "code", {
    get() {
      getterCalls += 1;
      return "accessor-code-sentinel";
    },
  });

  expect(serverErrorDetails(error)).toEqual({ errorType: "Error" });
  expect(getterCalls).toBe(0);
});

test("inbound snapshots use only the active debug request scope", async () => {
  const logs: ServerLog[] = [];
  const request = new Request("https://proxy.test/v1/responses?api_key=inbound-query-sentinel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "model-a", prompt: "inbound-prompt-sentinel" }),
  });

  await logInboundRequest(request.clone(), "openai-response");
  await withRequestLogContext({ requestId: "quiet", debug: false, logger: (entry) => logs.push(entry) }, () =>
    logInboundRequest(request.clone(), "openai-response"),
  );
  await withRequestLogContext({ requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) }, () =>
    logInboundRequest(request.clone(), "openai-response"),
  );

  expect(logs).toEqual([
    expect.objectContaining({
      event: "request.inbound_snapshot",
      requestId: "request-1",
      inboundProtocol: "openai-response",
      method: "POST",
      url: "https://proxy.test/v1/responses?api_key=%5BREDACTED%5D",
    }),
  ]);
  expect(JSON.stringify(logs)).not.toContain("inbound-query-sentinel");
  expect(JSON.stringify(logs)).not.toContain("inbound-prompt-sentinel");
});
