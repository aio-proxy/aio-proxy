import { m } from "@aio-proxy/i18n";

export class ProviderCapabilityNotFoundError extends Error {
  override readonly name = "ProviderCapabilityNotFoundError";
  constructor(readonly reference?: string) {
    super(
      reference === undefined
        ? m.cli_provider_login_error_capability_not_found_any()
        : m.cli_provider_login_error_capability_not_found({ reference }),
    );
  }
}

export class ProviderCapabilityAmbiguousError extends Error {
  override readonly name = "ProviderCapabilityAmbiguousError";
  constructor(
    readonly input: string,
    readonly references: readonly string[],
  ) {
    const joined = references.join(", ");
    super(
      input.length === 0
        ? m.cli_provider_login_error_capability_ambiguous_selection({ references: joined })
        : m.cli_provider_login_error_capability_ambiguous({ input, references: joined }),
    );
  }
}

export class ProviderCapabilityMismatchError extends Error {
  override readonly name = "ProviderCapabilityMismatchError";
  constructor(
    readonly requested: string,
    readonly target: string,
  ) {
    super(m.cli_provider_login_error_capability_mismatch({ requested, target }));
  }
}

export class ProviderTargetNotFoundError extends Error {
  override readonly name = "ProviderTargetNotFoundError";
  constructor(readonly providerId: string) {
    super(m.cli_provider_login_error_target_not_found({ provider: providerId }));
  }
}

export class ProviderTargetInvalidError extends Error {
  override readonly name = "ProviderTargetInvalidError";
  constructor(readonly providerId: string) {
    super(m.cli_provider_login_error_target_invalid({ provider: providerId }));
  }
}
