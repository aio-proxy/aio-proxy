import { describe, expect, test } from 'bun:test';

import { DEFAULT_FEED_URL } from '../info-plist';
import { notaryAuth, releaseEnv, teamIdOf } from './release-env';

const publicEdKey = '6tfdkTDFm68kxdxZ4oBJZ625LnOFeVLbWB6UcIsQDW4=';
const ci = {
  DEVELOPER_ID_IDENTITY: 'Developer ID Application: Team (TEAMID)',
  SPARKLE_PUBLIC_ED_KEY: publicEdKey,
  APPLE_API_KEY_PATH: '/tmp/notary.p8',
  APPLE_API_KEY_ID: 'KEYID',
  APPLE_API_ISSUER_ID: 'ISSUER',
};

describe('releaseEnv', () => {
  test('a complete CI environment signs with the identity, ships the product feed and notarizes with the API key', () => {
    expect(releaseEnv(ci)).toEqual({
      identity: ci.DEVELOPER_ID_IDENTITY,
      publicEdKey,
      feedUrl: DEFAULT_FEED_URL,
      notaryAuth: ['--key', '/tmp/notary.p8', '--key-id', 'KEYID', '--issuer', 'ISSUER'],
    });
  });

  test('a feed override is carried for local update rehearsals (desktop:publish refuses such a build)', () => {
    expect(releaseEnv({ ...ci, SPARKLE_FEED_URL: 'http://127.0.0.1:8123/appcast.xml' }).feedUrl).toBe(
      'http://127.0.0.1:8123/appcast.xml',
    );
  });

  test('refuses to start without a Developer ID identity, or with the ad-hoc identity', () => {
    expect(() => releaseEnv({ ...ci, DEVELOPER_ID_IDENTITY: undefined })).toThrow('DEVELOPER_ID_IDENTITY');
    expect(() => releaseEnv({ ...ci, DEVELOPER_ID_IDENTITY: '-' })).toThrow('--unsigned');
  });

  test('refuses a missing public key, or anything that is not a base64 32-byte key (e.g. a pasted private key)', () => {
    expect(() => releaseEnv({ ...ci, SPARKLE_PUBLIC_ED_KEY: '' })).toThrow('SPARKLE_PUBLIC_ED_KEY');
    expect(() => releaseEnv({ ...ci, SPARKLE_PUBLIC_ED_KEY: `${publicEdKey.slice(0, -1)}${publicEdKey}` })).toThrow(
      'SPARKLE_PUBLIC_ED_KEY',
    );
  });
});

describe('notaryAuth', () => {
  test('a developer Mac uses a stored keychain profile', () => {
    expect(notaryAuth({ NOTARY_PROFILE: 'aio-proxy-notary' })).toEqual(['--keychain-profile', 'aio-proxy-notary']);
  });

  test('a partial API key is an error, not a silent fall back to the profile', () => {
    expect(() => notaryAuth({ APPLE_API_KEY_ID: 'KEYID', NOTARY_PROFILE: 'aio-proxy-notary' })).toThrow('together');
  });

  test('no credentials at all is an error naming both options', () => {
    expect(() => notaryAuth({})).toThrow('NOTARY_PROFILE');
  });
});

test('the Team ID comes from the end of a Developer ID identity', () => {
  expect(teamIdOf('Developer ID Application: Team (TEAMID1234)')).toBe('TEAMID1234');
  expect(teamIdOf('Developer ID Application: Team')).toBeUndefined();
  expect(teamIdOf('')).toBeUndefined();
});
