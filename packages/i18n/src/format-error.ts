import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import {
  AliasCollisionError,
  AppError,
  ConfigWriteError,
  ERROR_CODES,
  PortOutOfRangeError,
  ProviderNotInstalledError,
  StaleProviderGenerationError,
} from "./errors";
import { m } from "./paraglide/messages";
import type { Locale } from "./resolve";

export type FormattedUserError = {
  readonly code: string;
  readonly message: string;
};

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
