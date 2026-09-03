import { redactPluginError } from '@aio-proxy/core';
import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import {
  type OAuthAccountContextDependencies,
  type PreparedOAuthAccountContext,
  withOAuthAccountContext,
} from '../oauth-account-context';
import { OAuthCredentialRefreshError } from './errors';

export type OAuthCredentialRefreshOperations = {
  readonly refresh: (providerId: string, signal: AbortSignal) => Promise<void>;
};

type RefreshCapability = NonNullable<OAuthAdapter['refreshCredential']>;

async function exchange(
  dependencies: OAuthAccountContextDependencies,
  prepared: PreparedOAuthAccountContext,
  refreshCredential: RefreshCapability,
): Promise<void> {
  const { accountContext } = prepared;
  const current = await accountContext.credentials.read();
  const result = await accountContext.credentials.refresh(current.revision, (snapshot, signal) =>
    refreshCredential({
      credential: snapshot.value,
      options: accountContext.options,
      signal,
      ...(accountContext.fetch === undefined ? {} : { fetch: accountContext.fetch }),
    }),
  );
  // `superseded` means a concurrent refresh already replaced the credential — the account now holds
  // a fresher token than the one the caller asked to replace, which is the outcome they wanted.
  if (result.status !== 'updated' && result.status !== 'superseded') return;
  // `createCredentialPort` skips both of these in `control-plane` mode so a background quota read
  // cannot mutate routing state. A user-initiated refresh must do them: otherwise a stale
  // `CREDENTIAL_REFRESH_FAILED` survives a successful refresh and the summary is never rebuilt.
  // Both are best-effort: the rotated credential is already committed, so a failure here must not
  // surface as a refresh failure and tell the user work that succeeded did not.
  try {
    dependencies.repository.clearDiagnostic(prepared.providerId, 'CREDENTIAL_REFRESH_FAILED');
    dependencies.onDiagnosticChanged();
  } catch {}
}

/**
 * `CredentialPort.refresh` is already the serializer: it single-flights concurrent callers per
 * repository/Provider ID/mode, behind the SQLite refresh lease and a revision compare-and-swap. A
 * queue here would defeat that — the second click would run *after* the first released its flight
 * and perform a redundant upstream exchange.
 */
export function createOAuthCredentialRefresher(
  dependencies: OAuthAccountContextDependencies,
): OAuthCredentialRefreshOperations {
  return {
    refresh: (providerId, signal) =>
      withOAuthAccountContext(
        dependencies,
        { providerId, signal, select: (adapter) => adapter.refreshCredential },
        async (prepared, refreshCredential) => {
          try {
            await exchange(dependencies, prepared, refreshCredential);
          } catch (error) {
            // Cancellation is the caller's, not the plugin's: surface the abort reason unlogged
            // the way `signal.throwIfAborted()` would have.
            if (prepared.accountContext.signal.aborted) throw prepared.accountContext.signal.reason;
            try {
              dependencies.logger({
                event: 'plugin.credential.refresh.manual.failed',
                code: 'CREDENTIAL_REFRESH_FAILED',
                context: {
                  plugin: prepared.plugin,
                  capability: prepared.capability,
                  providerId: prepared.providerId,
                },
                error: redactPluginError(error, { secretValues: [...prepared.secretValues] }),
              });
            } catch {}
            throw new OAuthCredentialRefreshError();
          }
        },
      ),
  };
}
