import type { LogLevel } from "@aio-proxy/plugin-sdk";

import { getTimeRotatingFileSink } from "@logtape/file";
import { ansiColorFormatter, configure, getConsoleSink, jsonLinesFormatter, type Sink } from "@logtape/logtape";

import { toLogTapeLevel } from "./levels";

export type LoggingConfig = {
  readonly enabled?: boolean;
  readonly dir: string;
  readonly retentionDays?: number;
  readonly level?: LogLevel;
};

const DAY_MS = 24 * 60 * 60 * 1000;
let loggingConfigured = false;

export function isLoggingConfigured(): boolean {
  return loggingConfigured;
}

export async function configureLogging(config: LoggingConfig): Promise<void> {
  const sinkIds = ["console"];
  const sinks: Record<string, Sink> = {
    console: getConsoleSink({
      formatter: process.stderr.isTTY === true ? ansiColorFormatter : jsonLinesFormatter,
      levelMap: {
        trace: "error",
        debug: "error",
        info: "error",
        warning: "error",
        error: "error",
        fatal: "error",
      },
    }),
  };

  if (config.enabled === true) {
    sinks["file"] = getTimeRotatingFileSink({
      directory: config.dir,
      formatter: jsonLinesFormatter,
      maxAgeMs: (config.retentionDays ?? 14) * DAY_MS,
    });
    sinkIds.push("file");
  }

  await configure({
    sinks,
    loggers: [
      {
        category: ["aio-proxy"],
        lowestLevel: toLogTapeLevel(config.level ?? "info"),
        sinks: sinkIds,
      },
      { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
    ],
  });
  loggingConfigured = true;
}
