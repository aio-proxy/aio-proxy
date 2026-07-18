import { expect, test } from "bun:test";
import { anthropicMessagesAdapter, Router } from "@aio-proxy/core";
import type { TokenCountCapability } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { createRecording } from "../../_test/pipeline-helpers/recording";
import { LogicalSessionStore } from "../logical-session-store";
import type { ProviderRouteSource, RuntimeProviderInstance } from "../runtime";
import { handleTokenCount } from "./token-count";

test("rejects oversized Content-Length and cancels the count request body before parsing", async () => {
  let cancelled = false;
  const request = new Request("https://proxy.test/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-length": String(8 * 1_024 * 1_024 + 1), "content-type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  });
  const fixture = countFixture([]);

  const response = await runCount(fixture.source, request);

  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(request.bodyUsed).toBe(true);
  expect(fixture.recording.begins).toEqual([]);
  expect(fixture.releases()).toBe(0);
});

test("releases the retained count body after a provider returns a real count", async () => {
  const request = anthropicRequest();
  const fixture = countFixture([
    countProvider(async ({ request: replay }) => {
      expect(await replay.json()).toEqual({
        max_tokens: 16,
        messages: [{ content: "hello", role: "user" }],
        model: "count-model",
      });
      return { inputTokens: 5 };
    }),
  ]);

  const response = await runCount(fixture.source, request);

  expect(await response.json()).toEqual({ input_tokens: 5 });
  expect(request.bodyUsed).toBe(true);
});

test("releases the retained count body after returning an estimate", async () => {
  const request = anthropicRequest();
  const fixture = countFixture([
    countProvider(async () => {
      throw new Error("counter unavailable");
    }),
  ]);

  const response = await runCount(fixture.source, request);

  expect(response.headers.get("x-aio-proxy-token-count-estimated")).toBe("true");
  expect(request.bodyUsed).toBe(true);
});

function countFixture(providers: readonly RuntimeProviderInstance[]) {
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

function countProvider(countTokens: TokenCountCapability["countTokens"]): RuntimeProviderInstance {
  return {
    alias: { "count-model": { model: "count-wire", preserve: false } },
    enabled: true,
    id: "counter",
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

function anthropicRequest(): Request {
  return new Request("https://proxy.test/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "count-model",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}
