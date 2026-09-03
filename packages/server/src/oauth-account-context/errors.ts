export class OAuthAccountUnavailableError extends Error {
  readonly code = 'OAUTH_ACCOUNT_UNAVAILABLE';

  /**
   * `true` only when the plugin genuinely does not expose the requested capability, or the Provider
   * is not an OAuth Provider at all — neither can change without a config or plugin change. Every
   * other preparation failure (bad credentials, unreadable secrets, invalid account options)
   * surfaces as the same error so callers cannot probe the account, but stays transient.
   */
  constructor(readonly permanent = false) {
    super('OAuth account is unavailable');
    this.name = 'OAuthAccountUnavailableError';
  }
}
