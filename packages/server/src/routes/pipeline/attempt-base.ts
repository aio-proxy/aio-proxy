import type { ProviderProtocol } from "@aio-proxy/types";

import type { RequestAttemptInput } from "../../request-recorder";
import type { RuntimeProviderInstance } from "../../runtime";

export function attemptBase(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
  protocol?: ProviderProtocol,
): Omit<RequestAttemptInput, "outcome" | "statusCode" | "errorCode"> {
  return {
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...(protocol === undefined ? {} : { protocol }),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}
