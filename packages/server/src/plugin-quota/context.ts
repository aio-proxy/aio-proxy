import {
  collectSecretStrings,
  createProxyFetch,
  type DiagnosticFactory,
  type PluginLogSink,
  type PluginRepository,
  withAbort,
} from '@aio-proxy/core';
import type { AccountContext, CredentialPort, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { type OAuthProvider, ProviderKind } from '@aio-proxy/types';

import { prepareOAuthPluginAccount } from '../plugin-account';
import { createRuntimeFetch } from '../plugin-runtime';
import { effectiveProxy } from '../provider-runtime';
import type { ProviderSnapshotLease } from '../runtime';
import type { Snapshot } from '../server-state/snapshot';
import { OAuthQuotaCapabilityUnavailableError } from './errors';

export type OAuthQuotaServiceDependencies = {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
};

export type PreparedOAuthQuotaContext = {
  readonly adapter: OAuthAdapter & {
    readonly quota: NonNullable<OAuthAdapter['quota']>;
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

function quotaFetch(snapshot: Partial<Snapshot>, provider: OAuthProvider) {
  const cached = snapshot.runtimeCache?.get(provider.id)?.fetch;
  if (cached !== undefined) return cached;
  const control = createProxyFetch(effectiveProxy(snapshot.config?.proxy, provider.proxy));
  return createRuntimeFetch({ control, model: control });
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
      throw new OAuthQuotaCapabilityUnavailableError(true);
    }
    const pluginSecretValues = collectSecretStrings(dependencies.repository.readPluginSecret(provider.plugin)?.value);
    const prepared = await prepareOAuthPluginAccount({
      config: provider,
      plugins: lease.snapshot.plugins,
      repository: dependencies.repository,
      diagnostics: dependencies.diagnostics,
      logger: dependencies.logger,
      credentialMode: 'control-plane',
      onDiagnosticChanged: dependencies.onDiagnosticChanged,
      pluginSecretValues,
    });
    if (prepared.adapter.quota === undefined) {
      throw new OAuthQuotaCapabilityUnavailableError(true);
    }
    const secretValues = new Set(prepared.secretValues);
    const runtimeFetch = quotaFetch(lease.snapshot as Partial<Snapshot>, provider);
    return {
      adapter: prepared.adapter as PreparedOAuthQuotaContext['adapter'],
      accountContext: {
        credentials: createTrackingCredentialPort(prepared.createCredentials(), secretValues),
        options: prepared.accountOptions,
        signal,
        fetch: runtimeFetch,
      },
      plugin: provider.plugin,
      capability: provider.capability,
      providerId,
      secretValues,
    };
  } catch (error) {
    // Deliberately opaque: a caller must not learn whether the account exists, its options parsed,
    // or its credential decrypted. `permanent` is preserved so the cache can still tell a plugin
    // with no quota capability apart from an account that merely needs reauthentication.
    throw new OAuthQuotaCapabilityUnavailableError(
      error instanceof OAuthQuotaCapabilityUnavailableError && error.permanent,
    );
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
    // The signal handed to the plugin is advisory, and both halves of this are plugin-controlled: the
    // account-options and credential schemas run through the plugin's own `safeParseAsync` during
    // preparation, then the read itself. Either can stay pending forever, and `lease.release()` hangs
    // off whatever this awaits, so the race has to cover both or a hung plugin leaks the snapshot lease.
    return await withAbort(
      signal,
      async () => await operation(await prepareContext(dependencies, lease, providerId, signal)),
    );
  } finally {
    lease.release();
  }
}
