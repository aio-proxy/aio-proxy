import { isPlainObject } from "es-toolkit/predicate";
import { createHash } from "node:crypto";

export type ConfigRecord = Record<string, unknown>;

export function parseConfig(bytes: Uint8Array | null): ConfigRecord {
  if (bytes === null || bytes.byteLength === 0) return {};
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isPlainObject(value)) throw new Error("Config root must be an object");
  return value;
}

export function encodeCandidate(candidate: ConfigRecord): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(candidate, undefined, 2)}\n`);
}

function stable(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new Error("Cannot digest a cyclic provider entry");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => stable(item, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, stable(item, seen)]),
      );
  seen.delete(value);
  return result;
}

export function digestProviderEntry(entry: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(entry)))
    .digest("hex");
}
