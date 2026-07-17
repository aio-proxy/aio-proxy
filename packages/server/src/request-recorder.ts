import type { RequestAttemptLog, RequestLogStore } from "@aio-proxy/core/db";
import type { RequestOutcome, UsageRow } from "@aio-proxy/types";
import {
  logServerEvent,
  type RequestRecorderPersistenceFailedLog,
  type ServerLogSink,
  serverErrorType,
} from "./server-log";
import type { UsageCompletion } from "./usage-capture";

const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const UNPARSED_REQUESTED_MODEL_ID = "<unparsed>";

export type RequestRecorder = {
  readonly begin: (input: { readonly inboundProtocol: string; readonly requestedModelId?: string }) => RequestSession;
};

export type RequestAttemptInput = Omit<RequestAttemptLog, "index">;

export type RequestFinishInput = {
  readonly outcome: RequestOutcome;
  readonly attempt?: RequestAttemptInput;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
  readonly errorCode?: string;
  readonly usage?: UsageRow;
};

export type RequestSession = {
  readonly requestId: string;
  readonly identify: (input: { readonly requestedModelId: string }) => void;
  readonly attempt: (input: RequestAttemptInput) => void;
  readonly finish: (input: RequestFinishInput) => boolean;
  readonly finishFrom: (
    attempt: Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode">,
    completion: Promise<UsageCompletion>,
  ) => void;
};

export function createRequestRecorder(options: {
  readonly store: RequestLogStore;
  readonly now?: () => Date;
  readonly logger?: ServerLogSink;
}): RequestRecorder {
  const now = options.now ?? (() => new Date());
  let lastPrunedAt = now();
  persistSafely(() => options.store.prune(new Date(lastPrunedAt.getTime() - RETENTION_MS)), options.logger, {
    operation: "prune",
  });

  return {
    begin(input) {
      const current = now();
      if (current.getTime() - lastPrunedAt.getTime() >= PRUNE_INTERVAL_MS) {
        lastPrunedAt = current;
        persistSafely(() => options.store.prune(new Date(current.getTime() - RETENTION_MS)), options.logger, {
          operation: "prune",
        });
      }

      const requestId = crypto.randomUUID();
      const startedAt = current;
      const attempts: RequestAttemptLog[] = [];
      let requestedModelId = input.requestedModelId ?? UNPARSED_REQUESTED_MODEL_ID;
      let identified = input.requestedModelId !== undefined;
      let state: "pending" | "async-owned" | "finished" = "pending";

      const complete = (finish: RequestFinishInput): void => {
        state = "finished";
        if (finish.attempt !== undefined) {
          attempts.push({ ...finish.attempt, index: attempts.length });
        }
        const completedAt = now();
        const base = {
          requestId,
          inboundProtocol: input.inboundProtocol,
          requestedModelId,
          ...(finish.finalProviderId === undefined ? {} : { finalProviderId: finish.finalProviderId }),
          ...(finish.finalModelId === undefined ? {} : { finalModelId: finish.finalModelId }),
          ...(finish.finalStatusCode === undefined ? {} : { finalStatusCode: finish.finalStatusCode }),
          ...(finish.errorCode === undefined ? {} : { errorCode: finish.errorCode }),
          attempts,
          startedAt,
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
        };
        persistSafely(
          () => {
            if (finish.outcome === "success" && finish.usage !== undefined) {
              options.store.insertFinal({
                ...base,
                outcome: "success",
                finalProviderId: finish.finalProviderId ?? finish.usage.providerId,
                finalModelId: finish.finalModelId ?? finish.usage.modelId,
                usage: finish.usage,
              });
            } else if (finish.outcome === "success") {
              options.store.insertFinal({ ...base, outcome: "success" });
            } else {
              options.store.insertFinal({ ...base, outcome: finish.outcome });
            }
          },
          options.logger,
          { operation: "insert_final", requestId },
        );
      };

      const session: RequestSession = {
        requestId,
        identify(identity) {
          if (state !== "pending") return;
          if (!identified) {
            requestedModelId = identity.requestedModelId;
            identified = true;
            return;
          }
          if (requestedModelId === identity.requestedModelId) return;
          if (options.logger !== undefined) {
            logServerEvent(options.logger, {
              event: "request.recorder_invariant",
              requestId,
              invariant: "requested_model_conflict",
            });
          }
        },
        attempt(attempt) {
          if (state === "pending") {
            attempts.push({ ...attempt, index: attempts.length });
          }
        },
        finish(finish) {
          if (state !== "pending") return false;
          complete(finish);
          return true;
        },
        finishFrom(attempt, completion) {
          if (state !== "pending") return;
          state = "async-owned";
          void completion.then(
            (terminal) => {
              if (state !== "async-owned") return;
              const statusCode = "statusCode" in terminal ? terminal.statusCode : undefined;
              const errorCode = terminal.outcome === "failure" ? terminal.errorCode : undefined;
              complete({
                outcome: terminal.outcome,
                finalProviderId: attempt.providerId,
                finalModelId: attempt.modelId,
                ...(statusCode === undefined ? {} : { finalStatusCode: statusCode }),
                ...(errorCode === undefined ? {} : { errorCode }),
                attempt: {
                  ...attempt,
                  outcome: terminal.outcome,
                  ...(statusCode === undefined ? {} : { statusCode }),
                  ...(errorCode === undefined ? {} : { errorCode }),
                },
                ...(terminal.outcome === "success" && terminal.usage !== undefined ? { usage: terminal.usage } : {}),
              });
            },
            () => {
              if (state !== "async-owned") return;
              complete({
                outcome: "failure",
                finalProviderId: attempt.providerId,
                finalModelId: attempt.modelId,
                attempt: { ...attempt, outcome: "failure" },
              });
            },
          );
        },
      };
      return session;
    },
  };
}

function persistSafely(
  task: () => void,
  logger: ServerLogSink | undefined,
  failure: Omit<RequestRecorderPersistenceFailedLog, "errorType" | "event">,
): void {
  try {
    task();
  } catch (error) {
    if (logger !== undefined) {
      logServerEvent(logger, {
        event: "request.recorder_persistence_failed",
        ...failure,
        errorType: serverErrorType(error),
      });
    }
  }
}
