import { AppError } from '@aio-proxy/i18n';

import { ConfigValidationError, ReloadError, ServeListenError, StatusNotRunningError } from '../errors';
import {
  FormJsonInvalidError,
  FormNumberInvalidError,
  FormSchemaValidationError,
  pluginErrors,
} from '../plugin-commands';
import { isProviderLoginUserError } from '../plugin-commands/provider-login';
import { providerErrors } from '../provider-commands';

// Exit-code contract with the OS service manager (see the CLI redesign spec):
//   0 = normal, 1 = unrecoverable (retrying is futile), >=2 = transient (restart).
export const EXIT = { ok: 0, unrecoverable: 1, transient: 2 } as const;

export class CliExit extends Error {
  override readonly name = 'CliExit';
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

// CLI errors whose `message` is already a finished, user-facing string. These print
// verbatim (formatCliError) instead of going through locale formatting. i18n AppErrors
// are intentionally excluded here because their message is a raw code that
// formatUserError must localize.
export function isKnownCliUserError(err: unknown): err is Error {
  return (
    err instanceof CliExit ||
    err instanceof ServeListenError ||
    err instanceof ReloadError ||
    err instanceof StatusNotRunningError ||
    err instanceof ConfigValidationError ||
    isProviderLoginUserError(err) ||
    err instanceof FormNumberInvalidError ||
    err instanceof FormJsonInvalidError ||
    err instanceof FormSchemaValidationError ||
    (err instanceof Error && providerErrors.some((errorType) => err instanceof errorType)) ||
    (err instanceof Error && pluginErrors.some((errorType) => err instanceof errorType))
  );
}

// Unrecoverable = any known CLI user error (finished message) plus any i18n AppError
// (bad input/config/port). Retrying these will not help, so a service manager must
// not restart on them. Anything else is transient.
export function toExitCode(err: unknown): number {
  if (err instanceof CliExit) return err.code;
  // An unreachable daemon (status) is retryable, and a reload flagged transient
  // (transport failure / 5xx) must stay retryable — both map to a nonzero transient
  // code even though they are "known" CLI errors.
  if (err instanceof StatusNotRunningError) return EXIT.transient;
  if (err instanceof ReloadError) return err.transient ? EXIT.transient : EXIT.unrecoverable;
  if (isKnownCliUserError(err) || err instanceof AppError) return EXIT.unrecoverable;
  return EXIT.transient;
}
