import type { Stats } from "node:fs";

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function sameFileSnapshot(before: Stats, after: Stats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs;
}
