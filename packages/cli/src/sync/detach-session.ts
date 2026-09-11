import { m } from '@aio-proxy/i18n';
import { type AuthorizationPort, type LocalizedText, LocalizedTextSchema } from '@aio-proxy/plugin-sdk';
import { type DashboardOAuthSession, DashboardOAuthSessionSchema } from '@aio-proxy/types';

import { SyncCliError } from './errors';

/** Only the intermediate authorization renderers apply: the loopback listener lives in the service. */
export type SyncAuthorizationPort = Pick<AuthorizationPort, 'presentDeviceCode' | 'presentAuthorizeUrl'>;

export type DetachSessionDeps = {
  readonly requestJson: (path: string, init?: RequestInit) => Promise<unknown>;
  readonly write: (value: string) => void;
  readonly authorization?: SyncAuthorizationPort;
  readonly readManualCallbackUrl?: (authorizationUrl: string, signal: AbortSignal) => Promise<string>;
};

const POLL_INTERVAL_MS = 50;

const sessionSnapshot = (body: unknown): DashboardOAuthSession => {
  const session = typeof body === 'object' && body !== null ? Reflect.get(body, 'session') : undefined;
  const parsed = DashboardOAuthSessionSchema.safeParse(session);
  if (!parsed.success) throw new SyncCliError('invalid-response', m['cli.sync.invalid_response']());
  return parsed.data;
};

const localizedInstructions = (value: unknown): { readonly instructions?: LocalizedText } => {
  const parsed = LocalizedTextSchema.safeParse(value);
  return parsed.success ? { instructions: parsed.data } : {};
};

/**
 * Drives a service-hosted OAuth session for `sync detach`: renders each authorization state the
 * service reports so the user can actually finish the login, and polls until it settles.
 */
export async function startDetachSession(providerId: string, deps: DetachSessionDeps): Promise<string> {
  const started = await deps.requestJson('/dashboard/api/oauth/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetProviderId: providerId }),
  });
  const manual = new AbortController();
  const presented = new Set<string>();

  // The service owns the redirect listener, so a manual callback URL is submitted back to it while
  // polling continues: whichever of the two paths lands first settles the session.
  const submitManualCallback = (sessionId: string, authorizationUrl: string): void => {
    const read = deps.readManualCallbackUrl;
    if (read === undefined) return;
    void (async () => {
      while (!manual.signal.aborted) {
        let callbackUrl: string;
        try {
          callbackUrl = await read(authorizationUrl, manual.signal);
        } catch {
          return;
        }
        if (manual.signal.aborted) return;
        try {
          await deps.requestJson(`/dashboard/api/oauth/sessions/${encodeURIComponent(sessionId)}/callback`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callbackUrl }),
          });
          return;
        } catch {
          if (manual.signal.aborted) return;
          deps.write(m['cli.oauth.invalid_callback_response']());
        }
      }
    })();
  };

  const present = async (session: DashboardOAuthSession): Promise<void> => {
    const authorization = deps.authorization;
    if (authorization === undefined || presented.has(session.status)) return;
    presented.add(session.status);
    if (session.status === 'device_code')
      await authorization.presentDeviceCode({
        url: session.url,
        userCode: session.userCode,
        ...localizedInstructions(session.instructions),
      });
    else if (session.status === 'authorize_url')
      await authorization.presentAuthorizeUrl({ url: session.url, ...localizedInstructions(session.instructions) });
    else if (session.status === 'loopback') {
      await authorization.presentAuthorizeUrl({ url: session.authorizationUrl });
      if (session.allowManualCallback) submitManualCallback(session.id, session.authorizationUrl);
    }
  };

  try {
    let snapshot = sessionSnapshot(started);
    for (;;) {
      if (snapshot.status === 'succeeded') {
        if (snapshot.providerId !== providerId)
          throw new SyncCliError('oauth-login-failed', m['cli.sync.oauth_login_failed']());
        return snapshot.id;
      }
      if (snapshot.status === 'failed' || snapshot.status === 'cancelled')
        throw new SyncCliError('oauth-login-failed', m['cli.sync.oauth_login_failed']());
      await present(snapshot);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      snapshot = sessionSnapshot(
        await deps.requestJson(`/dashboard/api/oauth/sessions/${encodeURIComponent(snapshot.id)}`),
      );
    }
  } finally {
    manual.abort();
  }
}
