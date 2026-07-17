import { createHash } from "node:crypto";
import type { PluginOptionsIdentityDigest, RuntimeIdentityKey } from "./types";

function stable(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Cannot hash cyclic plugin data");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => stable(item, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stable(item, seen)]),
      );
  seen.delete(value);
  return result;
}

export function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

export function pluginOptionsIdentityDigest(value: {
  readonly public: unknown;
  readonly secret: unknown;
}): PluginOptionsIdentityDigest {
  return digest(value) as PluginOptionsIdentityDigest;
}

export function runtimeIdentity(value: unknown): RuntimeIdentityKey {
  return digest(value) as RuntimeIdentityKey;
}
