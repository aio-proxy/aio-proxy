import { describe, expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';
import { currentMuseCodeCredential, museLoginResult } from './oauth';

const credential: MuseCodeCredential = {
  oauthAccessToken: 'oauth-secret',
  apiKey: 'muse-key-secret',
  email: '  Person@Example.com ',
  accountId: 'user-1',
};

describe('museLoginResult', () => {
  test('fingerprints account id first and normalizes the email label', () => {
    const digest = new Bun.CryptoHasher('sha256').update('account:user-1').digest('hex');
    expect(museLoginResult(credential)).toEqual({
      fingerprint: `sha256:${digest}`,
      suggestedKey: `muse-${digest.slice(0, 12)}`,
      accountLabel: 'person@example.com',
      credentials: {
        oauthAccessToken: 'oauth-secret',
        apiKey: 'muse-key-secret',
        email: 'person@example.com',
        accountId: 'user-1',
      },
    });
  });

  test('falls back to normalized email identity when account id is missing', () => {
    const digest = new Bun.CryptoHasher('sha256').update('email:person@example.com').digest('hex');
    const result = museLoginResult({
      oauthAccessToken: 'oauth-secret',
      apiKey: 'muse-key-secret',
      email: 'Person@Example.com',
    });
    expect(result.fingerprint).toBe(`sha256:${digest}`);
    expect(result.suggestedKey).toBe(`muse-${digest.slice(0, 12)}`);
    expect(result.accountLabel).toBe('person@example.com');
  });

  test('does not hash tokens when identity is missing', () => {
    expect(() => museLoginResult({ oauthAccessToken: 'oauth-secret', apiKey: 'muse-key-secret' })).toThrow(
      'stable account identity',
    );
  });
});

describe('currentMuseCodeCredential', () => {
  test('returns the stored credential without refreshing or reminting', async () => {
    let refreshes = 0;
    const port: CredentialPort<MuseCodeCredential> = {
      read: async () => ({ revision: 1, value: credential }),
      refresh: async () => {
        refreshes += 1;
        throw new Error('Muse Code must not refresh');
      },
    };
    await expect(currentMuseCodeCredential(port)).resolves.toEqual(credential);
    expect(refreshes).toBe(0);
  });
});
