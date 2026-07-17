import type {
  RequestAttemptInput,
  RequestFinishInput,
  RequestRecorder,
  RequestSession,
} from "../../src/request-recorder";
import type { UsageCompletion } from "../../src/usage-capture";
import type { Recording } from "./types";

export function createRecording(): Recording & { readonly recorder: RequestRecorder } {
  const begins: Recording["begins"] = [];
  const identities: Recording["identities"] = [];
  const attempts: RequestAttemptInput[] = [];
  const finals: RequestFinishInput[] = [];
  const recorder: RequestRecorder = {
    begin(input) {
      begins.push(input);
      let state: "pending" | "async-owned" | "finished" = "pending";
      const complete = (finish: RequestFinishInput) => {
        state = "finished";
        if (finish.attempt !== undefined) attempts.push(finish.attempt);
        finals.push(finish);
      };
      const session: RequestSession = {
        requestId: `request-${begins.length}`,
        identify(identity) {
          if (state === "pending") identities.push(identity);
        },
        attempt(attempt) {
          if (state === "pending") attempts.push(attempt);
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
              if (state === "async-owned") complete(finishFromTerminal(attempt, terminal));
            },
            () => {
              if (state !== "async-owned") return;
              complete({
                attempt: { ...attempt, outcome: "failure" },
                finalModelId: attempt.modelId,
                finalProviderId: attempt.providerId,
                outcome: "failure",
              });
            },
          );
        },
      };
      return session;
    },
  };
  return { attempts, begins, finals, identities, recorder };
}

function finishFromTerminal(
  attempt: Omit<RequestAttemptInput, "errorCode" | "outcome" | "statusCode">,
  terminal: UsageCompletion,
): RequestFinishInput {
  const statusCode = "statusCode" in terminal ? terminal.statusCode : undefined;
  const errorCode = terminal.outcome === "failure" ? terminal.errorCode : undefined;
  return {
    attempt: {
      ...attempt,
      outcome: terminal.outcome,
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(errorCode === undefined ? {} : { errorCode }),
    },
    finalModelId: attempt.modelId,
    finalProviderId: attempt.providerId,
    ...(statusCode === undefined ? {} : { finalStatusCode: statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
    outcome: terminal.outcome,
    ...(terminal.outcome === "success" && terminal.usage !== undefined ? { usage: terminal.usage } : {}),
  };
}
