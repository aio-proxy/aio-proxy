import {
  collectSecretStrings,
  type DiagnosticFactory,
  type PluginLogSink,
  type PluginRepository,
} from "@aio-proxy/core";
import type { AccountContext, CredentialPort, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { prepareOAuthPluginAccount } from "../plugin-account";
import type { ProviderSnapshotLease } from "../runtime";
import { OAuthQuotaCapabilityUnavailableError } from "./errors";

export type OAuthQuotaServiceDependencies = {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

export type PreparedOAuthQuotaContext = {
  readonly adapter: OAuthAdapter & {
    readonly quota: NonNullable<OAuthAdapter["quota"]>;
  };
  readonly accountContext: AccountContext<unknown, unknown>;
  readonly plugin: string;
  readonly capability: string;
  readonly providerId: string;
  readonly secretValues: Set<string>;
};

function trackSecrets(secrets: Set<string>, value: unknown): void {
  for (const secret of collectSecretStrings(value)) secrets.add(secret);
}

function createTrackingCredentialPort(
  credentials: CredentialPort<unknown>,
  secrets: Set<string>,
): CredentialPort<unknown> {
  return {
    async read() {
      const snapshot = await credentials.read();
      trackSecrets(secrets, snapshot.value);
      return snapshot;
    },
    async refresh(expectedRevision, exchange) {
      const result = await credentials.refresh(expectedRevision, async (current, signal) => {
        trackSecrets(secrets, current.value);
        const exchanged = await exchange(current, signal);
        trackSecrets(secrets, exchanged.value);
        return exchanged;
      });
      trackSecrets(secrets, result.snapshot.value);
      return result;
    },
  };
}

async function prepareContext(
  dependencies: OAuthQuotaServiceDependencies,
  lease: ProviderSnapshotLease,
  providerId: string,
  signal: AbortSignal,
): Promise<PreparedOAuthQuotaContext> {
  try {
    const provider = lease.snapshot.config?.providers.find(({ id }) => id === providerId);
    if (provider?.kind !== ProviderKind.OAuth) {
      throw new OAuthQuotaCapabilityUnavailableError();
    }
    const pluginSecretValues = collectSecretStrings(dependencies.repository.readPluginSecret(provider.plugin)?.value);
    const prepared = await prepareOAuthPluginAccount({
      config: provider,
      plugins: lease.snapshot.plugins,
      repository: dependencies.repository,
      diagnostics: dependencies.diagnostics,
      logger: dependencies.logger,
      credentialMode: "control-plane",
      onDiagnosticChanged: dependencies.onDiagnosticChanged,
      pluginSecretValues,
    });
    if (prepared.adapter.quota === undefined) {
      throw new OAuthQuotaCapabilityUnavailableError();
    }
    const secretValues = new Set(prepared.secretValues);
    return {
      adapter: prepared.adapter as PreparedOAuthQuotaContext["adapter"],
      accountContext: {
        credentials: createTrackingCredentialPort(prepared.createCredentials(), secretValues),
        options: prepared.accountOptions,
        signal,
      },
      plugin: provider.plugin,
      capability: provider.capability,
      providerId,
      secretValues,
    };
  } catch {
    throw new OAuthQuotaCapabilityUnavailableError();
  }
}

export async function withOAuthQuotaContext<T>(
  dependencies: OAuthQuotaServiceDependencies,
  providerId: string,
  signal: AbortSignal,
  operation: (prepared: PreparedOAuthQuotaContext) => Promise<T>,
): Promise<T> {
  const lease = dependencies.acquireSnapshot();
  try {
    const prepared = await prepareContext(dependencies, lease, providerId, signal);
    return await operation(prepared);
  } finally {
    lease.release();
  }
}
