import type { RequestAttemptInput, RequestFinishInput } from "../../request-recorder";

type AttemptBase = Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode">;

export function failedAttempt(base: AttemptBase, statusCode: number, errorCode?: string): RequestAttemptInput {
  return {
    ...base,
    outcome: "failure",
    statusCode,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export function finalFailure(base: AttemptBase, statusCode: number, errorCode?: string): RequestFinishInput {
  return {
    outcome: "failure",
    finalProviderId: base.providerId,
    finalModelId: base.modelId,
    finalStatusCode: statusCode,
    ...(errorCode === undefined ? {} : { errorCode }),
    attempt: failedAttempt(base, statusCode, errorCode),
  };
}

export function shouldFallbackStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
