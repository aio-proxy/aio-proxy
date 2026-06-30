import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { m } from "./paraglide/messages";
import type { Locale } from "./resolve";

const ERROR_CODES = {
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

type AppErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

type AppErrorMessageKey =
  | "cli_error_config_invalid"
  | "cli_error_config_not_found"
  | "cli_error_config_write_failed"
  | "cli_error_port_out_of_range"
  | "error_invalid_locale";

export type FormattedUserError = {
  readonly code: string;
  readonly message: string;
};

export class AppError extends Error {
  override readonly name: string = "AppError";

  constructor(
    readonly code: AppErrorCode,
    readonly messageKey: AppErrorMessageKey,
  ) {
    super(code);
  }
}

export class ProviderNotInstalledError extends AppError {
  override readonly name = "ProviderNotInstalledError";

  constructor(readonly pkg: string) {
    super(ERROR_CODES.providerNotInstalled, "error_invalid_locale");
  }
}

export class PortOutOfRangeError extends AppError {
  override readonly name = "PortOutOfRangeError";

  constructor(readonly port: string) {
    super(ERROR_CODES.portOutOfRange, "cli_error_port_out_of_range");
  }
}

export class ConfigWriteError extends AppError {
  override readonly name = "ConfigWriteError";

  constructor(readonly path: string) {
    super(ERROR_CODES.configWriteFailed, "cli_error_config_write_failed");
  }
}

export class AliasCollisionError extends AppError {
  override readonly name = "AliasCollisionError";

  constructor(
    readonly alias: string,
    readonly providerA: string,
    readonly providerB: string,
  ) {
    super(ERROR_CODES.aliasCollision, "error_invalid_locale");
  }
}

export class StaleProviderGenerationError extends AppError {
  override readonly name = "StaleProviderGenerationError";

  constructor(readonly provider: string) {
    super(ERROR_CODES.staleProviderGeneration, "error_invalid_locale");
  }
}

function formatAppError(err: AppError, locale: Locale): FormattedUserError {
  switch (err.messageKey) {
    case "cli_error_config_invalid":
      return {
        code: err.code,
        message: m.cli_error_config_invalid({}, { locale }),
      };
    case "cli_error_config_not_found":
      return {
        code: err.code,
        message: m.cli_error_config_not_found({}, { locale }),
      };
    case "cli_error_config_write_failed":
      if (err instanceof ConfigWriteError) {
        return {
          code: err.code,
          message: m.cli_error_config_write_failed(
            { path: err.path },
            { locale },
          ),
        };
      }
      return {
        code: err.code,
        message: m.cli_error_config_write_failed({ path: "" }, { locale }),
      };
    case "cli_error_port_out_of_range":
      if (err instanceof PortOutOfRangeError) {
        return {
          code: err.code,
          message: m.cli_error_port_out_of_range(
            { port: err.port },
            { locale },
          ),
        };
      }
      return {
        code: err.code,
        message: m.cli_error_port_out_of_range({ port: "" }, { locale }),
      };
    case "error_invalid_locale":
      return {
        code: err.code,
        message: m.error_invalid_locale({}, { locale }),
      };
  }
}

export function formatUserError(
  err: unknown,
  locale: Locale,
): FormattedUserError {
  if (err instanceof ProviderNotInstalledError) {
    return {
      code: err.code,
      message: m.error_provider_not_installed({ pkg: err.pkg }, { locale }),
    };
  }

  if (err instanceof AliasCollisionError) {
    return {
      code: err.code,
      message: m.error_alias_collision(
        {
          alias: err.alias,
          providerA: err.providerA,
          providerB: err.providerB,
        },
        { locale },
      ),
    };
  }

  if (err instanceof StaleProviderGenerationError) {
    return {
      code: err.code,
      message: m.error_stale_provider_generation(
        { provider: err.provider },
        { locale },
      ),
    };
  }

  if (err instanceof AppError) {
    return formatAppError(err, locale);
  }

  if (err instanceof ZodError) {
    return {
      code: ERROR_CODES.validationFailed,
      message: m.error_validation_failed({}, { locale }),
    };
  }

  if (err instanceof HTTPException) {
    return {
      code: ERROR_CODES.httpException,
      message: m.error_http_exception({ status: err.status }, { locale }),
    };
  }

  return {
    code: ERROR_CODES.internalUnexpected,
    message: m.error_internal_unexpected({}, { locale }),
  };
}
