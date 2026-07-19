import { asRecord } from "./payload-shape";

export async function isSignatureInvalidResponse(response: Response, signal?: AbortSignal): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const payload = asRecord(await response.clone().json());
    throwIfAborted(signal);
    if (payload === undefined) return false;
    return (
      containsSignatureError(Reflect.get(payload, "error")) || containsSignatureError(Reflect.get(payload, "message"))
    );
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

function containsSignatureError(value: unknown): boolean {
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return (
      normalized.includes("thoughtsignature") ||
      normalized.includes("thought_signature") ||
      normalized.includes("invalid signature")
    );
  }
  if (Array.isArray(value)) return value.some(containsSignatureError);
  const object = asRecord(value);
  return object !== undefined && Object.values(object).some(containsSignatureError);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason: unknown = signal.reason;
  throw reason ?? new DOMException("The operation was aborted", "AbortError");
}
