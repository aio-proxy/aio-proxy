import {
  type AtomicConfigFile,
  type DiagnosticFactory,
  loginOAuthAccount,
  type OAuthProviderPatch,
  type PluginLogSink,
  type PluginRegistry,
  type PluginRepository,
  ProviderAccountAlreadyExistsError,
} from "@aio-proxy/core";
import type { DashboardOAuthSession, DashboardOAuthSessionStart } from "@aio-proxy/types";
import { createDashboardAuthorization, type DashboardAuthorization } from "./authorization";
import { OAuthCallbackError } from "./callback";

type RegistryLease = { readonly registry: PluginRegistry; readonly release: () => void };
type InternalSession = {
  snapshot: DashboardOAuthSession;
  readonly controller: AbortController;
  authorization: DashboardAuthorization | undefined;
  terminalAt: number | undefined;
};

export type OAuthLoginSessionManager = ReturnType<typeof createOAuthLoginSessionManager>;

const failureCode = (error: unknown): string => {
  if (error instanceof OAuthCallbackError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) return error.message;
  return "OAUTH_LOGIN_FAILED";
};

export const createOAuthLoginSessionManager = (options: {
  readonly configFile: AtomicConfigFile | undefined;
  readonly repository: PluginRepository;
  readonly acquireRegistry: () => RegistryLease;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly reload: () => Promise<unknown>;
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
      session.snapshot.status === "succeeded" ||
      session.snapshot.status === "failed" ||
      session.snapshot.status === "cancelled"
    )
      return;
    session.snapshot = snapshot;
    if (snapshot.status === "succeeded" || snapshot.status === "failed" || snapshot.status === "cancelled") {
      session.terminalAt = now();
    }
  };

  const start = (input: DashboardOAuthSessionStart) => {
    if (closed) throw new Error("OAUTH_SESSION_MANAGER_CLOSED");
    pruneExpired();
    const configFile = options.configFile;
    if (configFile === undefined) throw new Error("CONFIG_PATH_MISSING");
    const id = crypto.randomUUID();
    const session: InternalSession = {
      snapshot: { id, status: "preparing" },
      controller: new AbortController(),
      authorization: undefined,
      terminalAt: undefined,
    };
    sessions.set(id, session);

    void (async () => {
      const lease = options.acquireRegistry();
      const authorization = createDashboardAuthorization({
        sessionId: id,
        signal: session.controller.signal,
        publish: (snapshot) => publish(session, snapshot),
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
                  weight: input.providerPatch.weight,
                  alias: input.providerPatch.alias,
                } satisfies OAuthProviderPatch,
              }),
          registry: lease.registry,
          repository: options.repository,
          config: configFile,
          renderAccountOptions: async ({ currentSecrets }) => {
            const secrets: Record<string, unknown> = { ...currentSecrets, ...input.secrets };
            for (const key of input.clearSecrets) delete secrets[key];
            return { publicValues: input.publicValues, secrets };
          },
          createAuthorization: () => authorization.port,
          diagnostics: options.diagnostics,
          logger: options.logger,
          onAuthorized: () => publish(session, { id, status: "discovering" }),
          signal: session.controller.signal,
        });
        await options.reload();
        const warning = options.repository
          .readDiagnostics(result.providerId)
          .some(({ code }) => code === "CATALOG_UNAVAILABLE")
          ? "catalog_unavailable"
          : undefined;
        publish(session, {
          id,
          status: "succeeded",
          providerId: result.providerId,
          ...(warning === undefined ? {} : { warning }),
        });
      } catch (error) {
        if (error instanceof ProviderAccountAlreadyExistsError) {
          publish(session, { id, status: "succeeded", providerId: error.existingProviderId, duplicate: true });
        } else if (session.controller.signal.aborted) {
          publish(session, { id, status: "cancelled" });
        } else {
          publish(session, { id, status: "failed", code: failureCode(error) });
        }
      } finally {
        authorization.close();
        session.authorization = undefined;
        lease.release();
      }
    })();

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
      if (session === undefined) throw new Error("OAUTH_SESSION_NOT_FOUND");
      if (session.authorization === undefined) throw new OAuthCallbackError("CALLBACK_NOT_EXPECTED");
      session.authorization.submitCallback(callbackUrl);
      return session.snapshot;
    },
    cancel(id: string): DashboardOAuthSession | undefined {
      pruneExpired();
      const session = sessions.get(id);
      if (session === undefined) return undefined;
      session.controller.abort(new Error("OAUTH_LOGIN_CANCELLED"));
      publish(session, { id, status: "cancelled" });
      return session.snapshot;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) {
        session.controller.abort(new Error("SERVER_CLOSED"));
        session.authorization?.close();
      }
      sessions.clear();
    },
  };
};
