import { JSON5, YAML } from "bun";
import { isPlainObject } from "es-toolkit/predicate";
import { createHash } from "node:crypto";
import { extname } from "node:path";

export type ConfigRecord = Record<string, unknown>;
type ConfigExtension = ".json" | ".jsonc" | ".yaml" | ".yml";

function configExtension(path: string): ConfigExtension {
  const extension = extname(path);
  switch (extension) {
    case ".json":
    case ".jsonc":
    case ".yaml":
    case ".yml":
      return extension;
    default:
      throw new Error(`Unsupported config format: ${extension}`);
  }
}

export function parseConfig(bytes: Uint8Array | null, path: string): ConfigRecord {
  const extension = configExtension(path);
  if (bytes === null || bytes.byteLength === 0) return {};
  const text = new TextDecoder().decode(bytes);
  const value: unknown = (() => {
    switch (extension) {
      case ".json":
      case ".jsonc":
        return JSON5.parse(text);
      case ".yaml":
      case ".yml":
        return YAML.parse(text);
    }
  })();
  if (!isPlainObject(value)) throw new Error("Config root must be an object");
  return value;
}

export function encodeCandidate(candidate: ConfigRecord, path: string): Uint8Array {
  const extension = configExtension(path);
  const text = [".yaml", ".yml"].includes(extension)
    ? YAML.stringify(candidate)
    : JSON.stringify(candidate, undefined, 2);
  return new TextEncoder().encode(`${text.trimEnd()}\n`);
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
