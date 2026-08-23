import {
  type AtomicConfigFile,
  type DiagnosticFactory,
  type LoginOAuthAccountOptions,
  loginOAuthAccount,
  type OAuthProviderPatch,
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
  readonly reload: () => Promise<unknown>;
  readonly createFetch?: (input: DashboardOAuthSessionStart) => RuntimeFetch;
  readonly publish: (session: InternalSession, snapshot: DashboardOAuthSession) => void;
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
  });
  session.authorization = authorization;
  try {
    const result = await loginOAuthAccount({
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
              models: input.providerPatch.models,
              metadata: input.providerPatch.metadata,
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
      onAuthorized: () => deps.publish(session, { id, status: 'discovering' }),
      signal: session.controller.signal,
    });
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
  readonly reload: () => Promise<unknown>;
  readonly createFetch?: (input: DashboardOAuthSessionStart) => RuntimeFetch;
  readonly now?: () => number;
  readonly terminalSessionTtlMs?: number;
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
        reload: options.reload,
        ...(options.createFetch === undefined ? {} : { createFetch: options.createFetch }),
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
