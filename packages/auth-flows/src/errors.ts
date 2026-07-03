import { AioProxyError } from "@aio-proxy/core";

export class StaleProviderGenerationError extends AioProxyError {
  constructor(
    readonly vendor: string,
    readonly providerId: string,
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(
      "StaleProviderGenerationError",
      `auth row for ${vendor}:${providerId} has fingerprint ${actual}, expected ${expected}`,
    );
  }
}

export class AuthCasBusyError extends AioProxyError {
  constructor(
    readonly vendor: string,
    readonly providerId: string,
    readonly originalError: unknown,
  ) {
    super(
      "AuthCasBusyError",
      `auth row for ${vendor}:${providerId} is busy, retry later`,
    );
  }
}

export class AuthPayloadSerializationError extends AioProxyError {
  constructor() {
    super(
      "AuthPayloadSerializationError",
      "auth payload could not be serialized as JSON",
    );
  }
}

export class AuthPayloadParseError extends AioProxyError {
  constructor(readonly syntaxError: SyntaxError) {
    super(
      "AuthPayloadParseError",
      "auth payload stored in the database is not valid JSON",
    );
  }
}
