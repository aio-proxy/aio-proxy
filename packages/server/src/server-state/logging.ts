import { createLogger, isLoggingConfigured } from "@aio-proxy/logger";

import { createPluginLogSink, createServerLogSink } from "../logging/bridge";

const fallbackLogSink = (entry: unknown): void => console.error(JSON.stringify(entry));

export const defaultLogger = createServerLogSink(createLogger(["aio-proxy", "server"]), {
  isConfigured: isLoggingConfigured,
  fallback: fallbackLogSink,
});

export const defaultPluginLogger = createPluginLogSink(
  (context) => createLogger(["aio-proxy", "plugin", context.plugin ?? "unknown"], { bindings: context }),
  { isConfigured: isLoggingConfigured, fallback: fallbackLogSink },
);
