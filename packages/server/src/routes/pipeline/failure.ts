import type { RequestAttemptInput, RequestFinishInput } from "../../request-recorder";

type AttemptBase = Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode">;

export function failedAttempt(base: AttemptBase, statusCode: number): RequestAttemptInput {
  return { ...base, outcome: "failure", statusCode };
}

export function finalFailure(base: AttemptBase, statusCode: number): RequestFinishInput {
  return {
    outcome: "failure",
    finalProviderId: base.providerId,
    finalModelId: base.modelId,
    finalStatusCode: statusCode,
    attempt: failedAttempt(base, statusCode),
  };
}

export function shouldFallbackStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
