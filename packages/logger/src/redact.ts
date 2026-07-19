const REDACTED = "[REDACTED]";

export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
  const activeSecrets = secrets.filter((secret) => secret.length > 0);
  if (activeSecrets.length === 0) return value;
  return redact(value, activeSecrets, new WeakMap<object, unknown>()) as T;
}

function redact(value: unknown, secrets: readonly string[], seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") {
    return secrets.reduce((redacted, secret) => redacted.replaceAll(secret, REDACTED), value);
  }
  if (value === null || typeof value !== "object") return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (value instanceof Date) return value;
  if (value instanceof Error) {
    const redacted = new Error(redact(value.message, secrets, seen) as string);
    seen.set(value, redacted);
    redacted.name = value.name;
    redacted.cause = redact(value.cause, secrets, seen);
    return redacted;
  }
  if (Array.isArray(value)) {
    const redacted: unknown[] = [];
    seen.set(value, redacted);
    for (const item of value) redacted.push(redact(item, secrets, seen));
    return redacted;
  }

  const redacted: Record<string, unknown> = {};
  seen.set(value, redacted);
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = redact(child, secrets, seen);
  }
  return redacted;
}
