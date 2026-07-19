import type { LogLevel } from "@aio-proxy/plugin-sdk";

import { getTimeRotatingFileSink } from "@logtape/file";
import { configure, getConsoleSink, type Sink } from "@logtape/logtape";

import { toLogTapeLevel } from "./levels";

export type LoggingConfig = {
  readonly enabled?: boolean;
  readonly dir: string;
  readonly retentionDays?: number;
  readonly level?: LogLevel;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function configureLogging(config: LoggingConfig): Promise<void> {
  const sinkIds = ["console"];
  const sinks: Record<string, Sink> = {
    console: getConsoleSink(),
  };

  if (config.enabled === true) {
    sinks.file = getTimeRotatingFileSink({
      directory: config.dir,
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
    ],
  });
}
