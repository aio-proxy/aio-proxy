import type { HttpRequestSnapshot, SafeBodySnapshot } from "./request-logging/snapshot";

export type ConfigReloadLog = {
  readonly error: string;
  readonly event: "config.reload_failed";
  readonly stage: "parse" | "providers" | "router" | "alias-collision";
};

export type DashboardAuthUnavailableLog = {
  readonly error: string;
  readonly errorType: string;
  readonly event: "dashboard.auth_unavailable";
};

export type RequestRejectedLog = {
  readonly event: "request.rejected";
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly path: string;
  readonly statusCode: number;
  readonly errorCode: string;
  readonly errorType: string;
  readonly issues?: readonly {
    readonly code: string;
    readonly path: readonly (string | number)[];
  }[];
};

export type SafeExceptionLog = {
  readonly errorType?: string;
  readonly exceptionCode?: string;
  readonly causeType?: string;
  readonly causeCode?: string;
  readonly errno?: string | number;
  readonly syscall?: string;
};

export type RequestProviderAttemptFailedLog = {
  readonly event: "request.provider_attempt_failed";
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly requestedModelId: string;
  readonly path: string;
  readonly providerId: string;
  readonly providerKind: string;
  readonly modelId: string;
  readonly protocol?: string;
  readonly durationMs: number;
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly failureKind: "response" | "exception";
  readonly fallback: boolean;
  readonly upstreamRequestId?: string;
} & SafeExceptionLog;

export type RequestInboundSnapshotLog = {
  readonly event: "request.inbound_snapshot";
  readonly requestId: string;
  readonly inboundProtocol: string;
} & HttpRequestSnapshot;

export type RequestUpstreamSnapshotLog = {
  readonly event: "request.upstream_snapshot";
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly providerId: string;
  readonly modelId: string;
} & HttpRequestSnapshot;

type RequestUpstreamResultBase = {
  readonly event: "request.upstream_result";
  readonly requestId: string;
  readonly attemptIndex: number;
  readonly providerId: string;
  readonly modelId: string;
  readonly durationMs: number;
};

export type RequestUpstreamResultLog = RequestUpstreamResultBase &
  (
    | {
        readonly outcome: "response";
        readonly statusCode: number;
        readonly headers: Readonly<Record<string, string>>;
        readonly body?: SafeBodySnapshot;
      }
    | ({ readonly outcome: "exception" } & SafeExceptionLog)
  );

export type RequestFailedLog = {
  readonly event: "request.failed";
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly path: string;
  readonly errorCode: "internal_error";
  readonly errorType: string;
};

export type RequestRecorderInvariantLog = {
  readonly event: "request.recorder_invariant";
  readonly requestId: string;
  readonly invariant: "requested_model_conflict";
};

export type RequestFeatureDowngradedLog = {
  readonly event: "request.feature_downgraded";
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly requestedModelId: string;
  readonly path: string;
  readonly feature: "background";
  readonly action: "dropped";
  readonly effectiveMode: "synchronous";
};

export type RequestRecorderPersistenceFailedLog = {
  readonly event: "request.recorder_persistence_failed";
  readonly operation: "insert_final" | "prune";
  readonly requestId?: string;
  readonly errorType: string;
};

export type ServerLog =
  | ConfigReloadLog
  | DashboardAuthUnavailableLog
  | RequestFailedLog
  | RequestFeatureDowngradedLog
  | RequestInboundSnapshotLog
  | RequestProviderAttemptFailedLog
  | RequestRecorderInvariantLog
  | RequestRecorderPersistenceFailedLog
  | RequestRejectedLog
  | RequestUpstreamResultLog
  | RequestUpstreamSnapshotLog;

export type ServerLogSink = (entry: ServerLog) => void;

export function logServerEvent(logger: ServerLogSink, entry: ServerLog): void {
  try {
    logger(entry);
  } catch {}
}

export function serverErrorType(error: unknown): string {
  if (typeof error !== "object" || error === null) return typeof error;
  try {
    if (error instanceof Error) {
      const prototype = Object.getPrototypeOf(error);
      const errorConstructor =
        prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      const errorType = typeof errorConstructor === "function" ? ownString(errorConstructor, "name") : undefined;
      return errorType === undefined || errorType === "" ? "Error" : errorType;
    }
  } catch {}
  return "Object";
}

const MAX_ERROR_DETAIL_CHARACTERS = 512;

export function serverErrorDetails(error: unknown): SafeExceptionLog {
  const details: SafeExceptionLog = { errorType: serverErrorType(error).slice(0, MAX_ERROR_DETAIL_CHARACTERS) };
  if (typeof error !== "object" || error === null) return details;
  const exceptionCode = ownString(error, "code");
  const cause = ownValue(error, "cause");
  const causeCode = cause === undefined || cause === null ? undefined : ownString(cause, "code");
  const errno = ownStringOrFiniteNumber(error, "errno");
  const syscall = ownString(error, "syscall");
  return {
    ...details,
    ...(exceptionCode === undefined ? {} : { exceptionCode }),
    ...(cause === undefined ? {} : { causeType: serverErrorType(cause).slice(0, MAX_ERROR_DETAIL_CHARACTERS) }),
    ...(causeCode === undefined ? {} : { causeCode }),
    ...(errno === undefined ? {} : { errno }),
    ...(syscall === undefined ? {} : { syscall }),
  };
}

function ownValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function ownString(value: unknown, key: string): string | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  const own = ownValue(value, key);
  return typeof own === "string" ? own.slice(0, MAX_ERROR_DETAIL_CHARACTERS) : undefined;
}

function ownStringOrFiniteNumber(value: object, key: string): string | number | undefined {
  const own = ownValue(value, key);
  if (typeof own === "string") return own.slice(0, MAX_ERROR_DETAIL_CHARACTERS);
  return typeof own === "number" && Number.isFinite(own) ? own : undefined;
}
