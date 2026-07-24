import type { Logger, LogBindings, LogLevel } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { ServerLog } from "../../server-log";

import { createPluginLogSink, createServerLogSink, SERVER_LOG_LEVEL } from ".";
import { withAttemptLogContext, withRequestLogContext } from "../../request-logging";

type LogCall = {
  readonly level: LogLevel;
  readonly messageOrProps: string | LogBindings;
  readonly propsOrMessage: string | LogBindings | undefined;
};

function fakeLogger(calls: LogCall[]): Logger {
  const emit =
    (level: LogLevel): Logger[LogLevel] =>
    (messageOrProps, propsOrMessage) =>
      calls.push({ level, messageOrProps, propsOrMessage });

  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    child: () => fakeLogger(calls),
  };
}

test("createServerLogSink forwards the complete entry at the mapped level", () => {
  const calls: LogCall[] = [];
  const sink = createServerLogSink(fakeLogger(calls));
  const entries: readonly ServerLog[] = [
    { event: "config.reload_failed", stage: "parse", error: "invalid config" },
    {
      event: "request.failed",
      requestId: "failed",
      inboundProtocol: "openai",
      path: "/v1/responses",
      errorCode: "internal_error",
      errorType: "Error",
    },
    {
      event: "request.provider_attempt_failed",
      requestId: "attempt",
      inboundProtocol: "openai-response",
      requestedModelId: "requested-model",
      path: "/v1/responses",
      providerId: "provider",
      providerKind: "api",
      modelId: "provider-model",
      protocol: "openai-response",
      durationMs: 42,
      statusCode: 500,
      failureKind: "response",
      fallback: true,
      upstreamRequestId: "upstream-request",
    },
    {
      event: "request.recorder_persistence_failed",
      operation: "insert_final",
      requestId: "persistence",
      errorType: "DatabaseError",
    },
    {
      event: "request.rejected",
      requestId: "rejected",
      inboundProtocol: "openai",
      path: "/v1/responses",
      statusCode: 400,
      errorCode: "invalid_request",
      errorType: "ValidationError",
    },
    { event: "request.recorder_invariant", requestId: "invariant", invariant: "requested_model_conflict" },
    {
      event: "request.feature_downgraded",
      requestId: "downgraded",
      inboundProtocol: "openai",
      requestedModelId: "model",
      path: "/v1/responses",
      feature: "background",
      action: "dropped",
      effectiveMode: "synchronous",
    },
  ];

  for (const entry of entries) sink(entry);

  expect(calls).toEqual(
    entries.map((entry) => ({
      level: SERVER_LOG_LEVEL[entry.event],
      messageOrProps: entry,
      propsOrMessage: undefined,
    })),
  );
});

test("createPluginLogSink preserves the structured redacted entry", () => {
  const calls: LogCall[] = [];
  const sink = createPluginLogSink((context) => {
    expect(context).toBe(entry.context);
    return fakeLogger(calls);
  });
  const entry = {
    event: "plugin.load_failed",
    code: "PLUGIN_LOAD_FAILED",
    context: { plugin: "@example/plugin", capability: "chat", providerId: "provider" },
    error: {
      name: "Error",
      message: "token=[REDACTED]",
      stack: "Error: token=[REDACTED]",
    },
  } as const;

  sink(entry);

  expect(calls).toEqual([{ level: "error", messageOrProps: entry, propsOrMessage: undefined }]);
});

test("logging bridges overwrite spoofed correlation with the active attempt", () => {
  const serverCalls: LogCall[] = [];
  const pluginCalls: LogCall[] = [];
  const serverSink = createServerLogSink(fakeLogger(serverCalls));
  const pluginContext = { plugin: "@example/plugin", providerId: "spoofed-context" } as const;
  const pluginSink = createPluginLogSink((context) => {
    expect(context).toBe(pluginContext);
    return fakeLogger(pluginCalls);
  });
  const correlation = {
    requestId: "trusted-request",
    attemptIndex: 3,
    providerId: "trusted-provider",
    modelId: "trusted-model",
  } as const;

  withRequestLogContext({ requestId: correlation.requestId, debug: false, logger: () => {} }, () =>
    withAttemptLogContext(correlation, () => {
      serverSink({
        event: "request.provider_attempt_failed",
        requestId: "spoofed-request",
        inboundProtocol: "openai-response",
        requestedModelId: "requested-model",
        path: "/v1/responses",
        providerId: "spoofed-provider",
        providerKind: "api",
        modelId: "spoofed-model",
        durationMs: 42,
        failureKind: "response",
        fallback: false,
      });
      pluginSink({
        event: "plugin.load_failed",
        code: "PLUGIN_LOAD_FAILED",
        context: pluginContext,
        error: { name: "Error", message: "failed" },
        requestId: "spoofed-request",
        attemptIndex: 99,
        providerId: "spoofed-provider",
        modelId: "spoofed-model",
      });
    }),
  );

  for (const call of [...serverCalls, ...pluginCalls]) {
    expect(call.messageOrProps).toMatchObject(correlation);
  }
});

test("createServerLogSink falls back until logging is configured without duplicate output", () => {
  const calls: LogCall[] = [];
  const fallbacks: ServerLog[] = [];
  let configured = false;
  const sink = createServerLogSink(fakeLogger(calls), {
    isConfigured: () => configured,
    fallback: (entry) => fallbacks.push(entry),
  });
  const entry = {
    event: "config.reload_failed",
    stage: "parse",
    error: "invalid config",
  } as const;

  withRequestLogContext({ requestId: "trusted", debug: false, logger: () => {} }, () =>
    withAttemptLogContext({ attemptIndex: 1, providerId: "provider", modelId: "model" }, () => sink(entry)),
  );
  configured = true;
  sink(entry);

  expect(fallbacks).toEqual([
    { ...entry, requestId: "trusted", attemptIndex: 1, providerId: "provider", modelId: "model" },
  ]);
  expect(calls).toEqual([{ level: "error", messageOrProps: entry, propsOrMessage: undefined }]);
});

test("createPluginLogSink falls back until logging is configured without creating a logger", () => {
  const calls: LogCall[] = [];
  const fallbacks: Parameters<ReturnType<typeof createPluginLogSink>>[0][] = [];
  let configured = false;
  let loggerCreations = 0;
  const sink = createPluginLogSink(
    () => {
      loggerCreations += 1;
      return fakeLogger(calls);
    },
    {
      isConfigured: () => configured,
      fallback: (entry) => fallbacks.push(entry),
    },
  );
  const entry = {
    event: "plugin.load_failed",
    code: "PLUGIN_LOAD_FAILED",
    context: { plugin: "@example/plugin" },
    error: { name: "Error", message: "token=[REDACTED]" },
  } as const;

  withRequestLogContext({ requestId: "trusted", debug: false, logger: () => {} }, () =>
    withAttemptLogContext({ attemptIndex: 1, providerId: "provider", modelId: "model" }, () => sink(entry)),
  );
  configured = true;
  sink(entry);

  expect(fallbacks).toEqual([
    { ...entry, requestId: "trusted", attemptIndex: 1, providerId: "provider", modelId: "model" },
  ]);
  expect(loggerCreations).toBe(1);
  expect(calls).toEqual([{ level: "error", messageOrProps: entry, propsOrMessage: undefined }]);
});
