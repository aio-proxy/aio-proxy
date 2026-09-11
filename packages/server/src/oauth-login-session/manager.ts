import {
  type AtomicConfigFile,
  type AccountWrite,
  type DiagnosticFactory,
  type LoginOAuthAccountOptions,
  loginOAuthAccount,
  type OAuthProviderPatch,
  type OAuthSharingService,
  type PluginLogSink,
  type PluginRegistry,
  type PluginRepository,
  ProviderAccountAlreadyExistsError,
} from '@aio-proxy/core';
import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';
import type { DashboardOAuthSession, DashboardOAuthSessionStart } from '@aio-proxy/types';

import { createDashboardAuthorization, type DashboardAuthorization } from './authorization';
import { OAuthCallbackError } from './callback';

type RegistryLease = { readonly registry: PluginRegistry; readonly release: () => void };
type ProviderCommitCoordinator = NonNullable<LoginOAuthAccountOptions['coordinateProviderCommit']>;
type ProviderCommitValidator = NonNullable<LoginOAuthAccountOptions['validateProviderCommit']>;
type SyncCommitHooks = NonNullable<LoginOAuthAccountOptions['syncCommit']>;
type InternalSession = {
  snapshot: DashboardOAuthSession;
  readonly controller: AbortController;
  authorization: DashboardAuthorization | undefined;
  terminalAt: number | undefined;
};

type LoginSessionDeps = {
  readonly configFile: AtomicConfigFile;
  readonly repository: PluginRepository;
  readonly acquireRegistry: () => RegistryLease;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly coordinateProviderCommit: ProviderCommitCoordinator;
  readonly validateProviderCommit: ProviderCommitValidator;
  readonly syncCommit?: SyncCommitHooks;
  readonly sharing?: () => OAuthSharingService | undefined;
  /**
   * Whether this login must coordinate with sync at all, asked per login. A device that connects a
   * backend after startup starts requiring coordination without recreating the manager, and one that
   * never connects keeps plain logins instead of failing them for a service it will never have.
   */
  readonly syncEnabled?: () => boolean;
  readonly withProviderGate?: <T>(providerId: string, run: () => Promise<T>) => Promise<T>;
  readonly onAccountOperationPending?: () => void;
  readonly reload: () => Promise<unknown>;
  readonly createFetch?: (input: DashboardOAuthSessionStart) => RuntimeFetch;
  readonly publish: (session: InternalSession, snapshot: DashboardOAuthSession) => void;
  readonly completeUrl?: string;
};

export type OAuthLoginSessionManager = ReturnType<typeof createOAuthLoginSessionManager>;

const failureCode = (error: unknown): string => {
  if (error instanceof OAuthCallbackError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) return error.message;
  return 'OAUTH_LOGIN_FAILED';
};

