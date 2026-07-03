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
