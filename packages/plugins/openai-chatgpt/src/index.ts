import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import { CHATGPT_CLIENT_ID, exchangeCodeForTokens } from "./oauth-flow";
import { generatePKCE, generateState } from "./pkce";
import { createOpenAIChatGPTRuntime } from "./runtime";
import type { ChatGPTCredential } from "./schema";

export type { ChatGPTCredential } from "./schema";

export const OPENAI_CHATGPT_PLUGIN_VERSION = packageJson.version;

export const OPENAI_CHATGPT_MODELS = [
  { id: "gpt-5.5", displayName: "GPT-5.5" },
  { id: "gpt-5.4", displayName: "GPT-5.4" },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini" },
  { id: "gpt-5.3-codex-spark", displayName: "GPT-5.3 Codex Spark" },
] as const;

const CHATGPT_AUTHORIZATION_ENDPOINT = "https://auth.openai.com/oauth/authorize" as const;
const CHATGPT_SCOPE = "openid profile email offline_access" as const;
const CHATGPT_ORIGINATOR = "codex_cli_rs" as const;

export type OpenAIChatGPTCopy = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
};

export const englishCopy: OpenAIChatGPTCopy = {
  pluginLabel: "OpenAI ChatGPT",
  pluginDescription: "Use a ChatGPT Plus or Pro account to access models",
  adapterLabel: "Login with ChatGPT (Plus/Pro)",
};

export function createOpenAIChatGPTPlugin(copy: OpenAIChatGPTCopy): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;

  const adapter: OAuthAdapter<Record<string, never>, ChatGPTCredential> = {
    id: "default",
    label: copy.adapterLabel,
    account: { options: accountOptions },
    credentials: zod.object({
      accessToken: zod.string(),
      accountId: zod.string(),
      expiresAt: zod.number(),
      refreshToken: zod.string(),
    }),
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      const pkce = await generatePKCE();
      const state = generateState();
      const { code, redirectUri } = await context.authorization.loopback({
        state,
        redirect: {
          hostname: "localhost",
          port: 1455,
          path: "/auth/callback",
        },
        authorizationUrl: ({ redirectUri: selectedRedirectUri }) =>
          buildAuthorizationUrl({ challenge: pkce.challenge, redirectUri: selectedRedirectUri, state }),
        allowManualCallbackUrl: true,
      });
      const token = await exchangeCodeForTokens(code, pkce.verifier, { redirectUri, signal: context.signal });
      return {
        fingerprint: token.accountId,
        suggestedKey: `chatgpt-${token.accountId}`,
        label: token.accountId,
        credentials: token,
        expiresAt: token.expiresAt,
      };
    },
    catalog: {
      policy: { kind: "static" },
      discover: async () => ({
        language: OPENAI_CHATGPT_MODELS,
        image: [],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      }),
    },
    createRuntime: createOpenAIChatGPTRuntime,
  };

  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      label: copy.pluginLabel ?? "OpenAI ChatGPT",
      description: copy.pluginDescription ?? "Use a ChatGPT Plus or Pro account to access models",
    },
  );
}

function buildAuthorizationUrl(input: {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const authUrl = new URL(CHATGPT_AUTHORIZATION_ENDPOINT);
  authUrl.searchParams.set("client_id", CHATGPT_CLIENT_ID);
  authUrl.searchParams.set("code_challenge", input.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("codex_cli_simplified_flow", "true");
  authUrl.searchParams.set("id_token_add_organizations", "true");
  authUrl.searchParams.set("originator", CHATGPT_ORIGINATOR);
  authUrl.searchParams.set("redirect_uri", input.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", CHATGPT_SCOPE);
  authUrl.searchParams.set("state", input.state);
  return authUrl.toString();
}

export default createOpenAIChatGPTPlugin(englishCopy);
