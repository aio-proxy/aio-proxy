import { AioProxyError } from "@aio-proxy/core";

export class ProviderDashboardError extends AioProxyError {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(
      "ProviderDashboardError",
      `dashboard provider request failed with ${status}: ${url}`,
    );
  }
}

export class ServeListenError extends AioProxyError {
  constructor(
    readonly host: string,
    readonly port: number,
    options?: ErrorOptions,
  ) {
    super(
      "ServeListenError",
      `Cannot start AIO Proxy on ${host}:${port}. Is another process already listening there?`,
      options,
    );
  }
}
