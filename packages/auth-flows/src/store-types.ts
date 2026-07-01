export type AuthRecord = {
  readonly vendor: string;
  readonly providerId: string;
  readonly accountFingerprint: string | null;
  readonly payload: unknown;
};

export type AuthSummary = {
  readonly vendor: string;
  readonly providerId: string;
  readonly hasToken: boolean;
  readonly expiresAt: number | null;
  readonly accountLabel: string | null;
};

export type AuthCasCurrent = {
  readonly payload: unknown;
  readonly accountFingerprint: string | null;
};

export type AuthCasNext = {
  readonly payload: unknown;
  readonly accountFingerprint: string;
};

export class StaleProviderGenerationError extends Error {
  override readonly name = "StaleProviderGenerationError";

  constructor(
    readonly vendor: string,
    readonly providerId: string,
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(
      `auth row for ${vendor}:${providerId} has fingerprint ${actual}, expected ${expected}`,
    );
  }
}

export class AuthCasBusyError extends Error {
  override readonly name = "AuthCasBusyError";

  constructor(
    readonly vendor: string,
    readonly providerId: string,
    readonly originalError: unknown,
  ) {
    super(`auth row for ${vendor}:${providerId} is busy, retry later`);
  }
}

export class AuthPayloadSerializationError extends Error {
  override readonly name = "AuthPayloadSerializationError";

  constructor() {
    super("auth payload could not be serialized as JSON");
  }
}

export class AuthPayloadParseError extends Error {
  override readonly name = "AuthPayloadParseError";

  constructor(readonly syntaxError: SyntaxError) {
    super("auth payload stored in the database is not valid JSON");
  }
}
