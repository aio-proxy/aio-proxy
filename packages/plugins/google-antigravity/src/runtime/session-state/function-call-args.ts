export function canonicalFunctionCallArgs(value: unknown): unknown {
  if (value == null) return {};
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
