import type { ProtocolRequestDiagnostic } from "@aio-proxy/core";

import type { RequestAttemptInput, RequestSession } from "../../request-recorder";
import type { ProviderRouteSource } from "../../runtime";

import { logServerEvent, serverErrorDetails, serverErrorType } from "../../server-log";

const UPSTREAM_REQUEST_ID_HEADERS = ["x-request-id", "request-id"] as const;
const SAFE_UPSTREAM_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,255}$/u;

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

export function logProviderAttemptFailed(options: {
  readonly source: ProviderRouteSource;
  readonly session: RequestSession;
  readonly rawRequest: Request;
  readonly inboundProtocol: string;
  readonly requestedModelId: string;
  readonly attemptIndex: number;
  readonly attempt: RequestAttemptInput;
  readonly failureKind: "response" | "exception";
  readonly fallback: boolean;
  readonly response?: Response;
  readonly error?: unknown;
}): void {
  const upstreamRequestId = options.response === undefined ? undefined : safeUpstreamRequestId(options.response);
  logServerEvent(options.source.logger, {
    event: "request.provider_attempt_failed",
    requestId: options.session.requestId,
    inboundProtocol: options.inboundProtocol,
    requestedModelId: options.requestedModelId,
    path: new URL(options.rawRequest.url).pathname,
    attemptIndex: options.attemptIndex,
    providerId: options.attempt.providerId,
    providerKind: options.attempt.providerKind,
    modelId: options.attempt.modelId,
    ...(options.attempt.protocol === undefined ? {} : { protocol: options.attempt.protocol }),
    durationMs: options.attempt.durationMs,
    ...(options.attempt.statusCode === undefined ? {} : { statusCode: options.attempt.statusCode }),
    ...(options.attempt.errorCode === undefined ? {} : { errorCode: options.attempt.errorCode }),
    failureKind: options.failureKind,
    fallback: options.fallback,
    ...(options.failureKind === "exception" ? serverErrorDetails(options.error) : {}),
    ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
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

function safeUpstreamRequestId(response: Response): string | undefined {
  for (const header of UPSTREAM_REQUEST_ID_HEADERS) {
    const value = response.headers.get(header)?.trim();
    if (value !== undefined && SAFE_UPSTREAM_REQUEST_ID.test(value)) return value;
  }
  return undefined;
}
