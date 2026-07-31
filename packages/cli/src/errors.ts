import { AioProxyError } from '@aio-proxy/core';

export class ProviderDashboardError extends AioProxyError {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super('ProviderDashboardError', `dashboard provider request failed with ${status}: ${url}`);
  }
}

export class ServeListenError extends AioProxyError {
  constructor(
    readonly host: string,
    readonly port: number,
    options?: ErrorOptions,
  ) {
    super(
      'ServeListenError',
      `Cannot start AIO Proxy on ${host}:${port}. Is another process already listening there?`,
      options,
    );
  }
}

export class ReloadError extends AioProxyError {
  // `transient` marks a recoverable failure (connection refused, timeout, 5xx) so the
  // exit-code contract restarts/retries it, versus a terminal reload rejection (e.g. a
  // 409 from an invalid config) that will not succeed on retry.
  constructor(
    message: string,
    readonly transient: boolean = false,
  ) {
    super('ReloadError', message);
  }
}

// Thrown by `status` after it has already emitted the result, so a health check or
// service script sees a nonzero exit when the daemon is unreachable. The message is
// empty because the human/JSON result is printed by the command itself.
export class StatusNotRunningError extends AioProxyError {
  constructor() {
    super('StatusNotRunningError', '');
  }
}

export class ConfigValidationError extends AioProxyError {
  constructor(message: string) {
    super('ConfigValidationError', message);
  }
}
