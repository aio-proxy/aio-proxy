export class OAuthCredentialRefreshError extends Error {
  readonly code = 'OAUTH_CREDENTIAL_REFRESH_FAILED';

  constructor() {
    super('OAuth credential refresh failed');
    this.name = 'OAuthCredentialRefreshError';
  }
}
