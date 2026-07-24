import type { HttpRequestSnapshot, HttpResponseSnapshot } from "./snapshot";

import { logServerEvent, serverErrorDetails } from "../server-log";
import { currentDebugRequestLogScope } from "./context";
import { snapshotRequest, snapshotResponse } from "./snapshot";
import { requestBodyMetadataOnly } from "./snapshot-body";

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
      queueRequestSnapshot(request, (snapshot) =>
        logServerEvent(scope.logger, {
          event: "request.upstream_snapshot",
          requestId: scope.requestId,
          attemptIndex: scope.attemptIndex,
          providerId: scope.providerId,
          modelId: scope.modelId,
          ...snapshot,
        }),
      );

      const decompress = (init as BunFetchInit | undefined)?.decompress;
      const response = await fetcher(request, decompress === undefined ? undefined : { decompress });
      const durationMs = performance.now() - startedAt;
      queueResponseSnapshot(response, (responseSnapshot) =>
        logServerEvent(scope.logger, {
          event: "request.upstream_result",
          requestId: scope.requestId,
          attemptIndex: scope.attemptIndex,
          providerId: scope.providerId,
          modelId: scope.modelId,
          durationMs,
          outcome: "response",
          ...responseSnapshot,
        }),
      );
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
  queueRequestSnapshot(request, (snapshot) =>
    logServerEvent(scope.logger, {
      event: "request.inbound_snapshot",
      requestId: scope.requestId,
      inboundProtocol,
      ...snapshot,
    }),
  );
}

async function safeRequestSnapshot(request: Request): Promise<HttpRequestSnapshot> {
  try {
    const metadataOnly = requestBodyMetadataOnly(request.headers);
    return await snapshotRequest(metadataOnly === undefined && request.body !== null ? request.clone() : request);
  } catch {
    return { method: "[UNREADABLE]", url: "[UNREADABLE]", headers: {}, body: { omitted: "unreadable" } };
  }
}

async function safeResponseSnapshot(response: Response): Promise<HttpResponseSnapshot> {
  try {
    return await snapshotResponse(response);
  } catch {
    return { statusCode: 0, headers: {}, body: { omitted: "unreadable" } };
  }
}

function queueRequestSnapshot(request: Request, emit: (snapshot: HttpRequestSnapshot) => void): void {
  void safeRequestSnapshot(request)
    .then(emit)
    .catch(() => undefined);
}

function queueResponseSnapshot(response: Response, emit: (snapshot: HttpResponseSnapshot) => void): void {
  let diagnostic: Response;
  try {
    diagnostic = response.status >= 200 && response.status < 300 ? response : response.clone();
  } catch {
    emit({ statusCode: 0, headers: {}, body: { omitted: "unreadable" } });
    return;
  }
  void safeResponseSnapshot(diagnostic)
    .then(emit)
    .catch(() => undefined);
}
