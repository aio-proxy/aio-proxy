import type { ServerLog } from "../server-log";

import { withAttemptLogContext, withRequestLogContext } from "./context";

export type FetchCall = {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
};

export function captureFetch(calls: FetchCall[], result: () => Response | Promise<Response>): typeof globalThis.fetch {
  return (async (input, init) => {
    calls.push({ input, init });
    return await result();
  }) as typeof globalThis.fetch;
}

export async function inDebugAttempt<T>(logs: ServerLog[], operation: () => Promise<T>): Promise<T> {
  return await withRequestLogContext({ requestId: "request-1", debug: true, logger: (entry) => logs.push(entry) }, () =>
    withAttemptLogContext({ attemptIndex: 2, providerId: "provider-a", modelId: "model-a" }, operation),
  );
}

export async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_500;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for diagnostic event");
    await Bun.sleep(1);
  }
}
