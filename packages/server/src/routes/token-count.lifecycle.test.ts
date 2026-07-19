import { expect, test } from "bun:test";
import { anthropicMessagesAdapter, Router } from "@aio-proxy/core";
import type { TokenCountCapability } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { createRecording } from "../../_test/pipeline-helpers/recording";
import { LogicalSessionStore } from "../logical-session-store";
import type { ProviderRouteSource, RuntimeProviderInstance } from "../runtime";
import { handleTokenCount } from "./token-count";

test("releases the retained body when count request validation fails", async () => {
  const request = new Request("https://proxy.test/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "count-model", max_tokens: 16, messages: "invalid" }),
  });
  const fixture = countSource([]);

  const response = await runCount(fixture.source, request);

  expect(response.status).toBe(400);
  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.begins).toEqual([]);
  expect(fixture.releases()).toBe(0);
});

const abortReasons = [
  ["Error", new Error("client cancelled")],
  ["DOMException", new DOMException("client cancelled", "AbortError")],
  ["non-Error", { code: "client_cancelled" }],
] as const;

test.each(
  abortReasons,
)("preserves an exact %s reason without calling a counter when pre-aborted", async (_type, reason) => {
  const controller = new AbortController();
  const request = anthropicRequest(controller.signal);
  controller.abort(reason);
  let calls = 0;
  const fixture = countSource([
    countProvider(async () => {
      calls += 1;
      return { inputTokens: 5 };
    }),
  ]);

  const result = await settleWithin(runCount(fixture.source, request), 100);

  expect(result).toBe(reason);
  expect(calls).toBe(0);
  expect(fixture.recording.attempts).toEqual([]);
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  expect(fixture.releases()).toBe(1);
});

test("does not return success when the request aborts while a counter ignores its signal", async () => {
  const controller = new AbortController();
  const reason = new Error("client cancelled during count");
  const started = deferred<void>();
  const release = deferred<void>();
  const fixture = countSource([
    countProvider(async () => {
      started.resolve(undefined);
      await release.promise;
      return { inputTokens: 5 };
    }),
  ]);

  const response = runCount(fixture.source, anthropicRequest(controller.signal));
  await started.promise;
  controller.abort(reason);
  release.resolve(undefined);
  const result = await settleWithin(response, 100);

  expect(result).toBe(reason);
  expect(fixture.recording.attempts).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty("statusCode");
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  expect(fixture.recording.finals[0]).not.toHaveProperty("finalStatusCode");
  expect(fixture.releases()).toBe(1);
});

test("attributes an abort-dominant counter error only to the provider that was invoked", async () => {
  const controller = new AbortController();
  const abortReason = new Error("client cancelled first count");
  const counterError = new Error("first counter failed after abort");
  let secondCalls = 0;
  const fixture = countSource([
    countProvider(async () => {
      controller.abort(abortReason);
      throw counterError;
    }, "first"),
    countProvider(async () => {
      secondCalls += 1;
      return { inputTokens: 9 };
    }, "second"),
  ]);

  const result = await settleWithin(runCount(fixture.source, anthropicRequest(controller.signal)), 100);

  expect(result).toBe(abortReason);
  expect(secondCalls).toBe(0);
  expect(fixture.recording.attempts).toEqual([
    expect.objectContaining({ modelId: "first-wire", outcome: "cancelled", providerId: "first" }),
  ]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty("statusCode");
  expect(fixture.recording.finals).toEqual([
    expect.objectContaining({ finalModelId: "first-wire", finalProviderId: "first", outcome: "cancelled" }),
  ]);
  expect(fixture.recording.finals[0]).not.toHaveProperty("finalStatusCode");
  expect(fixture.releases()).toBe(1);
});

test.each(abortReasons)("maps no fake provider error for an exact %s abort reason", async (_type, reason) => {
  const controller = new AbortController();
  const started = deferred<void>();
  const release = deferred<void>();
  const fixture = countSource([
    countProvider(async () => {
      started.resolve(undefined);
      await release.promise;
      throw reason;
    }),
  ]);

  const response = runCount(fixture.source, anthropicRequest(controller.signal));
  await started.promise;
  controller.abort(reason);
  release.resolve(undefined);
  const result = await settleWithin(response, 100);

  expect(result).toBe(reason);
  expect(fixture.recording.attempts).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  expect(fixture.recording.attempts[0]).not.toHaveProperty("statusCode");
  expect(fixture.recording.finals).toEqual([expect.objectContaining({ outcome: "cancelled" })]);
  expect(fixture.recording.finals[0]).not.toHaveProperty("finalStatusCode");
  expect(fixture.releases()).toBe(1);
});

function countSource(providers: readonly RuntimeProviderInstance[]) {
  const router = new Router(providers);
  const recording = createRecording();
  let releaseCount = 0;
  const source = {
    acquireProviderSnapshot: () => ({
      snapshot: { providers, router },
      release: () => {
        releaseCount += 1;
      },
    }),
    currentProviderSnapshot: () => ({ providers, router }),
    logicalSessionStore: new LogicalSessionStore(),
    requestRecorder: recording.recorder,
    usageCapture: {
      passthrough(): never {
        throw new Error("token counting must not capture generation usage");
      },
      stream(): never {
        throw new Error("token counting must not capture generation usage");
      },
    },
  } satisfies ProviderRouteSource;
  return { recording, releases: () => releaseCount, source };
}

function countProvider(countTokens: TokenCountCapability["countTokens"], id = "counter"): RuntimeProviderInstance {
  return {
    alias: { "count-model": { model: `${id}-wire`, preserve: false } },
    enabled: true,
    id,
    kind: ProviderKind.OAuth,
    model: {
      invoke() {
        throw new Error("generation must not run during token counting");
      },
      supportsProviderTool: () => true,
    },
    tokenCount: { countTokens },
  };
}

function runCount(source: ProviderRouteSource, rawRequest: Request): Promise<Response> {
  return handleTokenCount({
    adapter: anthropicMessagesAdapter,
    context: {},
    format: (inputTokens) => ({ input_tokens: inputTokens }),
    rawRequest,
    source,
  });
}

function anthropicRequest(signal: AbortSignal): Request {
  return new Request("https://proxy.test/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "count-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
    signal,
  });
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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
