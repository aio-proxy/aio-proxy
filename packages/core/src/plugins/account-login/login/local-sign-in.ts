import type { CredentialPort, OAuthAdapter, OAuthLoginResult } from '@aio-proxy/plugin-sdk';

import { linkLocalSignInCredentials, localSignInDigest } from '../../local-sign-in';
import { withAbort } from '../deadline';
import {
  type OAuthCapabilityReference,
  OAuthLocalSignInInvalidError,
  OAuthLocalSignInStaleError,
  OAuthLocalSignInUnavailableError,
} from '../errors';
import type { OAuthAccountWriteOptions } from '../login';
import { validatedLoginResult } from '../validation';

export async function readLocalSignInAccount(
  adapter: OAuthAdapter,
  options: OAuthAccountWriteOptions,
  accountOptions: unknown,
  signal: AbortSignal,
): Promise<OAuthLoginResult<unknown>> {
  const localSignIn = adapter.localSignIn;
  if (localSignIn === undefined) throw new OAuthLocalSignInUnavailableError();
  let detected: boolean;
  try {
    detected = await withAbort(signal, () => localSignIn.detect({ signal }));
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new OAuthLocalSignInUnavailableError();
  }
  if (!detected) throw new OAuthLocalSignInUnavailableError();
  try {
    return await withAbort(signal, () =>
      localSignIn.read(
        {
          signal,
          progress: options.progress ?? (() => {}),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        },
        accountOptions,
      ),
    );
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new OAuthLocalSignInInvalidError();
  }
}

export async function validateLocalSignInResult(
  adapter: OAuthAdapter,
  raw: OAuthLoginResult<unknown>,
  signal: AbortSignal,
) {
  try {
    return await validatedLoginResult(adapter, raw, signal);
  } catch {
    if (signal.aborted) throw signal.reason;
    throw new OAuthLocalSignInInvalidError();
  }
}

export function assertLocalSignInFresh(raw: OAuthLoginResult<unknown>, consumed: string | undefined): void {
  if (consumed === undefined) return;
  let digest: string;
  try {
    digest = localSignInDigest(raw.credentials);
  } catch {
    throw new OAuthLocalSignInInvalidError();
  }
  if (digest === consumed) throw new OAuthLocalSignInStaleError();
}

export function localSignInDiscoveryPort(input: {
  readonly port: CredentialPort<unknown>;
  readonly currentRevision: () => number;
  readonly metadata: { readonly localSignInConsumed?: string };
  readonly adapter: OAuthAdapter;
  readonly capability: OAuthCapabilityReference;
  readonly options: OAuthAccountWriteOptions;
  readonly accountOptions: unknown;
  readonly fingerprint: string;
}): CredentialPort<unknown> {
  const { adapter, options, metadata } = input;
  if (adapter.localSignIn?.write === undefined) return input.port;
  return linkLocalSignInCredentials(input.port, {
    localSignIn: adapter.localSignIn,
    options: input.accountOptions,
    fingerprint: input.fingerprint,
    account: () => ({
      revision: input.currentRevision(),
      linked: true,
      ...(metadata.localSignInConsumed === undefined ? {} : { consumed: metadata.localSignInConsumed }),
    }),
    onWriteFailed: () =>
      options.logger({
        event: 'plugin.local-sign-in.write.failed',
        code: 'CREDENTIAL_REFRESH_FAILED',
        context: {
          ...input.capability,
          ...(options.targetProviderId === undefined ? {} : { providerId: options.targetProviderId }),
        },
        error: { name: 'Error', message: 'LOCAL_SIGN_IN_WRITE_FAILED' },
      }),
  });
}
