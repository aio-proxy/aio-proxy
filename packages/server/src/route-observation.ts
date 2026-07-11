import type { UsageCompletion } from "./usage-capture";

export function isAbortError(error: unknown, seen = new Set<Error>()): boolean {
  if (!(error instanceof Error) || seen.has(error)) {
    return false;
  }
  if (error.name === "AbortError") {
    return true;
  }
  seen.add(error);
  return isAbortError(error.cause, seen);
}

export function isInboundAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted && isAbortError(error);
}

export function terminalCompletion(
  completion: Promise<UsageCompletion>,
  signal: AbortSignal,
): Promise<UsageCompletion> {
  return completion.then((value) =>
    value.outcome === "cancelled" && !signal.aborted ? { outcome: "failure" } : value,
  );
}

export function providerErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Upstream provider error";
}
