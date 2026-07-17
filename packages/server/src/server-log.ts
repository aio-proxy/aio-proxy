export type ConfigReloadLog = {
  readonly error: string;
  readonly event: "config.reload_failed";
  readonly stage: "parse" | "providers" | "router" | "alias-collision";
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
  | RequestFailedLog
  | RequestFeatureDowngradedLog
  | RequestRecorderInvariantLog
  | RequestRecorderPersistenceFailedLog
  | RequestRejectedLog;

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
      return typeof errorConstructor === "function" && errorConstructor.name !== "" ? errorConstructor.name : "Error";
    }
  } catch {}
  return "Object";
}