const runLoginSession = async (
  deps: LoginSessionDeps,
  session: InternalSession,
  input: DashboardOAuthSessionStart,
  id: string,
): Promise<void> => {
  const lease = deps.acquireRegistry();
  const authorization = createDashboardAuthorization({
    sessionId: id,
    signal: session.controller.signal,
    publish: (snapshot) => deps.publish(session, snapshot),
    ...(input.completeUrl === undefined && deps.completeUrl === undefined
      ? {}
      : { completeUrl: input.completeUrl ?? deps.completeUrl }),
  });
  session.authorization = authorization;
  try {
    const login = () =>
      loginOAuthAccount({
        ...(input.targetProviderId === undefined ? {} : { targetProviderId: input.targetProviderId }),
        ...(input.capability === undefined ? {} : { capability: input.capability }),
        ...(input.providerPatch === undefined
          ? {}
          : {
              providerPatch: {
                name: input.providerPatch.name,
                enabled: input.providerPatch.enabled,
                priority: input.providerPatch.priority,
                weight: input.providerPatch.weight,
                proxy: input.providerPatch.proxy,
                alias: input.providerPatch.alias,
                excludedModels: input.providerPatch.excludedModels,
                transforms: input.providerPatch.transforms,
              } satisfies OAuthProviderPatch,
            }),
        registry: lease.registry,
        repository: deps.repository,
        config: deps.configFile,
        renderAccountOptions: async ({ currentSecrets }) => {
          const secrets: Record<string, unknown> = { ...currentSecrets, ...input.secrets };
          for (const key of input.clearSecrets) delete secrets[key];
          return { publicValues: input.publicValues, secrets };
        },
        createAuthorization: () => authorization.port,
        ...(deps.createFetch === undefined ? {} : { fetch: deps.createFetch(input) }),
        diagnostics: deps.diagnostics,
        logger: deps.logger,
        coordinateProviderCommit: deps.coordinateProviderCommit,
        validateProviderCommit: deps.validateProviderCommit,
        ...(deps.syncCommit === undefined ? {} : { syncCommit: deps.syncCommit }),
        ...(deps.sharing === undefined || deps.syncEnabled?.() === false
          ? {}
          : {
              beforeAccountOperationComplete: async (operation, signal) => {
                const sharing = deps.sharing?.();
                if (sharing === undefined) throw new Error('SYNC_OAUTH_COORDINATION_UNAVAILABLE');
                const account = deps.repository.readAccount(operation.providerId);
                if (account === null) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
                const candidate: AccountWrite = {
                  providerId: account.providerId,
                  plugin: account.plugin,
                  capability: account.capability,
                  fingerprint: account.fingerprint,
                  options: account.options,
                  secrets: account.secrets,
                  credential: account.credential,
                  ...(account.label === undefined ? {} : { label: account.label }),
                  ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
                  catalog: { kind: 'preserve' },
                };
                await sharing.synchronizeLogin(operation.providerId, candidate, signal);
              },
            }),
        onAuthorized: () => deps.publish(session, { id, status: 'discovering' }),
        signal: session.controller.signal,
      });
    const result =
      input.targetProviderId === undefined || deps.withProviderGate === undefined
        ? await login()
        : await deps.withProviderGate(input.targetProviderId, login);
    await deps.reload();
    const warning = deps.repository
      .readDiagnostics(result.providerId)
      .some(({ code }) => code === 'CATALOG_UNAVAILABLE')
      ? 'catalog_unavailable'
      : undefined;
    deps.publish(session, {
      id,
      status: 'succeeded',
      providerId: result.providerId,
      ...(warning === undefined ? {} : { warning }),
    });
  } catch (error) {
    // Best-effort: a login that failed because the server is shutting down reads a closed
    // database here, and losing the session's real failure status to that is never worth it.
    try {
      if (
        deps.repository
          .listPendingAccountOperations()
          .some((operation) => operation.targetDigest.startsWith('oauth-sync:'))
      )
        deps.onAccountOperationPending?.();
    } catch {}
    if (error instanceof ProviderAccountAlreadyExistsError) {
      deps.publish(session, { id, status: 'succeeded', providerId: error.existingProviderId, duplicate: true });
    } else if (session.controller.signal.aborted) {
      deps.publish(session, { id, status: 'cancelled' });
    } else {
      deps.publish(session, { id, status: 'failed', code: failureCode(error) });
    }
  } finally {
    authorization.close();
    session.authorization = undefined;
    lease.release();
  }
};

