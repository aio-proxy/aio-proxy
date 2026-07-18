import type { DiagnosticFactory, PluginLogSink, PluginRepository } from "@aio-proxy/core";
import type { AccountContext, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { type PreparedOAuthPluginAccount, prepareOAuthPluginAccount } from "../plugin-account";
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
  readonly account: PreparedOAuthPluginAccount["account"];
  readonly accountContext: AccountContext<unknown, unknown>;
  readonly plugin: string;
  readonly capability: string;
  readonly providerId: string;
  readonly pluginSecrets?: unknown;
};

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
    const pluginSecrets = dependencies.repository.readPluginSecret(provider.plugin)?.value;
    const prepared = await prepareOAuthPluginAccount({
      config: provider,
      plugins: lease.snapshot.plugins,
      repository: dependencies.repository,
      diagnostics: dependencies.diagnostics,
      logger: dependencies.logger,
      onDiagnosticChanged: dependencies.onDiagnosticChanged,
      ...(pluginSecrets === undefined ? {} : { pluginSecrets }),
    });
    if (prepared.adapter.quota === undefined) {
      throw new OAuthQuotaCapabilityUnavailableError();
    }
    return {
      adapter: prepared.adapter as PreparedOAuthQuotaContext["adapter"],
      account: prepared.account,
      accountContext: {
        credentials: prepared.createCredentials(),
        options: prepared.accountOptions,
        signal,
      },
      plugin: provider.plugin,
      capability: provider.capability,
      providerId,
      ...(pluginSecrets === undefined ? {} : { pluginSecrets }),
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
