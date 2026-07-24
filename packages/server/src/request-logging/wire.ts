import type { HttpRequestSnapshot, HttpResponseSnapshot } from "./snapshot";

import { logServerEvent, serverErrorDetails } from "../server-log";
import { currentDebugRequestLogScope } from "./context";
import { snapshotRequest, snapshotResponse } from "./snapshot";

type BunFetchInit = RequestInit & { readonly decompress?: boolean };

export function createObservedFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const scope = currentDebugRequestLogScope();
    if (
      scope === undefined ||
      scope.attemptIndex === undefined ||
      scope.providerId === undefined ||
      scope.modelId === undefined
    ) {
      return fetcher(input, init);
    }

    const startedAt = performance.now();
    try {
      const request = new Request(input, init);
      const snapshot = await safeRequestSnapshot(request);
      logServerEvent(scope.logger, {
        event: "request.upstream_snapshot",
        requestId: scope.requestId,
        attemptIndex: scope.attemptIndex,
        providerId: scope.providerId,
        modelId: scope.modelId,
        ...snapshot,
      });

      const decompress = (init as BunFetchInit | undefined)?.decompress;
      const response = await fetcher(request, decompress === undefined ? undefined : { decompress });
      const responseSnapshot = await safeResponseSnapshot(response);
      logServerEvent(scope.logger, {
        event: "request.upstream_result",
        requestId: scope.requestId,
        attemptIndex: scope.attemptIndex,
        providerId: scope.providerId,
        modelId: scope.modelId,
        durationMs: performance.now() - startedAt,
        outcome: "response",
        ...responseSnapshot,
      });
      return response;
    } catch (error) {
      logServerEvent(scope.logger, {
        event: "request.upstream_result",
        requestId: scope.requestId,
        attemptIndex: scope.attemptIndex,
        providerId: scope.providerId,
        modelId: scope.modelId,
        durationMs: performance.now() - startedAt,
        outcome: "exception",
        ...serverErrorDetails(error),
      });
      throw error;
    }
  }) as typeof globalThis.fetch;
}

export async function logInboundRequest(request: Request, inboundProtocol: string): Promise<void> {
  const scope = currentDebugRequestLogScope();
  if (scope === undefined) return;
  const snapshot = await safeRequestSnapshot(request);
  logServerEvent(scope.logger, {
    event: "request.inbound_snapshot",
    requestId: scope.requestId,
    inboundProtocol,
    ...snapshot,
  });
}

async function safeRequestSnapshot(request: Request): Promise<HttpRequestSnapshot> {
  try {
    return await snapshotRequest(request.clone());
  } catch {
    return { method: "[UNREADABLE]", url: "[UNREADABLE]", headers: {}, body: { omitted: "unreadable" } };
  }
}

async function safeResponseSnapshot(response: Response): Promise<HttpResponseSnapshot> {
  try {
    return await snapshotResponse(response.status >= 200 && response.status < 300 ? response : response.clone());
  } catch {
    return { statusCode: 0, headers: {}, body: { omitted: "unreadable" } };
  }
}
