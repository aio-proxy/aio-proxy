import type { ZodType } from 'zod';

import type { ConfigSpec } from './config';
import type { LocalizedText } from './localized-text';
import type { ModelCatalog, OAuthRuntimeResult } from './runtime';

export const CATALOG_DISCOVERY_TIMEOUT_MS = 30_000;

export type DefaultAliasTarget = {
  readonly model: string;
  readonly preserve?: boolean;
};

export type DefaultAliasSelectRow = {
  readonly when: {
    readonly thinking?: boolean;
    readonly effort?: string;
    readonly speed?: 'flex' | 'standard' | 'fast';
  };
  readonly model: string;
  readonly preserve?: boolean;
};

export type DefaultAliasSuggestion = DefaultAliasTarget & {
  readonly variants?: readonly DefaultAliasSelectRow[];
};

export type DefaultAliasSuggestions = Readonly<Record<string, DefaultAliasSuggestion>>;

export class CredentialRefreshError extends Error {
  override readonly name = 'CredentialRefreshError';

  constructor(
    message: string,
    readonly options: { readonly retryable: boolean; readonly reason: string; readonly status?: number },
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.options.retryable;
  }
}

export type DeviceCodePresentation = {
  readonly url: string;
  readonly userCode: string;
  readonly instructions?: LocalizedText;
};

export type LoopbackRequest = {
  readonly state: string;
  readonly redirect: {
    readonly hostname: 'localhost' | '127.0.0.1';
    readonly port: number | 'dynamic';
    readonly path: `/${string}`;
  };
  readonly authorizationUrl: (input: { readonly redirectUri: string }) => string;
  readonly allowManualCallbackUrl: boolean;
};

export type AuthorizationPort = {
  readonly presentDeviceCode: (input: DeviceCodePresentation) => Promise<void>;
  readonly presentAuthorizeUrl: (input: {
    readonly url: string;
    readonly instructions?: LocalizedText;
  }) => Promise<void>;
  readonly loopback: (input: LoopbackRequest) => Promise<{ readonly code: string; readonly redirectUri: string }>;
};

export type OAuthLoginContext = {
  readonly authorization: AuthorizationPort;
  readonly progress: (message: LocalizedText) => void;
  readonly signal: AbortSignal;
  readonly fetch?: RuntimeFetch;
};

export type OAuthLoginResult<Credential> = {
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly accountLabel?: string;
  readonly credentials: Credential;
  readonly expiresAt?: number;
};

export type OAuthCredentialImportContext = {
  readonly progress: (message: LocalizedText) => void;
  readonly signal: AbortSignal;
  readonly fetch?: RuntimeFetch;
};

export type OAuthCredentialImporter<AccountOptions, Credential> = {
  readonly types: readonly [string, ...string[]];
  readonly import: (
    context: OAuthCredentialImportContext,
    options: AccountOptions,
    raw: unknown,
  ) => Promise<OAuthLoginResult<Credential>>;
};

export type CredentialSnapshot<Credential> = {
  readonly value: Credential;
  readonly revision: number;
};

export type CredentialPort<Credential> = {
  readonly read: () => Promise<CredentialSnapshot<Credential>>;
  readonly refresh: (
    expectedRevision: number,
    exchange: (
      current: CredentialSnapshot<Credential>,
      signal: AbortSignal,
    ) => Promise<{
      readonly value: Credential;
      readonly metadata?: { readonly accountLabel?: string; readonly expiresAt?: number };
    }>,
  ) => Promise<
    | { readonly status: 'updated'; readonly snapshot: CredentialSnapshot<Credential> }
    | { readonly status: 'superseded'; readonly snapshot: CredentialSnapshot<Credential> }
  >;
};

export type AccountContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly signal: AbortSignal;
  readonly fetch?: RuntimeFetch;
};

export type OAuthQuotaItem = {
  readonly id: string;
  readonly displayName: LocalizedText;
  readonly remainingRatio?: number;
  readonly resetsAt?: number;
};

export type OAuthQuotaResetCredit = {
  readonly id: string;
  readonly expiresAt?: number;
};

export type OAuthQuotaResetCredits = {
  readonly availableCount: number;
  readonly items?: readonly OAuthQuotaResetCredit[];
};

export type OAuthQuotaSnapshot = {
  readonly items: readonly OAuthQuotaItem[];
  readonly resetCredits?: OAuthQuotaResetCredits;
  /** Human-readable subscription tier for this account, when the upstream exposes one. */
  readonly plan?: LocalizedText;
};

export type OAuthQuotaCapability<AccountOptions, Credential> = {
  readonly read: (context: AccountContext<Credential, AccountOptions>) => Promise<OAuthQuotaSnapshot>;
  readonly reset?: (context: AccountContext<Credential, AccountOptions>) => Promise<void>;
};

export type RuntimeFetchTraffic = 'model' | 'control';

export type RuntimeRequestInit = RequestInit & {
  readonly aioProxy?: {
    readonly traffic?: RuntimeFetchTraffic;
  };
};

export type RuntimeFetch = typeof globalThis.fetch & {
  (input: RequestInfo | URL, init?: RuntimeRequestInit): Promise<Response>;
};

export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
  readonly fetch: RuntimeFetch;
};

export type OAuthAdapter<AccountOptions = unknown, Credential = unknown> = {
  readonly id: string;
  readonly displayName: LocalizedText;
  readonly description?: LocalizedText;
  readonly supportsProxy?: boolean;
  readonly account: { readonly options: ConfigSpec<AccountOptions> };
  readonly credentials: ZodType<Credential>;
  readonly login: (context: OAuthLoginContext, options: AccountOptions) => Promise<OAuthLoginResult<Credential>>;
  readonly credentialImports?: {
    readonly cpa?: OAuthCredentialImporter<AccountOptions, Credential>;
  };
  readonly catalog: {
    readonly policy: { readonly kind: 'static' } | { readonly kind: 'ttl'; readonly ttlMs: number };
    readonly discover: (context: AccountContext<Credential, AccountOptions>) => Promise<ModelCatalog>;
    readonly initialFallback?: (error: unknown) => ModelCatalog | undefined;
    readonly defaultAliases?: (catalog: ModelCatalog) => DefaultAliasSuggestions;
  };
  readonly createRuntime: (context: RuntimeContext<Credential, AccountOptions>) => Promise<OAuthRuntimeResult>;
  readonly quota?: OAuthQuotaCapability<AccountOptions, Credential>;
};
