const REDACTED = "[REDACTED]";
const CIRCULAR = "[Circular]";

class UnsafeLogValueError extends Error {}

export function redactLogText(text: string, secretValues: readonly string[]): string {
  return redactText(text, activeSecrets(secretValues));
}

export function redactLogValue(value: unknown, secretValues: readonly string[]): unknown {
  const secrets = activeSecrets(secretValues);
  if (secrets.length === 0) return value;

  try {
    return redact(value, secrets, new WeakSet<object>());
  } catch {
    return redactionFailure(secrets);
  }
}

function activeSecrets(secretValues: readonly string[]): readonly string[] {
  return [...new Set(secretValues.filter((secret) => secret.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
}

function redactText(text: string, secrets: readonly string[]): string {
  const marker = safeMarker(REDACTED, secrets);
  let redacted = text;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, marker);
  return redacted;
}

function safeMarker(preferred: string, secrets: readonly string[]): string {
  return secrets.some((secret) => preferred.includes(secret)) ? "" : preferred;
}

function redactionFailure(secrets: readonly string[]): Record<string, unknown> {
  if (secrets.some((secret) => "message".includes(secret))) return {};
  return { message: redactText("log redaction failed", secrets) };
}

function redact(value: unknown, secrets: readonly string[], seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return safeMarker(CIRCULAR, secrets);

  seen.add(value);
  try {
    if (value instanceof Error) return redactError(value, secrets, seen);
    if (Array.isArray(value)) return redactArray(value, secrets, seen);
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      return redactObject(value, secrets, seen);
    }
    throw new UnsafeLogValueError("unsupported log value");
  } finally {
    seen.delete(value);
  }
}

function redactError(error: Error, secrets: readonly string[], seen: WeakSet<object>): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(error);
  assertNoEnumerableAccessors(descriptors);

  const output: Record<string, unknown> = {
    name: redactDescriptorString(descriptors.name, "Error", secrets),
    message: redactDescriptorString(descriptors.message, "", secrets),
  };
  const stack = redactOptionalDescriptor(descriptors.stack, secrets, seen);
  if (stack !== undefined) output.stack = stack;
  const cause = redactOptionalDescriptor(descriptors.cause, secrets, seen);
  if (cause !== undefined) output.cause = cause;

  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || key === "name" || key === "message" || key === "stack" || key === "cause") continue;
    if (!("value" in descriptor)) throw new UnsafeLogValueError("accessor log property");
    output[redactText(key, secrets)] = redact(descriptor.value, secrets, seen);
  }
  return output;
}

function redactArray(array: readonly unknown[], secrets: readonly string[], seen: WeakSet<object>): unknown[] {
  const descriptors = Object.getOwnPropertyDescriptors(array);
  assertNoEnumerableAccessors(descriptors);

  const output: unknown[] = [];
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new UnsafeLogValueError("accessor log property");
    if (!/^\d+$/u.test(key)) throw new UnsafeLogValueError("unsupported array property");
    output[Number(key)] = redact(descriptor.value, secrets, seen);
  }
  return output;
}

function redactObject(object: object, secrets: readonly string[], seen: WeakSet<object>): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(object);
  assertNoEnumerableAccessors(descriptors);

  const output: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable) continue;
    if (!("value" in descriptor)) throw new UnsafeLogValueError("accessor log property");
    output[redactText(key, secrets)] = redact(descriptor.value, secrets, seen);
  }
  return output;
}

function assertNoEnumerableAccessors(
  descriptors: Readonly<Record<string, PropertyDescriptor>> | readonly PropertyDescriptor[],
): void {
  for (const descriptor of Object.values(descriptors)) {
    if (descriptor.enumerable && !("value" in descriptor)) {
      throw new UnsafeLogValueError("accessor log property");
    }
  }
}

function redactDescriptorString(
  descriptor: PropertyDescriptor | undefined,
  fallback: string,
  secrets: readonly string[],
): string {
  if (descriptor === undefined) return fallback;
  if (!("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new UnsafeLogValueError("invalid Error string property");
  }
  return redactText(descriptor.value, secrets);
}

function redactOptionalDescriptor(
  descriptor: PropertyDescriptor | undefined,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new UnsafeLogValueError("accessor Error property");
  return redact(descriptor.value, secrets, seen);
}
