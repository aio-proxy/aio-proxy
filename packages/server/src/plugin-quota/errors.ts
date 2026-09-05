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

/**
 * The preflight could not learn how many credits remain: a `reset`-capable adapter reports
 * `{ availableCount: 0 }` for an inventory it knows is empty and omits `resetCredits` only when the
 * upstream inventory was unreadable. Distinct from `OAuthQuotaResetUnavailableError` because that one
 * asserts the credit is gone — telling a user that on a timed-out inventory request is a lie, and it
 * is retryable rather than a reason to stop offering redemption.
 */
export class OAuthQuotaResetInventoryUnknownError extends Error {
  readonly code = 'OAUTH_QUOTA_RESET_INVENTORY_UNKNOWN';

  constructor() {
    super('OAuth quota reset inventory is unknown');
    this.name = 'OAuthQuotaResetInventoryUnknownError';
  }
}

export class OAuthQuotaResetError extends Error {
  readonly code = 'OAUTH_QUOTA_RESET_FAILED';

  constructor() {
    super('OAuth quota reset failed');
    this.name = 'OAuthQuotaResetError';
  }
}
