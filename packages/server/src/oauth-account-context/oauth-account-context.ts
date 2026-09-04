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
import { OAuthAccountUnavailableError } from './errors';

export type OAuthAccountContextDependencies = {
  readonly acquireSnapshot: () => ProviderSnapshotLease;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  /**
   * May return a promise that settles once the rebuilt snapshot is readable. Callers that only need
   * the rebuild scheduled can ignore it; a caller that must not acknowledge success while the
   * summaries are still stale awaits it.
   */
  readonly onDiagnosticChanged: () => void | Promise<void>;
};

export type PreparedOAuthAccountContext = {
  readonly accountContext: AccountContext<unknown, unknown>;
  readonly plugin: string;
  readonly capability: string;
  readonly providerId: string;
  readonly secretValues: Set<string>;
};

export type OAuthAccountContextRequest<Capability> = {
  readonly providerId: string;
  readonly signal: AbortSignal;
  /** Returning `undefined` means the plugin does not expose this capability: a permanent failure. */
  readonly select: (adapter: OAuthAdapter) => Capability | undefined;
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

function controlPlaneFetch(snapshot: Partial<Snapshot>, provider: OAuthProvider) {
  const cached = snapshot.runtimeCache?.get(provider.id)?.fetch;
  if (cached !== undefined) return cached;
  const control = createProxyFetch(effectiveProxy(snapshot.config?.proxy, provider.proxy));
  return createRuntimeFetch({ control, model: control });
}

async function prepareContext<Capability>(
  dependencies: OAuthAccountContextDependencies,
  lease: ProviderSnapshotLease,
  request: OAuthAccountContextRequest<Capability>,
): Promise<{ readonly prepared: PreparedOAuthAccountContext; readonly capability: Capability }> {
  const { providerId, signal } = request;
  try {
    const provider = lease.snapshot.config?.providers.find(({ id }) => id === providerId);
    if (provider?.kind !== ProviderKind.OAuth) {
      throw new OAuthAccountUnavailableError(true);
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
    const capability = request.select(prepared.adapter);
    if (capability === undefined) {
      throw new OAuthAccountUnavailableError(true);
    }
    const secretValues = new Set(prepared.secretValues);
    const runtimeFetch = controlPlaneFetch(lease.snapshot as Partial<Snapshot>, provider);
    return {
      capability,
      prepared: {
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
      },
    };
  } catch (error) {
    // Deliberately opaque: a caller must not learn whether the account exists, its options parsed,
    // or its credential decrypted. `permanent` is preserved so callers can still tell a plugin with
    // no such capability apart from an account that merely needs reauthentication.
    throw new OAuthAccountUnavailableError(error instanceof OAuthAccountUnavailableError && error.permanent);
  }
}

export async function withOAuthAccountContext<Capability, T>(
  dependencies: OAuthAccountContextDependencies,
  request: OAuthAccountContextRequest<Capability>,
  operation: (prepared: PreparedOAuthAccountContext, capability: Capability) => Promise<T>,
): Promise<T> {
  const lease = dependencies.acquireSnapshot();
  try {
    // The signal handed to the plugin is advisory, and both halves of this are plugin-controlled: the
    // account-options and credential schemas run through the plugin's own `safeParseAsync` during
    // preparation, then the operation itself. Either can stay pending forever, and `lease.release()`
    // hangs off whatever this awaits, so the race has to cover both or a hung plugin leaks the lease.
    return await withAbort(request.signal, async () => {
      const { prepared, capability } = await prepareContext(dependencies, lease, request);
      return await operation(prepared, capability);
    });
  } finally {
    lease.release();
  }
}
