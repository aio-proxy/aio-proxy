export class OAuthQuotaCapabilityUnavailableError extends Error {
  readonly code = "OAUTH_QUOTA_CAPABILITY_UNAVAILABLE";

  constructor() {
    super("OAuth quota capability is unavailable");
    this.name = "OAuthQuotaCapabilityUnavailableError";
  }
}

export class OAuthQuotaReadError extends Error {
  readonly code = "OAUTH_QUOTA_READ_FAILED";

  constructor() {
    super("OAuth quota read failed");
    this.name = "OAuthQuotaReadError";
  }
}

export class OAuthQuotaResetUnsupportedError extends Error {
  readonly code = "OAUTH_QUOTA_RESET_UNSUPPORTED";

  constructor() {
    super("OAuth quota reset is unsupported");
    this.name = "OAuthQuotaResetUnsupportedError";
  }
}

export class OAuthQuotaResetUnavailableError extends Error {
  readonly code = "OAUTH_QUOTA_RESET_UNAVAILABLE";

  constructor() {
    super("OAuth quota reset is unavailable");
    this.name = "OAuthQuotaResetUnavailableError";
  }
}

export class OAuthQuotaResetError extends Error {
  readonly code = "OAUTH_QUOTA_RESET_FAILED";

  constructor() {
    super("OAuth quota reset failed");
    this.name = "OAuthQuotaResetError";
  }
}
