import { afterEach, expect, test } from 'bun:test';

import { CredentialRefreshError } from '@aio-proxy/plugin-sdk';

import { OAuthAccountUnavailableError } from '../oauth-account-context';
import { cleanupQuotaFixtures, createQuotaFixture, PROVIDER_ID, quotaSignal } from '../plugin-quota/test-support';
import { createOAuthCredentialRefresher } from './credential-refresh';
import { OAuthCredentialRefreshError } from './errors';

afterEach(cleanupQuotaFixtures);

test('a manual refresh persists the exchanged credential and rebuilds the snapshot', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({
      value: { token: 'rotated' },
      metadata: { accountLabel: 'new@example.com' },
    }),
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  await refresher.refresh(PROVIDER_ID, quotaSignal());

  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: 'rotated' });
  expect(fixture.repository.readAccount(PROVIDER_ID)?.label).toBe('new@example.com');
  // The control-plane credential port skips its own change callback, so the service must fire one
  // or the dashboard's refetched summary would still carry the previous account label.
  expect(fixture.changed()).toBeGreaterThan(0);
});

test('a manual refresh clears a stale credential refresh diagnostic', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({ value: { token: 'rotated' } }),
  });
  fixture.repository.writeDiagnostic(
    PROVIDER_ID,
    fixture.dependencies.diagnostics('CREDENTIAL_REFRESH_FAILED', { providerId: PROVIDER_ID, retryable: false }),
  );
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  await refresher.refresh(PROVIDER_ID, quotaSignal());

  expect(
    fixture.repository.readDiagnostics(PROVIDER_ID).some((entry) => entry.code === 'CREDENTIAL_REFRESH_FAILED'),
  ).toBe(false);
});

test('a snapshot rebuild failure does not report a committed rotation as a refresh failure', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({ value: { token: 'rotated' } }),
  });
  const refresher = createOAuthCredentialRefresher({
    ...fixture.dependencies,
    onDiagnosticChanged: () => {
      throw new Error('snapshot rebuild failed');
    },
  });

  await refresher.refresh(PROVIDER_ID, quotaSignal());

  // The credential is already committed to SQLite by this point; surfacing an error here would tell
  // the user their refresh failed when it did not.
  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: 'rotated' });
});

test('a rejected snapshot rebuild promise does not report a committed rotation as a failure', async () => {
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({ value: { token: 'rotated' } }),
  });
  const refresher = createOAuthCredentialRefresher({
    ...fixture.dependencies,
    onDiagnosticChanged: () => Promise.reject(new Error('snapshot rebuild failed')),
  });

  await refresher.refresh(PROVIDER_ID, quotaSignal());

  expect(fixture.repository.readAccount(PROVIDER_ID)?.credential).toEqual({ token: 'rotated' });
});

test('the refresh resolves only after the queued snapshot rebuild has landed', async () => {
  // The route acknowledges success the moment this resolves, and the dashboard refetches the
  // Provider list immediately. Returning before the rebuild swaps in would serve summaries still
  // carrying the pre-refresh `accountLabel` and `expiresAt`.
  let releaseRebuild = () => {};
  const rebuild = new Promise<void>((resolve) => {
    releaseRebuild = resolve;
  });
  const fixture = createQuotaFixture({
    refreshCredential: async () => ({ value: { token: 'rotated' } }),
  });
  const refresher = createOAuthCredentialRefresher({
    ...fixture.dependencies,
    onDiagnosticChanged: () => rebuild,
  });

  let settled = false;
  const refreshing = refresher.refresh(PROVIDER_ID, quotaSignal()).then(() => {
    settled = true;
  });
  await Bun.sleep(50);

  // Still pending: the rebuild has not landed, so there is nothing truthful to acknowledge yet.
  expect(settled).toBe(false);
  releaseRebuild();
  await refreshing;
  expect(settled).toBe(true);
});

test('two concurrent refreshes of one Provider perform a single upstream exchange', async () => {
  // The serializer is `CredentialPort`'s single-flight (WeakMap repository -> Provider ID -> mode),
  // backed by the SQLite refresh lease and the revision compare-and-swap. Nothing in this service
  // queues, so this pins the guarantee at the layer that actually provides it.
  let exchangeCalls = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createQuotaFixture({
    refreshCredential: async () => {
      exchangeCalls++;
      await gate;
      return { value: { token: 'rotated' } };
    },
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  const both = Promise.all([
    refresher.refresh(PROVIDER_ID, quotaSignal()),
    refresher.refresh(PROVIDER_ID, quotaSignal()),
  ]);
  await Bun.sleep(50);
  release();
  await both;

  expect(exchangeCalls).toBe(1);
  expect(fixture.repository.readAccount(PROVIDER_ID)?.revision).toBe(2);
});

test('a plugin without the refresh capability is a permanent failure', async () => {
  const fixture = createQuotaFixture();
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  const error = await refresher.refresh(PROVIDER_ID, quotaSignal()).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(OAuthAccountUnavailableError);
  expect((error as OAuthAccountUnavailableError).permanent).toBe(true);
});

test('a non-retryable exchange failure persists the reauthentication diagnostic', async () => {
  // The control-plane credential port skips this write so a background quota read cannot mark a
  // Provider as needing reauthentication. Without it a revoked refresh token leaves the Provider
  // reporting ready and the user sees only a generic toast.
  const fixture = createQuotaFixture({
    refreshCredential: async () => {
      throw new CredentialRefreshError('invalid_grant', { retryable: false, reason: 'invalid_grant' });
    },
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  await refresher.refresh(PROVIDER_ID, quotaSignal()).catch(() => {});

  const diagnostic = fixture.repository
    .readDiagnostics(PROVIDER_ID)
    .find((entry) => entry.code === 'CREDENTIAL_REFRESH_FAILED');
  expect(diagnostic).toBeDefined();
  expect(fixture.changed()).toBeGreaterThan(0);
});

test('a retryable exchange failure leaves the Provider undiagnosed', async () => {
  // A transient upstream hiccup is not the user's cue to re-login; the port applies the same rule.
  const fixture = createQuotaFixture({
    refreshCredential: async () => {
      throw new CredentialRefreshError('upstream unavailable', { retryable: true, reason: 'network' });
    },
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  await refresher.refresh(PROVIDER_ID, quotaSignal()).catch(() => {});

  expect(
    fixture.repository.readDiagnostics(PROVIDER_ID).some((entry) => entry.code === 'CREDENTIAL_REFRESH_FAILED'),
  ).toBe(false);
});

test('an upstream exchange failure is redacted and surfaced as a refresh error', async () => {
  // The fixture account stores `{ token: 'credential-secret' }`; a plugin that echoes the credential
  // it was handed back into its error message must not reach the log sink unredacted.
  const fixture = createQuotaFixture({
    refreshCredential: async () => {
      throw new Error('upstream rejected credential-secret');
    },
  });
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  const error = await refresher.refresh(PROVIDER_ID, quotaSignal()).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(OAuthCredentialRefreshError);
  expect(JSON.stringify(fixture.logs)).not.toContain('credential-secret');
});
