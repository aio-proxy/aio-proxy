import type { LogLevel } from "@aio-proxy/plugin-sdk";

export type LogTapeLevel = "debug" | "info" | "warning" | "error";

export function toLogTapeLevel(level: LogLevel): LogTapeLevel {
  return level === "warn" ? "warning" : level;
}
