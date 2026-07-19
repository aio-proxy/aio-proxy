import { providerLoginCommand } from "@aio-proxy/types";

export type OAuthCapabilityReference = { readonly plugin: string; readonly capability: string };

export class ProviderAccountAlreadyExistsError extends Error {
  override readonly name = "ProviderAccountAlreadyExistsError";
  readonly suggestedCommand: string;
  constructor(readonly existingProviderId: string) {
    super("PROVIDER_ACCOUNT_ALREADY_EXISTS");
    this.suggestedCommand = providerLoginCommand(existingProviderId);
  }
}
export class AccountCleanupPendingError extends Error {
  override readonly name = "AccountCleanupPendingError";
  constructor(readonly providerId: string) {
    super("ACCOUNT_CLEANUP_PENDING");
  }
}
export class ProviderAccountChangedError extends Error {
  override readonly name = "ProviderAccountChangedError";
  constructor(readonly providerId: string) {
    super("PROVIDER_ACCOUNT_CHANGED");
  }
}
export class ProviderFingerprintMismatchError extends Error {
  override readonly name = "ProviderFingerprintMismatchError";
  constructor(readonly providerId: string) {
    super("PROVIDER_FINGERPRINT_MISMATCH");
  }
}
export class ProviderCapabilityTargetMismatchError extends Error {
  override readonly name = "ProviderCapabilityTargetMismatchError";
  constructor(
    readonly requested: OAuthCapabilityReference,
    readonly target: OAuthCapabilityReference,
  ) {
    super("PROVIDER_CAPABILITY_TARGET_MISMATCH");
  }
}
export class OAuthLoginResultValidationError extends Error {
  override readonly name = "OAuthLoginResultValidationError";
  constructor() {
    super("OAUTH_LOGIN_RESULT_INVALID");
  }
}
export class AccountOptionsValidationError extends Error {
  override readonly name = "AccountOptionsValidationError";
  constructor() {
    super("ACCOUNT_OPTIONS_INVALID");
  }
}
export class OAuthLoginTimeoutError extends Error {
  override readonly name = "OAuthLoginTimeoutError";
  constructor() {
    super("OAUTH_LOGIN_TIMEOUT");
  }
}
export class OAuthCatalogDiscoveryTimeoutError extends Error {
  override readonly name = "OAuthCatalogDiscoveryTimeoutError";
  constructor() {
    super("OAUTH_CATALOG_DISCOVERY_TIMEOUT");
  }
}
export class OAuthCapabilityRequiredError extends Error {
  override readonly name = "OAuthCapabilityRequiredError";
  constructor() {
    super("OAUTH_CAPABILITY_REQUIRED");
  }
}
export class OAuthCapabilityUnavailableError extends Error {
  override readonly name = "OAuthCapabilityUnavailableError";
  constructor(
    readonly plugin: string,
    readonly capability: string,
  ) {
    super("OAUTH_CAPABILITY_UNAVAILABLE");
  }
}
export class ProviderConfigInvalidError extends Error {
  override readonly name = "ProviderConfigInvalidError";
  constructor() {
    super("PROVIDER_CONFIG_INVALID");
  }
}
