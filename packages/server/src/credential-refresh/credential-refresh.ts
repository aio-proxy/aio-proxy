import { redactPluginError } from '@aio-proxy/core';
import { CredentialRefreshError, type OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { providerLoginCommand } from '@aio-proxy/types';

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
  // The rebuild is awaited, not just scheduled: the route acknowledges success as soon as this
  // returns and the dashboard immediately refetches the Provider list, so returning early would
  // serve summaries still carrying the pre-refresh `accountLabel`, `expiresAt`, and diagnostic.
  // Both are best-effort: the rotated credential is already committed, so a failure here must not
  // surface as a refresh failure and tell the user work that succeeded did not.
  try {
    dependencies.repository.clearDiagnostic(prepared.providerId, 'CREDENTIAL_REFRESH_FAILED');
    await dependencies.onDiagnosticChanged();
  } catch {}
}

/**
 * `createCredentialPort` writes `CREDENTIAL_REFRESH_FAILED` for a non-retryable exchange failure only
 * in `runtime` mode, so a background quota read cannot mark a Provider as needing reauthentication.
 * A manual refresh has to do it: a revoked refresh token (`invalid_grant`) is exactly the case the
 * user needs told, and without this the Provider keeps reporting ready and the dashboard shows only
 * a generic toast.
 *
 * Only an adapter that explicitly classified the failure as permanent counts. Anything else —
 * a retryable `CredentialRefreshError`, an unclassified plugin error, a network fault — stays
 * undiagnosed: several bundled adapters throw a plain error for every non-2xx response, including
 * 429 and 5xx, so treating unclassified failures as permanent would take a Provider out of service
 * for a transient outage until the user re-logged in.
 */
async function recordPermanentFailure(
  dependencies: OAuthAccountContextDependencies,
  providerId: string,
  error: unknown,
): Promise<void> {
  if (!(error instanceof CredentialRefreshError) || error.retryable) return;
  try {
    const diagnostic = dependencies.diagnostics('CREDENTIAL_REFRESH_FAILED', {
      providerId,
      retryable: false,
      suggestedCommand: providerLoginCommand(providerId),
    });
    // Awaited for the same reason the success path awaits: the route rejects as soon as this returns
    // and the dashboard refetches immediately, so a queued-but-unlanded rebuild would serve a summary
    // that still reports the Provider as ready.
    if (dependencies.repository.writeDiagnostic(providerId, diagnostic)) await dependencies.onDiagnosticChanged();
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
            await recordPermanentFailure(dependencies, prepared.providerId, error);
            throw new OAuthCredentialRefreshError();
          }
        },
      ),
  };
}
