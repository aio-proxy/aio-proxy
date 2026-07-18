import { redactPluginError, validateOAuthQuotaSnapshot } from "@aio-proxy/core";
import type { OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { type OAuthQuotaServiceDependencies, type PreparedOAuthQuotaContext, withOAuthQuotaContext } from "./context";
import { OAuthQuotaReadError } from "./errors";

export type OAuthQuotaReader = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
};

export async function readValidatedQuota(
  dependencies: OAuthQuotaServiceDependencies,
  prepared: PreparedOAuthQuotaContext,
  event: string,
): Promise<OAuthQuotaSnapshot> {
  try {
    const snapshot = await prepared.adapter.quota.read(prepared.accountContext);
    return validateOAuthQuotaSnapshot(snapshot);
  } catch (error) {
    try {
      dependencies.logger({
        event,
        code: "QUOTA_READ_FAILED",
        context: {
          plugin: prepared.plugin,
          capability: prepared.capability,
          providerId: prepared.providerId,
        },
        error: redactPluginError(error, { secretValues: [...prepared.secretValues] }),
      });
    } catch {}
    throw new OAuthQuotaReadError();
  }
}

export function createOAuthQuotaReader(dependencies: OAuthQuotaServiceDependencies): OAuthQuotaReader {
  return {
    read: (providerId, signal) =>
      withOAuthQuotaContext(dependencies, providerId, signal, (prepared) =>
        readValidatedQuota(dependencies, prepared, "plugin.quota.read.failed"),
      ),
  };
}
