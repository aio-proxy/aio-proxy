import {
  AccountCleanupPendingError,
  AccountOptionsValidationError,
  type OAuthCapabilityReference,
  OAuthCapabilityRequiredError,
  OAuthCapabilityUnavailableError,
  OAuthLoginResultValidationError,
  OAuthLoginTimeoutError,
  ProviderAccountAlreadyExistsError,
  ProviderAccountChangedError,
  ProviderCapabilityTargetMismatchError,
  ProviderConfigInvalidError,
  ProviderFingerprintMismatchError,
  ProviderIdCollisionError,
} from "@aio-proxy/core";
import { m } from "@aio-proxy/i18n";
import { providerLoginCommand } from "@aio-proxy/types";
import { isLoopbackUserError } from "../loopback";
import { canonical } from "./capability";
import {
  ProviderCapabilityAmbiguousError,
  ProviderCapabilityMismatchError,
  ProviderCapabilityNotFoundError,
  ProviderTargetInvalidError,
  ProviderTargetNotFoundError,
} from "./errors";

const providerLoginPresentationErrors = new WeakSet<Error>();

function safeText(value: unknown, allowEmpty = false): string | null {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > 256) return null;
  return value.replaceAll(/[\p{Cc}\p{Cf}]/gu, "�");
}

function safeIdentifier(value: unknown): string | null {
  return safeText(value);
}

function safeProperty(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCapability(value: unknown): OAuthCapabilityReference | null {
  if (!isRecord(value)) return null;
  const plugin = safeIdentifier(safeProperty(value, "plugin"));
  const capability = safeIdentifier(safeProperty(value, "capability"));
  return plugin === null || capability === null ? null : { plugin, capability };
}

function presentationError(message: string): Error {
  const presented = new Error(message);
  presented.name = "ProviderLoginPresentationError";
  providerLoginPresentationErrors.add(presented);
  return presented;
}

export function presentProviderLoginUserError(error: unknown): Error | null {
  if (error instanceof ProviderAccountAlreadyExistsError) {
    const provider = safeIdentifier(safeProperty(error, "existingProviderId"));
    if (provider === null) return null;
    return presentationError(
      m.cli_provider_login_error_account_exists({ provider, command: providerLoginCommand(provider) }),
    );
  } else if (error instanceof AccountCleanupPendingError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_cleanup_pending({ provider }));
  } else if (error instanceof ProviderAccountChangedError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_account_changed({ provider }));
  } else if (error instanceof ProviderFingerprintMismatchError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_fingerprint_mismatch({ provider }));
  } else if (error instanceof ProviderCapabilityTargetMismatchError) {
    const requested = safeCapability(safeProperty(error, "requested"));
    const target = safeCapability(safeProperty(error, "target"));
    return requested === null || target === null
      ? null
      : presentationError(
          m.cli_provider_login_error_target_mismatch({ requested: canonical(requested), target: canonical(target) }),
        );
  } else if (error instanceof OAuthLoginResultValidationError) {
    return presentationError(m.cli_provider_login_error_result_invalid());
  } else if (error instanceof AccountOptionsValidationError) {
    return presentationError(m.cli_provider_login_error_options_invalid());
  } else if (error instanceof ProviderConfigInvalidError) {
    return presentationError(m.cli_provider_login_error_config_invalid());
  } else if (error instanceof OAuthLoginTimeoutError) {
    return presentationError(m.cli_provider_login_error_timeout());
  } else if (error instanceof OAuthCapabilityRequiredError) {
    return presentationError(m.cli_provider_login_error_capability_required());
  } else if (error instanceof OAuthCapabilityUnavailableError) {
    const reference = safeCapability(error);
    return reference === null
      ? null
      : presentationError(m.cli_provider_login_error_capability_unavailable({ reference: canonical(reference) }));
  } else if (error instanceof ProviderIdCollisionError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_provider_id_collision({ provider }));
  } else if (error instanceof ProviderCapabilityNotFoundError) {
    const reference = safeProperty(error, "reference");
    if (reference === undefined) return presentationError(m.cli_provider_login_error_capability_not_found_any());
    const safeReference = safeIdentifier(reference);
    return safeReference === null
      ? null
      : presentationError(m.cli_provider_login_error_capability_not_found({ reference: safeReference }));
  } else if (error instanceof ProviderCapabilityAmbiguousError) {
    const inputValue = safeText(safeProperty(error, "input"), true);
    const rawReferences = safeProperty(error, "references");
    if (inputValue === null || !Array.isArray(rawReferences) || rawReferences.length > 32) return null;
    const references = rawReferences.map(safeIdentifier);
    if (references.some((reference) => reference === null)) return null;
    const joined = (references as string[]).join(", ");
    return presentationError(
      inputValue.length === 0
        ? m.cli_provider_login_error_capability_ambiguous_selection({ references: joined })
        : m.cli_provider_login_error_capability_ambiguous({ input: inputValue, references: joined }),
    );
  } else if (error instanceof ProviderCapabilityMismatchError) {
    const requested = safeIdentifier(safeProperty(error, "requested"));
    const target = safeIdentifier(safeProperty(error, "target"));
    return requested === null || target === null
      ? null
      : presentationError(m.cli_provider_login_error_capability_mismatch({ requested, target }));
  } else if (error instanceof ProviderTargetNotFoundError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_target_not_found({ provider }));
  } else if (error instanceof ProviderTargetInvalidError) {
    const provider = safeIdentifier(safeProperty(error, "providerId"));
    return provider === null ? null : presentationError(m.cli_provider_login_error_target_invalid({ provider }));
  }
  return null;
}

export function isProviderLoginUserError(error: unknown): error is Error {
  return isLoopbackUserError(error) || (error instanceof Error && providerLoginPresentationErrors.has(error));
}
