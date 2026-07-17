import type { ZodType } from "zod";
import type { ConfigSpec } from "./config";
import type { LocalizedText } from "./localized-text";
import type { ModelCatalog, OAuthRuntimeResult } from "./runtime";

export type LobeIconKey = AioProxyLobeIconKey;

export type OAuthIcon = LobeIconKey | `http://${string}` | `https://${string}` | `data:image/${string}`;

export type DeviceCodePresentation = {
  readonly url: string;
  readonly userCode: string;
  readonly instructions?: LocalizedText;
};

export type LoopbackRequest = {
  readonly state: string;
  readonly redirect: {
    readonly hostname: "localhost" | "127.0.0.1";
    readonly port: number | "dynamic";
    readonly path: `/${string}`;
  };
  readonly authorizationUrl: (input: { readonly redirectUri: string }) => string;
  readonly allowManualCallbackUrl: boolean;
};

export type AuthorizationPort = {
  readonly presentDeviceCode: (input: DeviceCodePresentation) => Promise<void>;
  readonly loopback: (input: LoopbackRequest) => Promise<{ readonly code: string; readonly redirectUri: string }>;
};

export type OAuthLoginContext = {
  readonly authorization: AuthorizationPort;
  readonly progress: (message: LocalizedText) => void;
  readonly signal: AbortSignal;
};

export type OAuthLoginResult<Credential> = {
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly label?: string;
  readonly credentials: Credential;
  readonly expiresAt?: number;
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
      readonly metadata?: { readonly label?: string; readonly expiresAt?: number };
    }>,
  ) => Promise<
    | { readonly status: "updated"; readonly snapshot: CredentialSnapshot<Credential> }
    | { readonly status: "superseded"; readonly snapshot: CredentialSnapshot<Credential> }
  >;
};

export type AccountContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly signal: AbortSignal;
};

export type RuntimeContext<Credential, AccountOptions> = {
  readonly credentials: CredentialPort<Credential>;
  readonly options: AccountOptions;
  readonly catalog: ModelCatalog;
};

export type OAuthAdapter<AccountOptions = unknown, Credential = unknown> = {
  readonly id: string;
  readonly label: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: OAuthIcon;
  readonly account: { readonly options: ConfigSpec<AccountOptions> };
  readonly credentials: ZodType<Credential>;
  readonly login: (context: OAuthLoginContext, options: AccountOptions) => Promise<OAuthLoginResult<Credential>>;
  readonly catalog: {
    readonly policy: { readonly kind: "static" } | { readonly kind: "ttl"; readonly ttlMs: number };
    readonly discover: (context: AccountContext<Credential, AccountOptions>) => Promise<ModelCatalog>;
  };
  readonly createRuntime: (context: RuntimeContext<Credential, AccountOptions>) => Promise<OAuthRuntimeResult>;
};
