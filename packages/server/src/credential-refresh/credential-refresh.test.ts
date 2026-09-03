import { afterEach, expect, test } from 'bun:test';

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

test('a plugin without the refresh capability is a permanent failure', async () => {
  const fixture = createQuotaFixture();
  const refresher = createOAuthCredentialRefresher(fixture.dependencies);

  const error = await refresher.refresh(PROVIDER_ID, quotaSignal()).catch((reason: unknown) => reason);

  expect(error).toBeInstanceOf(OAuthAccountUnavailableError);
  expect((error as OAuthAccountUnavailableError).permanent).toBe(true);
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
