import { expect, test } from "bun:test";

import type { ServerLog } from "../server-log";

import { withRequestLogContext } from "./context";
import { createObservedFetch, logInboundRequest } from "./wire";
import { captureFetch, type FetchCall, inDebugAttempt, waitFor } from "./wire.test-support";

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
  await waitFor(() => logs.length === 2);
  expect(logs).toEqual(
    expect.arrayContaining([
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
    ]),
  );
  expect(logs.find(({ event }) => event === "request.upstream_result")).not.toHaveProperty("body");
  expect(JSON.stringify(logs)).not.toContain(responseSentinel);
});

test("debug request snapshots do not delay the upstream fetch", async () => {
  const logs: ServerLog[] = [];
  let baseCalls = 0;
  let releasePull: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        releasePull = () => {
          controller.close();
          resolve();
        };
      });
    },
  });
  const request = new Request("https://upstream.test/v1/responses", { method: "POST", body });
  const pending = inDebugAttempt(logs, () =>
    createObservedFetch(
      captureFetch([], () => {
        baseCalls += 1;
        return new Response(null, { status: 204 });
      }),
    )(request),
  );

  const returned = await Promise.race([pending, Bun.sleep(50).then(() => undefined)]);
  releasePull?.();

  expect(returned).toBeInstanceOf(Response);
  expect(baseCalls).toBe(1);
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

test("safe exception extraction never invokes constructor or metadata accessors", async () => {
  const logs: ServerLog[] = [];
  let getterCalls = 0;
  const constructor = function HostileError() {};
  Object.defineProperty(constructor, "name", {
    configurable: true,
    get() {
      getterCalls += 1;
      return null;
    },
  });
  const prototype = Object.create(Error.prototype) as object;
  Object.defineProperty(prototype, "constructor", { value: constructor });
  const error = Object.create(prototype) as Error;
  Object.defineProperty(error, "code", {
    get() {
      getterCalls += 1;
      return "accessor-code-sentinel";
    },
  });

  await expect(
    inDebugAttempt(logs, () =>
      createObservedFetch(
        captureFetch([], () => {
          throw error;
        }),
      )("https://upstream.test/v1/responses"),
    ),
  ).rejects.toBe(error);

  expect(getterCalls).toBe(0);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "request.upstream_result",
      outcome: "exception",
      errorType: "Error",
    }),
  );
  expect(logs.filter(({ event }) => event === "request.upstream_result")).toHaveLength(1);
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

  await waitFor(() => logs.length === 1);
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

test("inbound request snapshots do not delay dispatch", async () => {
  const logs: ServerLog[] = [];
  let releasePull: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        releasePull = () => {
          controller.close();
          resolve();
        };
      });
    },
  });
  const request = new Request("https://proxy.test/v1/responses", { method: "POST", body });
  const pending = withRequestLogContext(
    { requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) },
    () => logInboundRequest(request, "openai-response"),
  );

  const result = await Promise.race([pending.then(() => "returned"), Bun.sleep(50).then(() => "blocked")]);
  releasePull?.();

  expect(result).toBe("returned");
});
