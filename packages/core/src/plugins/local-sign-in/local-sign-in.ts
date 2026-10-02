import { type CredentialPort, CredentialRefreshError, type OAuthLocalSignIn } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { collectSecretStrings, redactPluginError } from '../diagnostic';

export type LocalSignInLink = {
  /** Only rotating stores with a defined `write` can be linked to a refresh port. */
  readonly localSignIn: OAuthLocalSignIn<unknown, unknown>;
  readonly options: unknown;
  readonly fingerprint: string;
  /** Read inside the lease; a missing account must never fall through to plain exchange. */
  readonly account: () => { readonly revision: number; readonly linked: boolean; readonly consumed?: string } | null;
  readonly onWriteFailed: () => void;
};

export class LocalSignInAccountChangedError extends CredentialRefreshError {
  constructor() {
    super('Local sign-in account changed', { retryable: false, reason: 'local_sign_in_account_changed' });
  }
}

export class LocalSignInUnavailableError extends CredentialRefreshError {
  constructor() {
    super('Local sign-in unavailable', { retryable: true, reason: 'local_sign_in_unavailable' });
  }
}

export class LocalSignInSupersededError extends CredentialRefreshError {
  constructor() {
    super('Local sign-in account superseded', { retryable: true, reason: 'local_sign_in_superseded' });
  }
}

export function localSignInDigest(credential: unknown): string {
  const encoded = JSON.stringify(credential);
  if (encoded === undefined) throw new TypeError('Local sign-in credentials must be JSON serializable');
  // Normalize opaque credentials to their persisted JSON shape before sorting every object.
  const canonical = JSON.stringify(JSON.parse(encoded), (_key, value: unknown) =>
    isPlainObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  return new Bun.CryptoHasher('sha256').update(canonical).digest('hex');
}

export function linkLocalSignInCredentials(
  port: CredentialPort<unknown>,
  link: LocalSignInLink,
): CredentialPort<unknown> {
  return {
    read: () => port.read(),
    refresh(revision, exchange) {
      return port.refresh(revision, async (current, signal) => {
        const state = link.account();
        if (state === null || state.revision !== current.revision) throw new LocalSignInSupersededError();
        if (!state.linked) return exchange(current, signal);

        let observed;
        try {
          observed = await link.localSignIn.read({ signal, progress: () => {} }, link.options);
        } catch {
          throw new LocalSignInUnavailableError();
        }
        if (observed.fingerprint !== link.fingerprint) throw new LocalSignInAccountChangedError();
        const digest = localSignInDigest(observed.credentials);
        const stale = digest === state.consumed;
        const base = stale ? current.value : observed.credentials;
        let result;
        try {
          result = await exchange({ ...current, value: base }, signal);
        } catch (error) {
          const redacted = redactPluginError(error, {
            secretValues: collectSecretStrings([observed.credentials, base]),
          });
          throw error instanceof CredentialRefreshError
            ? new CredentialRefreshError(redacted.message, error.options)
            : new Error(redacted.message);
        }
        try {
          // Successful exchange consumed the token, so write back even after cancellation.
          await link.localSignIn.write!({ signal }, result.value, observed.credentials);
        } catch {
          link.onWriteFailed();
        }
        return {
          ...result,
          metadata: { ...result.metadata, localSignInConsumed: stale ? state.consumed : digest },
        };
      });
    },
  };
}
