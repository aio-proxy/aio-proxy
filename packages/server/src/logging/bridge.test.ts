import type { Logger, LogBindings, LogLevel } from "@aio-proxy/plugin-sdk";

import { expect, test } from "bun:test";

import type { ServerLog } from "../server-log";

import { createPluginLogSink, createServerLogSink, SERVER_LOG_LEVEL } from "./bridge";

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

test("SERVER_LOG_LEVEL maps every server event to its configured level", () => {
  expect(SERVER_LOG_LEVEL).toEqual({
    "config.reload_failed": "error",
    "request.failed": "error",
    "request.feature_downgraded": "info",
    "request.recorder_invariant": "warn",
    "request.recorder_persistence_failed": "error",
    "request.rejected": "warn",
  });
});

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

  sink(entry);
  configured = true;
  sink(entry);

  expect(fallbacks).toEqual([entry]);
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

  sink(entry);
  configured = true;
  sink(entry);

  expect(fallbacks).toEqual([entry]);
  expect(loggerCreations).toBe(1);
  expect(calls).toEqual([{ level: "error", messageOrProps: entry, propsOrMessage: undefined }]);
});
