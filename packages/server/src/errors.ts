import { AioProxyError } from "@aio-proxy/core";

export class ProviderBuildError extends AioProxyError {
  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super("ProviderBuildError", `${providerId}: ${message}`);
  }
}
