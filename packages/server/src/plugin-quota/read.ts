import { collectSecretStrings, redactPluginError, validateOAuthQuotaSnapshot } from "@aio-proxy/core";
import type { AccountContext, CredentialPort, OAuthQuotaSnapshot } from "@aio-proxy/plugin-sdk";
import { type OAuthQuotaServiceDependencies, type PreparedOAuthQuotaContext, withOAuthQuotaContext } from "./context";
import { OAuthQuotaReadError } from "./errors";

export type OAuthQuotaReader = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
};

function trackSecrets(secrets: Set<string>, value: unknown): void {
  for (const secret of collectSecretStrings(value)) secrets.add(secret);
}

function createTrackingAccountContext(
  accountContext: AccountContext<unknown, unknown>,
  secrets: Set<string>,
): AccountContext<unknown, unknown> {
  const credentials: CredentialPort<unknown> = {
    async read() {
      const snapshot = await accountContext.credentials.read();
      trackSecrets(secrets, snapshot.value);
      return snapshot;
    },
    async refresh(expectedRevision, exchange) {
      const result = await accountContext.credentials.refresh(expectedRevision, async (current, signal) => {
        trackSecrets(secrets, current.value);
        const exchanged = await exchange(current, signal);
        trackSecrets(secrets, exchanged.value);
        return exchanged;
      });
      trackSecrets(secrets, result.snapshot.value);
      return result;
    },
  };
  return { ...accountContext, credentials };
}

export async function readValidatedQuota(
  dependencies: OAuthQuotaServiceDependencies,
  prepared: PreparedOAuthQuotaContext,
  event: string,
): Promise<OAuthQuotaSnapshot> {
  const secretValues = new Set(
    collectSecretStrings([prepared.account.credential, prepared.account.secrets, prepared.pluginSecrets]),
  );
  const accountContext = createTrackingAccountContext(prepared.accountContext, secretValues);
  try {
    const snapshot = await prepared.adapter.quota.read(accountContext);
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
        error: redactPluginError(error, { secretValues: [...secretValues] }),
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
