import type { RequestAttemptLog, RequestLogStore } from "@aio-proxy/core/db";
import type { RequestOutcome, UsageRow } from "@aio-proxy/types";
import type { UsageCompletion } from "./usage-capture";

const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RequestRecorder = {
  readonly begin: (input: { readonly inboundProtocol: string; readonly requestedModelId: string }) => RequestSession;
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
  readonly attempt: (input: RequestAttemptInput) => void;
  readonly finish: (input: RequestFinishInput) => void;
  readonly finishFrom: (
    attempt: Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode">,
    completion: Promise<UsageCompletion>,
  ) => void;
};

export function createRequestRecorder(options: {
  readonly store: RequestLogStore;
  readonly now?: () => Date;
  readonly logger?: (error: unknown) => void;
}): RequestRecorder {
  const now = options.now ?? (() => new Date());
  let lastPrunedAt = now();
  safely(() => options.store.prune(new Date(lastPrunedAt.getTime() - RETENTION_MS)), options.logger);

  return {
    begin(input) {
      const current = now();
      if (current.getTime() - lastPrunedAt.getTime() >= PRUNE_INTERVAL_MS) {
        lastPrunedAt = current;
        safely(() => options.store.prune(new Date(current.getTime() - RETENTION_MS)), options.logger);
      }

      const requestId = crypto.randomUUID();
      const startedAt = current;
      const attempts: RequestAttemptLog[] = [];
      let finished = false;

      const session: RequestSession = {
        requestId,
        attempt(attempt) {
          if (!finished) {
            attempts.push({ ...attempt, index: attempts.length });
          }
        },
        finish(finish) {
          if (finished) {
            return;
          }
          finished = true;
          if (finish.attempt !== undefined) {
            attempts.push({ ...finish.attempt, index: attempts.length });
          }
          const completedAt = now();
          const base = {
            requestId,
            inboundProtocol: input.inboundProtocol,
            requestedModelId: input.requestedModelId,
            ...(finish.finalProviderId === undefined ? {} : { finalProviderId: finish.finalProviderId }),
            ...(finish.finalModelId === undefined ? {} : { finalModelId: finish.finalModelId }),
            ...(finish.finalStatusCode === undefined ? {} : { finalStatusCode: finish.finalStatusCode }),
            ...(finish.errorCode === undefined ? {} : { errorCode: finish.errorCode }),
            attempts,
            startedAt,
            completedAt,
            durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
          };
          safely(() => {
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
          }, options.logger);
        },
        finishFrom(attempt, completion) {
          void completion.then(
            (terminal) => {
              const statusCode = "statusCode" in terminal ? terminal.statusCode : undefined;
              const errorCode = terminal.outcome === "failure" ? terminal.errorCode : undefined;
              session.finish({
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
              session.finish({
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

function safely(task: () => void, logger: ((error: unknown) => void) | undefined): void {
  try {
    task();
  } catch (error) {
    try {
      logger?.(error);
    } catch {}
  }
}
