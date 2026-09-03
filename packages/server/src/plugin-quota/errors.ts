export class OAuthQuotaCapabilityUnavailableError extends Error {
  readonly code = 'OAUTH_QUOTA_CAPABILITY_UNAVAILABLE';

  /**
   * `true` only when the plugin genuinely exposes no quota capability, which cannot change without a
   * config or plugin change. Every other preparation failure — bad credentials, unreadable secrets,
   * invalid account options — surfaces as the same error so callers cannot probe the account, but it
   * is transient and must stay retryable. The cache latches on this flag alone; without it, one
   * expired token would disable quota for the process lifetime.
   */
  constructor(readonly permanent = false) {
    super('OAuth quota capability is unavailable');
    this.name = 'OAuthQuotaCapabilityUnavailableError';
  }
}

export class OAuthQuotaReadError extends Error {
  readonly code = 'OAUTH_QUOTA_READ_FAILED';

  constructor() {
    super('OAuth quota read failed');
    this.name = 'OAuthQuotaReadError';
  }
}

export class OAuthQuotaResetUnsupportedError extends Error {
  readonly code = 'OAUTH_QUOTA_RESET_UNSUPPORTED';

  constructor() {
    super('OAuth quota reset is unsupported');
    this.name = 'OAuthQuotaResetUnsupportedError';
  }
}

export class OAuthQuotaResetUnavailableError extends Error {
  readonly code = 'OAUTH_QUOTA_RESET_UNAVAILABLE';

  constructor() {
    super('OAuth quota reset is unavailable');
    this.name = 'OAuthQuotaResetUnavailableError';
  }
}

export class OAuthQuotaResetError extends Error {
  readonly code = 'OAUTH_QUOTA_RESET_FAILED';

  constructor() {
    super('OAuth quota reset failed');
    this.name = 'OAuthQuotaResetError';
  }
}
