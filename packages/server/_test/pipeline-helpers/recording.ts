import type { RequestAttemptInput, RequestRecorder, RequestSession } from "../../src/request-recorder";
import type { UsageCompletion } from "../../src/usage-capture";
import type { Recording } from "./types";

export function createRecording(): Recording & { readonly recorder: RequestRecorder } {
  const begins: Recording["begins"] = [];
  const attempts: RequestAttemptInput[] = [];
  const finals: RequestFinishInput[] = [];
  const recorder: RequestRecorder = {
    begin(input) {
      begins.push(input);
      let finished = false;
      const session: RequestSession = {
        requestId: `request-${begins.length}`,
        attempt(attempt) {
          if (!finished) attempts.push(attempt);
        },
        finish(finish) {
          if (finished) return;
          finished = true;
          if (finish.attempt !== undefined) attempts.push(finish.attempt);
          finals.push(finish);
        },
        finishFrom(attempt, completion) {
          void completion.then(
            (terminal) => finishFromTerminal(session, attempt, terminal),
            () =>
              session.finish({
                attempt: { ...attempt, outcome: "failure" },
                finalModelId: attempt.modelId,
                finalProviderId: attempt.providerId,
                outcome: "failure",
              }),
          );
        },
      };
      return session;
    },
  };
  return { attempts, begins, finals, recorder };
}

function finishFromTerminal(
  session: RequestSession,
  attempt: Omit<RequestAttemptInput, "errorCode" | "outcome" | "statusCode">,
  terminal: UsageCompletion,
): void {
  const statusCode = "statusCode" in terminal ? terminal.statusCode : undefined;
  const errorCode = terminal.outcome === "failure" ? terminal.errorCode : undefined;
  session.finish({
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
  });
}
