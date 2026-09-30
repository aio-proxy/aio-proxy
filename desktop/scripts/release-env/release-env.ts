import { DEFAULT_FEED_URL } from '../info-plist';

type Env = Readonly<Record<string, string | undefined>>;

export type ReleaseEnv = {
  readonly identity: string;
  readonly publicEdKey: string;
  readonly feedUrl: string;
  readonly notaryAuth: readonly string[];
};

const present = (value: string | undefined): value is string => value !== undefined && value !== '';

// Base64 of a 32-byte Ed25519 public key: 43 characters and one pad.
const ED25519_PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/u;

/** Notary credentials: an App Store Connect API key in CI, or a stored keychain profile on a developer Mac. */
export function notaryAuth(env: Env): string[] {
  const key = env['APPLE_API_KEY_PATH'];
  const keyId = env['APPLE_API_KEY_ID'];
  const issuer = env['APPLE_API_ISSUER_ID'];
  if (present(key) && present(keyId) && present(issuer)) return ['--key', key, '--key-id', keyId, '--issuer', issuer];
  if (present(key) || present(keyId) || present(issuer)) {
    throw new Error('APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID must be set together');
  }
  const profile = env['NOTARY_PROFILE'];
  if (present(profile)) return ['--keychain-profile', profile];
  throw new Error('notarization needs APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID, or NOTARY_PROFILE');
}

/** Everything `desktop:bundle --release` needs, checked before the long build starts. */
export function releaseEnv(env: Env): ReleaseEnv {
  const identity = env['DEVELOPER_ID_IDENTITY'];
  if (!present(identity)) {
    throw new Error('DEVELOPER_ID_IDENTITY is required, e.g. "Developer ID Application: <Team> (<TEAMID>)"');
  }
  if (identity === '-') throw new Error('--release never signs ad-hoc; use --unsigned');
  const publicEdKey = env['SPARKLE_PUBLIC_ED_KEY'];
  if (!present(publicEdKey) || !ED25519_PUBLIC_KEY.test(publicEdKey)) {
    throw new Error('SPARKLE_PUBLIC_ED_KEY must be the base64 32-byte EdDSA public key');
  }
  const feedOverride = env['SPARKLE_FEED_URL'];
  return {
    identity,
    publicEdKey,
    feedUrl: present(feedOverride) ? feedOverride : DEFAULT_FEED_URL,
    notaryAuth: notaryAuth(env),
  };
}