export const createOAuthLoginSessionManager = (options: {
  readonly configFile: AtomicConfigFile | undefined;
  readonly repository: PluginRepository;
  readonly acquireRegistry: () => RegistryLease;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly coordinateProviderCommit: ProviderCommitCoordinator;
  readonly validateProviderCommit: ProviderCommitValidator;
  readonly syncCommit?: SyncCommitHooks;
  readonly sharing?: () => OAuthSharingService | undefined;
  readonly syncEnabled?: () => boolean;
  readonly withProviderGate?: <T>(providerId: string, run: () => Promise<T>) => Promise<T>;
  readonly onAccountOperationPending?: () => void;
  readonly reload: () => Promise<unknown>;
  readonly createFetch?: (input: DashboardOAuthSessionStart) => RuntimeFetch;
  readonly now?: () => number;
  readonly terminalSessionTtlMs?: number;
  readonly completeUrl?: string;
}) => {
  const sessions = new Map<string, InternalSession>();
  const now = options.now ?? Date.now;
  const terminalSessionTtlMs = options.terminalSessionTtlMs ?? 10 * 60_000;
  let closed = false;

  const pruneExpired = () => {
    const cutoff = now() - terminalSessionTtlMs;
    for (const [id, session] of sessions) {
      if (session.terminalAt !== undefined && session.terminalAt <= cutoff) sessions.delete(id);
    }
  };

  const publish = (session: InternalSession, snapshot: DashboardOAuthSession) => {
    if (
      closed ||
      session.snapshot.status === 'succeeded' ||
      session.snapshot.status === 'failed' ||
      session.snapshot.status === 'cancelled'
    )
      return;
    session.snapshot = snapshot;
    if (snapshot.status === 'succeeded' || snapshot.status === 'failed' || snapshot.status === 'cancelled') {
      session.terminalAt = now();
    }
  };

  const start = (input: DashboardOAuthSessionStart) => {
    if (closed) throw new Error('OAUTH_SESSION_MANAGER_CLOSED');
    pruneExpired();
    const configFile = options.configFile;
    if (configFile === undefined) throw new Error('CONFIG_PATH_MISSING');
    const id = crypto.randomUUID();
    const session: InternalSession = {
      snapshot: { id, status: 'preparing' },
      controller: new AbortController(),
      authorization: undefined,
      terminalAt: undefined,
    };
    sessions.set(id, session);

    void runLoginSession(
      {
        configFile,
        repository: options.repository,
        acquireRegistry: options.acquireRegistry,
        diagnostics: options.diagnostics,
        logger: options.logger,
        coordinateProviderCommit: options.coordinateProviderCommit,
        validateProviderCommit: options.validateProviderCommit,
        ...(options.syncCommit === undefined ? {} : { syncCommit: options.syncCommit }),
        ...(options.sharing === undefined ? {} : { sharing: options.sharing }),
        ...(options.syncEnabled === undefined ? {} : { syncEnabled: options.syncEnabled }),
        ...(options.withProviderGate === undefined ? {} : { withProviderGate: options.withProviderGate }),
        reload: options.reload,
        onAccountOperationPending: options.onAccountOperationPending,
        ...(options.createFetch === undefined ? {} : { createFetch: options.createFetch }),
        ...(options.completeUrl === undefined ? {} : { completeUrl: options.completeUrl }),
        publish,
      },
      session,
      input,
      id,
    );

    return session.snapshot;
  };

  return {
    start,
    get(id: string): DashboardOAuthSession | undefined {
      pruneExpired();
      return sessions.get(id)?.snapshot;
    },
    submitCallback(id: string, callbackUrl: string): DashboardOAuthSession {
      pruneExpired();
      const session = sessions.get(id);
      if (session === undefined) throw new Error('OAUTH_SESSION_NOT_FOUND');
      if (session.authorization === undefined) throw new OAuthCallbackError('CALLBACK_NOT_EXPECTED');
      session.authorization.submitCallback(callbackUrl);
      return session.snapshot;
    },
    cancel(id: string): DashboardOAuthSession | undefined {
      pruneExpired();
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      session.controller.abort(new Error('OAUTH_LOGIN_CANCELLED'));
      publish(session, { id, status: 'cancelled' });
      return session.snapshot;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) {
        session.controller.abort(new Error('SERVER_CLOSED'));
        session.authorization?.close();
      }
      sessions.clear();
    },
  };
};
