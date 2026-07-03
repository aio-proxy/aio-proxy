export const ERROR_CODES = {
  aliasCollision: "alias_collision",
  configInvalid: "config_invalid",
  configNotFound: "config_not_found",
  configWriteFailed: "config_write_failed",
  httpException: "http_exception",
  internalUnexpected: "internal_unexpected",
  invalidLocale: "invalid_locale",
  portOutOfRange: "port_out_of_range",
  providerNotInstalled: "provider_not_installed",
  staleProviderGeneration: "stale_provider_generation",
  validationFailed: "validation_failed",
} as const;

export type AppErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export type AppErrorMessageKey =
  | "cli_error_config_invalid"
  | "cli_error_config_not_found"
  | "cli_error_config_write_failed"
  | "cli_error_port_out_of_range"
  | "error_invalid_locale";

export class AppError extends Error {
  override readonly name: string;

  constructor(
    readonly code: AppErrorCode,
    readonly messageKey: AppErrorMessageKey,
    name = "AppError",
  ) {
    super(code);
    this.name = name;
  }
}

export class ProviderNotInstalledError extends AppError {
  constructor(readonly pkg: string) {
    super(
      ERROR_CODES.providerNotInstalled,
      "error_invalid_locale",
      "ProviderNotInstalledError",
    );
  }
}

export class PortOutOfRangeError extends AppError {
  constructor(readonly port: string) {
    super(
      ERROR_CODES.portOutOfRange,
      "cli_error_port_out_of_range",
      "PortOutOfRangeError",
    );
  }
}

export class ConfigWriteError extends AppError {
  constructor(readonly path: string) {
    super(
      ERROR_CODES.configWriteFailed,
      "cli_error_config_write_failed",
      "ConfigWriteError",
    );
  }
}

export class AliasCollisionError extends AppError {
  constructor(
    readonly alias: string,
    readonly providerA: string,
    readonly providerB: string,
  ) {
    super(
      ERROR_CODES.aliasCollision,
      "error_invalid_locale",
      "AliasCollisionError",
    );
  }
}

export class StaleProviderGenerationError extends AppError {
  constructor(readonly provider: string) {
    super(
      ERROR_CODES.staleProviderGeneration,
      "error_invalid_locale",
      "StaleProviderGenerationError",
    );
  }
}
