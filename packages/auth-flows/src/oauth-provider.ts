import { Auth } from "./store";

export type OAuthLoginCallbacks = {
  readonly onAuth: (info: { readonly url: string; readonly instructions?: string }) => void;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
};

export type OAuthPromptWhen = {
  readonly key: string;
  readonly op: "eq";
  readonly value: string;
};

export type OAuthPromptValidation = {
  readonly required?: boolean;
  readonly format?: "domain-or-url";
};

export type OAuthSelectPrompt = {
  readonly type: "select";
  readonly key: string;
  readonly message: string;
  readonly options: readonly {
    readonly label: string;
    readonly value: string;
    readonly hint?: string;
  }[];
  readonly when?: OAuthPromptWhen;
};

export type OAuthTextPrompt = {
  readonly type: "text";
  readonly key: string;
  readonly message: string;
  readonly placeholder?: string;
  readonly validate?: OAuthPromptValidation;
  readonly when?: OAuthPromptWhen;
};

export type OAuthPrompt = OAuthSelectPrompt | OAuthTextPrompt;

export type OAuthLoginForm = {
  readonly type: "oauth";
  readonly label: string;
  readonly prompts: readonly OAuthPrompt[];
};

export type OAuthLoginInput = Record<string, string | undefined> & {
  readonly deploymentType?: string;
  readonly enterpriseUrl?: string;
};

export type OAuthLoginPayload = {
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
};

export type OAuthProviderLoginResult<TPayload extends OAuthLoginPayload = OAuthLoginPayload> = {
  readonly accountLabel?: string;
  readonly payload: TPayload;
  readonly providerId: string;
  readonly status: "authenticated";
  readonly userId: string;
};

export abstract class BaseOAuthProvider<TPayload extends OAuthLoginPayload = OAuthLoginPayload> {
  abstract readonly loginForm: OAuthLoginForm;

  protected constructor(
    readonly vendor: string,
    private readonly prefix: string,
  ) {}

  protected providerId(userId: string): string {
    return `${this.prefix}-${userId}`;
  }

  protected store(providerId: string, payload: TPayload, accountLabel?: string): void {
    Auth.set(this.vendor, providerId, { ...payload, accountLabel }, providerId);
  }

  abstract login(input: OAuthLoginInput, callbacks: OAuthLoginCallbacks): Promise<OAuthProviderLoginResult<TPayload>>;
}
