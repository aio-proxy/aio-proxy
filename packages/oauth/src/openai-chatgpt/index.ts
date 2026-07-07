import {
  BaseOAuthProvider,
  type OAuthLoginCallbacks,
  type OAuthLoginForm,
  type OAuthLoginInput,
  type OAuthProviderLoginResult,
  type OAuthProviderModel,
} from "../oauth-provider";
import { createLoopbackServer } from "./loopback";
import { type ChatGPTTokenResult, exchangeCodeForTokens } from "./oauth-flow";
import { generatePKCE, generateState } from "./pkce";
import type { ChatGPTPayload } from "./schema";

type OpenAIChatGPTDeps = {
  readonly createLoopbackServer: typeof createLoopbackServer;
  readonly exchangeCodeForTokens: typeof exchangeCodeForTokens;
  readonly generatePKCE: typeof generatePKCE;
  readonly generateState: typeof generateState;
};

export const OPENAI_CHATGPT_MODELS = [
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.4", displayName: "GPT-5.4" },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini" },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark" },
] as const satisfies readonly OAuthProviderModel[];

const CHATGPT_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/oauth/authorize" as const;
const CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann" as const;
const CHATGPT_SCOPE = "openid profile email offline_access" as const;
const CHATGPT_ORIGINATOR = "codex_cli_rs" as const;
const CHATGPT_LOGIN_LABEL = "Login with ChatGPT (Plus/Pro)" as const;

export class OpenAIChatGPTOAuthProvider extends BaseOAuthProvider<ChatGPTPayload> {
  readonly loginForm: OAuthLoginForm = {
    type: "oauth",
    label: CHATGPT_LOGIN_LABEL,
    prompts: [],
  } as const;

  constructor(
    private readonly deps: OpenAIChatGPTDeps = {
      createLoopbackServer,
      exchangeCodeForTokens,
      generatePKCE,
      generateState,
    },
  ) {
    super("openai-chatgpt", "chatgpt");
  }

  async login(
    _input: OAuthLoginInput,
    callbacks: OAuthLoginCallbacks,
  ): Promise<OAuthProviderLoginResult<ChatGPTPayload>> {
    const pkce = await this.deps.generatePKCE();
    const state = this.deps.generateState();
    const loopback = this.deps.createLoopbackServer(state);

    try {
      const authUrl = new URL(CHATGPT_AUTHORIZATION_ENDPOINT);
      authUrl.searchParams.set("client_id", CHATGPT_CLIENT_ID);
      authUrl.searchParams.set("code_challenge", pkce.challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("codex_cli_simplified_flow", "true");
      authUrl.searchParams.set("id_token_add_organizations", "true");
      authUrl.searchParams.set("originator", CHATGPT_ORIGINATOR);
      authUrl.searchParams.set("redirect_uri", loopback.redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("scope", CHATGPT_SCOPE);
      authUrl.searchParams.set("state", state);

      callbacks.onAuth({ url: authUrl.toString() });

      const { code } = await loopback.waitForCode(callbacks.signal);
      const token = await this.deps.exchangeCodeForTokens(code, pkce.verifier, {
        redirectUri: loopback.redirectUri,
        ...(callbacks.signal === undefined ? {} : { signal: callbacks.signal }),
      });
      return this.finishLogin(token);
    } finally {
      loopback.close();
    }
  }

  async models(_payload: ChatGPTPayload, _signal?: AbortSignal): Promise<readonly OAuthProviderModel[]> {
    return OPENAI_CHATGPT_MODELS;
  }

  private finishLogin(token: ChatGPTTokenResult): OAuthProviderLoginResult<ChatGPTPayload> {
    const payload: ChatGPTPayload = {
      access: token.access,
      accountId: token.accountId,
      expires: token.expires,
      models: OPENAI_CHATGPT_MODELS,
      refresh: token.refresh,
    };
    const providerId = this.providerId(token.accountId);
    this.store(providerId, payload, token.accountId);

    return {
      accountLabel: token.accountId,
      payload,
      providerId,
      status: "authenticated",
      userId: token.accountId,
    };
  }
}

export const openAIChatGPTOAuthProvider = new OpenAIChatGPTOAuthProvider();
