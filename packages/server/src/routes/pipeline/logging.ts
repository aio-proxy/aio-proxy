import type { ProtocolRequestDiagnostic } from "@aio-proxy/core";

import type { RequestSession } from "../../request-recorder";
import type { ProviderRouteSource } from "../../runtime";

import { logServerEvent, serverErrorType } from "../../server-log";

export function logRequestDiagnostics(options: {
  readonly source: ProviderRouteSource;
  readonly session: RequestSession;
  readonly rawRequest: Request;
  readonly inboundProtocol: string;
  readonly requestedModelId: string;
  readonly diagnostics: readonly ProtocolRequestDiagnostic[];
}): void {
  for (const diagnostic of options.diagnostics) {
    logServerEvent(options.source.logger, {
      event: "request.feature_downgraded",
      requestId: options.session.requestId,
      inboundProtocol: options.inboundProtocol,
      requestedModelId: options.requestedModelId,
      path: new URL(options.rawRequest.url).pathname,
      ...diagnostic,
    });
  }
}

export function logRequestFailed(options: {
  readonly source: ProviderRouteSource;
  readonly session: RequestSession;
  readonly rawRequest: Request;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly error: unknown;
}): void {
  logServerEvent(options.source.logger, {
    event: "request.failed",
    requestId: options.session.requestId,
    inboundProtocol: options.inboundProtocol,
    ...(options.requestedModelId === undefined ? {} : { requestedModelId: options.requestedModelId }),
    path: new URL(options.rawRequest.url).pathname,
    errorCode: "internal_error",
    errorType: serverErrorType(options.error),
  });
}

export function logRequestRejected(options: {
  readonly source: ProviderRouteSource;
  readonly session: RequestSession;
  readonly rawRequest: Request;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly statusCode: number;
  readonly errorCode: string;
  readonly error: unknown;
}): void {
  const issues = safeIssues(options.error);
  logServerEvent(options.source.logger, {
    event: "request.rejected",
    requestId: options.session.requestId,
    inboundProtocol: options.inboundProtocol,
    ...(options.requestedModelId === undefined ? {} : { requestedModelId: options.requestedModelId }),
    path: new URL(options.rawRequest.url).pathname,
    statusCode: options.statusCode,
    errorCode: options.errorCode,
    errorType: serverErrorType(options.error),
    ...(issues === undefined ? {} : { issues }),
  });
}

function safeIssues(
  error: unknown,
): readonly { readonly code: string; readonly path: readonly (string | number)[] }[] | undefined {
  if (typeof error !== "object" || error === null || !("issues" in error) || !Array.isArray(error.issues)) {
    return undefined;
  }
  const issues = error.issues.flatMap((issue) => {
    if (typeof issue !== "object" || issue === null || !("code" in issue) || typeof issue.code !== "string") return [];
    if (!("path" in issue) || !Array.isArray(issue.path)) return [];
    const path = issue.path.filter(
      (part): part is string | number => typeof part === "string" || typeof part === "number",
    );
    return [{ code: issue.code, path }];
  });
  return issues.length === 0 ? undefined : issues;
}
