import { m } from "@aio-proxy/i18n";

export class AuthorizationUrlInvalidError extends Error {
  override readonly name = "AuthorizationUrlInvalidError";
  constructor() {
    super(m.cli_oauth_error_authorization_url_invalid());
  }
}

export class LoopbackRequestInvalidError extends Error {
  override readonly name = "LoopbackRequestInvalidError";
  constructor() {
    super(m.cli_oauth_error_loopback_request_invalid());
  }
}

export class LoopbackCallbackInvalidError extends Error {
  override readonly name = "LoopbackCallbackInvalidError";
  constructor() {
    super(m.cli_oauth_error_callback_invalid());
  }
}

export class LoopbackCallbackMismatchError extends Error {
  override readonly name = "LoopbackCallbackMismatchError";
  constructor() {
    super(m.cli_oauth_error_callback_mismatch());
  }
}

export class LoopbackStateMismatchError extends Error {
  override readonly name = "LoopbackStateMismatchError";
  constructor() {
    super(m.cli_oauth_error_state_mismatch());
  }
}

export class LoopbackCodeMissingError extends Error {
  override readonly name = "LoopbackCodeMissingError";
  constructor() {
    super(m.cli_oauth_error_code_missing());
  }
}

export class LoopbackOAuthError extends Error {
  override readonly name = "LoopbackOAuthError";
  constructor() {
    super(m.cli_oauth_error_provider_denied());
  }
}

export class LoopbackTimeoutError extends Error {
  override readonly name = "LoopbackTimeoutError";
  constructor() {
    super(m.cli_oauth_error_timeout());
  }
}

export class LoopbackAbortedError extends Error {
  override readonly name = "LoopbackAbortedError";
  constructor() {
    super(m.cli_oauth_error_aborted());
  }
}

export class LoopbackPortUnavailableError extends Error {
  override readonly name = "LoopbackPortUnavailableError";
  constructor(readonly port: number) {
    super(m.cli_oauth_error_port_unavailable({ port }));
  }
}

export class LoopbackManualInputError extends Error {
  override readonly name = "LoopbackManualInputError";
  constructor() {
    super(m.cli_oauth_error_manual_input());
  }
}

export class LoopbackManualConfirmationError extends Error {
  override readonly name = "LoopbackManualConfirmationError";
  constructor() {
    super(m.cli_oauth_error_manual_confirmation());
  }
}

export class LoopbackAuthorizationUrlBuildError extends Error {
  override readonly name = "LoopbackAuthorizationUrlBuildError";
  constructor() {
    super(m.cli_oauth_error_authorization_url_build());
  }
}

const loopbackUserErrors = [
  AuthorizationUrlInvalidError,
  LoopbackRequestInvalidError,
  LoopbackCallbackInvalidError,
  LoopbackCallbackMismatchError,
  LoopbackStateMismatchError,
  LoopbackCodeMissingError,
  LoopbackOAuthError,
  LoopbackTimeoutError,
  LoopbackAbortedError,
  LoopbackPortUnavailableError,
  LoopbackManualInputError,
  LoopbackManualConfirmationError,
  LoopbackAuthorizationUrlBuildError,
] as const;

export function isLoopbackUserError(error: unknown): error is Error {
  return error instanceof Error && loopbackUserErrors.some((errorType) => error instanceof errorType);
}
