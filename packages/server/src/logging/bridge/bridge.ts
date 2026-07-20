import type { PluginLogSink } from "@aio-proxy/core";
import type { Logger, LogLevel } from "@aio-proxy/plugin-sdk";

import type { ServerLog, ServerLogSink } from "../../server-log";

export const SERVER_LOG_LEVEL = {
  "config.reload_failed": "error",
  "request.failed": "error",
  "request.feature_downgraded": "info",
  "request.recorder_invariant": "warn",
  "request.recorder_persistence_failed": "error",
  "request.rejected": "warn",
} as const satisfies Readonly<Record<ServerLog["event"], LogLevel>>;

type SinkFallbackOptions<Entry> = {
  readonly isConfigured: () => boolean;
  readonly fallback: (entry: Entry) => void;
};

export function createServerLogSink(logger: Logger, options?: SinkFallbackOptions<ServerLog>): ServerLogSink {
  return (entry) => {
    if (options !== undefined && !options.isConfigured()) {
      options.fallback(entry);
      return;
    }
    logger[SERVER_LOG_LEVEL[entry.event]](entry);
  };
}

type PluginLogEntry = Parameters<PluginLogSink>[0];

export function createPluginLogSink(
  createLogger: (context: PluginLogEntry["context"]) => Logger,
  options?: SinkFallbackOptions<PluginLogEntry>,
): PluginLogSink {
  return (entry) => {
    if (options !== undefined && !options.isConfigured()) {
      options.fallback(entry);
      return;
    }
    createLogger(entry.context).error(entry);
  };
}
